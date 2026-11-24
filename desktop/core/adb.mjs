// Cross-platform USB ADB manager (macOS / Windows / Linux).
// Automatically locates adb, watches connected Android devices, sets up
// `adb reverse tcp:<port> tcp:<port>`, and provides APK install & launch helpers.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const APP_PACKAGE = 'com.foldstage.app';
export const APP_ACTIVITY = 'com.foldstage.app/.MainActivity';

export function findAdbBinary(projectRoot) {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'adb.exe' : 'adb';
  const candidates = [];

  if (process.env.ADB_PATH) candidates.push(process.env.ADB_PATH);
  if (projectRoot) {
    candidates.push(path.join(projectRoot, 'platform-tools', exe));
    candidates.push(path.join(projectRoot, 'desktop', 'platform-tools', exe));
  }
  if (process.env.ANDROID_HOME) {
    candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', exe));
  }
  if (process.env.ANDROID_SDK_ROOT) {
    candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe));
  }

  if (isWin) {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localApp, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
    candidates.push('C:\\platform-tools\\adb.exe');
    candidates.push('C:\\Android\\platform-tools\\adb.exe');
  } else {
    candidates.push('/opt/homebrew/bin/adb');
    candidates.push('/usr/local/bin/adb');
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'));
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'));
    candidates.push('/usr/bin/adb');
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Fallback: rely on PATH
  return exe;
}

export class AdbManager {
  constructor({ port = 8772, projectRoot = null, onUpdate = null } = {}) {
    this.port = port;
    this.projectRoot = projectRoot;
    this.adbPath = findAdbBinary(projectRoot);
    this.onUpdate = onUpdate;
    this.devices = []; // [{ serial, state, model, manufacturer, reversed, appInstalled }]
    this.reversed = new Set();
    this.adbAvailable = false;
    this.lastError = '';
    this.timer = null;
    this.busy = false;
  }

  async _run(args, timeout = 8000) {
    const { stdout } = await execFileAsync(this.adbPath, args, {
      timeout,
      windowsHide: true
    });
    return String(stdout || '');
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 2500);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const out = await this._run(['devices', '-l'], 5000);
      this.adbAvailable = true;
      this.lastError = '';
      const lines = out
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean);

      const seen = new Set();
      const next = [];
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const serial = parts[0];
        const state = parts[1];
        seen.add(serial);

        const prev = this.devices.find((d) => d.serial === serial);
        let model = prev?.model || '';
        const mMatch = line.match(/model:([^\s]+)/);
        if (mMatch) model = mMatch[1].replace(/_/g, ' ');
        let manufacturer = prev?.manufacturer || '';
        let appInstalled = prev?.appInstalled ?? false;
        let reversed = this.reversed.has(serial);

        if (state === 'device') {
          if (!reversed) {
            try {
              await this._run(['-s', serial, 'reverse', `tcp:${this.port}`, `tcp:${this.port}`], 5000);
              this.reversed.add(serial);
              reversed = true;
            } catch (e) {
              this.lastError = `adb reverse failed: ${e.message}`;
            }
          }
          if (!prev || prev.state !== 'device' || !model) {
            try {
              const propModel = (await this._run(['-s', serial, 'shell', 'getprop', 'ro.product.model'], 4000)).trim();
              if (propModel) model = propModel;
              manufacturer = (await this._run(['-s', serial, 'shell', 'getprop', 'ro.product.manufacturer'], 4000)).trim();
            } catch {}
          }
          try {
            const pkgOut = await this._run(['-s', serial, 'shell', 'pm', 'path', APP_PACKAGE], 4000);
            appInstalled = pkgOut.includes('package:');
          } catch {}
        } else {
          this.reversed.delete(serial);
          reversed = false;
        }

        next.push({ serial, state, model: model || serial, manufacturer, reversed, appInstalled });
      }

      for (const s of [...this.reversed]) {
        if (!seen.has(s)) this.reversed.delete(s);
      }

      const changed = JSON.stringify(next) !== JSON.stringify(this.devices);
      this.devices = next;
      if (changed && this.onUpdate) this.onUpdate(this.getStatus());
    } catch (e) {
      this.adbAvailable = false;
      this.lastError = e.code === 'ENOENT'
        ? 'ADB not found. Install Android Platform-Tools or set ADB_PATH.'
        : String(e.message || e);
      if (this.devices.length) {
        this.devices = [];
        this.reversed.clear();
        if (this.onUpdate) this.onUpdate(this.getStatus());
      }
    } finally {
      this.busy = false;
    }
  }

  findApkPath() {
    if (!this.projectRoot) return null;
    const candidates = [
      path.join(this.projectRoot, 'android', 'out', 'foldstage.apk'),
      path.join(this.projectRoot, 'dist', 'foldstage.apk'),
      path.join(this.projectRoot, 'foldstage.apk')
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  getStatus() {
    const apkPath = this.findApkPath();
    return {
      adbAvailable: this.adbAvailable,
      adbPath: this.adbPath,
      port: this.port,
      apkAvailable: Boolean(apkPath),
      apkPath,
      devices: this.devices,
      lastError: this.lastError
    };
  }

  _pickSerial(serial) {
    if (serial) return serial;
    const ready = this.devices.find((d) => d.state === 'device');
    if (!ready) throw new Error('No authorized Android device connected via USB');
    return ready.serial;
  }

  async installApk(serial, customApkPath = null) {
    const s = this._pickSerial(serial);
    const apk = customApkPath || this.findApkPath();
    if (!apk || !fs.existsSync(apk)) {
      throw new Error('foldstage.apk not found. Build the Android APK first (see README).');
    }
    const out = await this._run(['-s', s, 'install', '-r', apk], 90000);
    await this._run(['-s', s, 'reverse', `tcp:${this.port}`, `tcp:${this.port}`], 5000);
    this.reversed.add(s);
    await this.poll();
    return { ok: true, serial: s, output: out.trim() };
  }

  async launchApp(serial) {
    const s = this._pickSerial(serial);
    await this._run(['-s', s, 'reverse', `tcp:${this.port}`, `tcp:${this.port}`], 5000);
    this.reversed.add(s);
    const out = await this._run(['-s', s, 'shell', 'am', 'start', '-n', APP_ACTIVITY], 10000);
    return { ok: true, serial: s, output: out.trim() };
  }
}
