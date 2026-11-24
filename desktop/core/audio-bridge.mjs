// Unified cross-platform Audio & Now-Playing Bridge.
// Spawns the platform-native helper:
//   - macOS:   desktop/native/macos/build/foldstage-audio-mac
//   - Windows: desktop/native/windows/publish/foldstage-audio-win.exe
// Reads mono Float32 PCM from helper stdout -> feeds BeatAnalyzer DSP,
// reads JSON metadata events from helper stderr -> emits 4 Hz music packets.
// Also provides a built-in 128 BPM Demo Beat mode for testing without an audio player.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { BeatAnalyzer } from './beat-dsp.mjs';

const execFileAsync = promisify(execFile);

export function findAudioHelper(projectRoot) {
  if (process.env.FOLDSTAGE_AUDIO_HELPER && fs.existsSync(process.env.FOLDSTAGE_AUDIO_HELPER)) {
    return process.env.FOLDSTAGE_AUDIO_HELPER;
  }
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const candidates = [];
  if (isMac) {
    candidates.push(path.join(projectRoot, 'desktop', 'native', 'macos', 'build', 'foldstage-audio-mac'));
    candidates.push(path.join(projectRoot, 'desktop', 'native', 'macos', 'FoldStage Companion.app', 'Contents', 'Resources', 'foldstage-audio-mac'));
  } else if (isWin) {
    candidates.push(path.join(projectRoot, 'desktop', 'native', 'windows', 'publish', 'foldstage-audio-win.exe'));
    candidates.push(path.join(projectRoot, 'desktop', 'native', 'windows', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'win-x64', 'publish', 'foldstage-audio-win.exe'));
    candidates.push(path.join(projectRoot, 'desktop', 'native', 'windows', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'foldstage-audio-win.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export class AudioBridge {
  constructor({ projectRoot, onMusic, onStatus }) {
    this.projectRoot = projectRoot;
    this.onMusic = onMusic;
    this.onStatus = onStatus;
    this.helperPath = findAudioHelper(projectRoot);
    this.analyzer = new BeatAnalyzer();

    this.proc = null;
    this.target = null; // { id: 'all' | bundleId | exe, name: '...' }
    this.sampleRate = 48000;
    this.outLatencyMs = 0;
    this.helperState = 'idle'; // idle | running | error | demo
    this.helperMessage = '';

    this.nowPlaying = {};
    this.art = null;
    this.artKey = '';
    this.artPending = false;
    this.lastTrack = '';
    this.trackSince = 0;
    this.lastAudible = 0;
    this.sentStop = 0;
    this.pcmRemainder = Buffer.alloc(0);

    this.demoMode = false;
    this.demoBpm = 128;
    this.demoStartMs = 0;

    this.tickTimer = setInterval(() => this._tick(), 250);
    this.tickTimer.unref?.();
  }

  async listApps() {
    this.helperPath = findAudioHelper(this.projectRoot);
    const base = [{
      id: 'all',
      name: 'All System Audio',
      subtitle: process.platform === 'darwin' ? 'macOS Global Mixdown' : 'Windows Default Output Loopback',
      isAudioActive: true,
      isPlayerLikely: true
    }];
    if (!this.helperPath) {
      return {
        helperAvailable: false,
        platform: process.platform,
        apps: base,
        error: process.platform === 'darwin'
          ? 'macOS audio helper not compiled yet. Run desktop/native/macos/build.sh.'
          : process.platform === 'win32'
            ? 'Windows audio helper not compiled yet. Run desktop/native/windows/build.ps1.'
            : 'Audio capture helper is available on macOS and Windows (use POST /v1/music or Demo Mode on Linux).'
      };
    }
    try {
      const { stdout } = await execFileAsync(this.helperPath, ['--list-apps'], {
        timeout: 8000,
        windowsHide: true
      });
      const parsed = JSON.parse(String(stdout || '[]'));
      const apps = Array.isArray(parsed) ? parsed : [];
      return {
        helperAvailable: true,
        platform: process.platform,
        apps: [...base, ...apps]
      };
    } catch (e) {
      return {
        helperAvailable: true,
        platform: process.platform,
        apps: base,
        error: String(e.message || e)
      };
    }
  }

  startCapture(targetId, targetName = '') {
    this.stop();
    this.demoMode = false;
    this.helperPath = findAudioHelper(this.projectRoot);
    if (!this.helperPath) {
      this.helperState = 'error';
      this.helperMessage = 'Native audio helper binary not found.';
      this._emitStatus();
      return { ok: false, error: this.helperMessage };
    }
    this.target = { id: targetId || 'all', name: targetName || targetId || 'All System Audio' };
    this.analyzer = new BeatAnalyzer();
    this.nowPlaying = {};
    this.art = null;
    this.artKey = '';
    this.lastTrack = '';
    this.pcmRemainder = Buffer.alloc(0);

    const args = ['--capture', this.target.id];
    const child = spawn(this.helperPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = child;
    this.helperState = 'running';
    this.helperMessage = `Capturing: ${this.target.name}`;
    this._emitStatus();

    child.stdout.on('data', (chunk) => {
      const combined = this.pcmRemainder.length ? Buffer.concat([this.pcmRemainder, chunk]) : chunk;
      const validBytes = combined.length - (combined.length % 4);
      this.pcmRemainder = validBytes < combined.length ? combined.subarray(validBytes) : Buffer.alloc(0);
      if (validBytes < 4) return;

      const count = validBytes / 4;
      const mono = new Float32Array(count);
      for (let i = 0; i < count; i++) mono[i] = combined.readFloatLE(i * 4);
      const nowSec = Date.now() / 1000 - count / this.sampleRate;
      this.analyzer.feed(mono, nowSec, this.sampleRate);
    });

    let errBuf = '';
    child.stderr.on('data', (d) => {
      errBuf += d.toString('utf8');
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (!line) continue;
        this._handleHelperLine(line);
      }
    });

    child.on('exit', (code) => {
      if (this.proc === child) {
        this.proc = null;
        if (this.helperState === 'running') {
          this.helperState = code === 0 ? 'idle' : 'error';
          this.helperMessage = code === 0 ? 'Capture stopped' : `Audio helper exited (${code})`;
          this._emitStatus();
        }
      }
    });

    return { ok: true, target: this.target };
  }

  startDemo(bpm = 128) {
    this.stop();
    this.demoMode = true;
    this.demoBpm = Math.max(60, Math.min(200, Number(bpm) || 128));
    this.demoStartMs = Date.now();
    this.target = { id: 'demo', name: `Demo Beat (${this.demoBpm} BPM)` };
    this.helperState = 'demo';
    this.helperMessage = `Demo beat generator running at ${this.demoBpm} BPM`;
    this._emitStatus();
    return { ok: true, bpm: this.demoBpm };
  }

  stop() {
    this.demoMode = false;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try { p.kill('SIGTERM'); } catch {}
    }
    this.helperState = 'idle';
    this.helperMessage = 'Stopped';
    this.analyzer.clearSilence();
    this._emitStatus();
  }

  _handleHelperLine(line) {
    if (!line.startsWith('{')) {
      this.helperMessage = line;
      this._emitStatus();
      return;
    }
    try {
      const msg = JSON.parse(line);
      if (msg.event === 'stream') {
        if (msg.sampleRate > 0) {
          this.sampleRate = msg.sampleRate;
          this.analyzer.setSampleRate(msg.sampleRate);
        }
        if (typeof msg.outLatencyMs === 'number') this.outLatencyMs = msg.outLatencyMs;
      } else if (msg.event === 'nowplaying') {
        if (msg.title) {
          const prevKey = `${this.nowPlaying.title || ''}\u0001${this.nowPlaying.artist || ''}`;
          const nextKey = `${msg.title}\u0001${msg.artist || ''}`;
          this.nowPlaying = {
            title: msg.title || '',
            artist: msg.artist || '',
            album: msg.album || '',
            duration: Number(msg.duration) || 0,
            elapsed: Number(msg.elapsed) || 0,
            playbackRate: Number(msg.playbackRate ?? 1),
            timestamp: Number(msg.timestamp) || Date.now() / 1000
          };
          if (msg.art) {
            this.art = msg.art;
            this.artKey = nextKey;
            this.artPending = true;
          } else if (prevKey !== nextKey) {
            this.art = null;
            this.artKey = nextKey;
          }
        }
      } else if (msg.event === 'status') {
        this.helperMessage = msg.message || '';
        if (msg.error) this.helperState = 'error';
        this._emitStatus();
      }
    } catch {}
  }

  _tick() {
    const nowMs = Date.now();
    const nowSec = nowMs / 1000;

    if (this.demoMode) {
      const periodMs = 60000 / this.demoBpm;
      const elapsed = ((nowMs - this.demoStartMs) / 1000) % 180;
      const phase = ((nowMs - this.demoStartMs) % periodMs) / periodMs;
      const energy = 0.45 + 0.45 * Math.exp(-phase * 5);
      this.onMusic?.({
        type: 'music',
        playing: true,
        title: 'FoldStage Demo Track',
        artist: `${this.demoBpm} BPM Live Test`,
        album: 'Studio Generator',
        duration: 180,
        elapsed,
        trackSince: this.demoStartMs,
        bpm: this.demoBpm,
        periodMs,
        beatRef: this.demoStartMs,
        downbeatRef: this.demoStartMs,
        conf: 0.99,
        energy,
        outLatencyMs: 0,
        sentAt: nowMs
      });
      return;
    }

    if (!this.proc) return;
    const snap = this.analyzer.snapshot();
    if (snap.audible) this.lastAudible = nowSec;
    const playing = nowSec - this.lastAudible < 1.5;

    if (!playing) {
      if (this.sentStop >= 3) return;
      this.sentStop++;
    } else {
      this.sentStop = 0;
    }

    const np = this.nowPlaying;
    const title = np.title || (this.target?.name || 'System Audio');
    const artist = np.artist || (this.target?.id === 'all' ? 'All System Audio' : this.target?.name || '');
    const trackKey = `${title}\u0001${artist}`;
    if (playing && trackKey !== this.lastTrack) {
      this.lastTrack = trackKey;
      this.trackSince = nowMs;
      this.analyzer.resetBeat(nowSec);
    }

    let elapsed = Number(np.elapsed) || 0;
    if (playing && np.timestamp > 0) {
      const rate = np.playbackRate > 0 ? np.playbackRate : 1;
      elapsed += Math.max(0, nowSec - np.timestamp) * rate;
    }

    const pkt = {
      type: 'music',
      playing,
      title,
      artist,
      album: np.album || '',
      duration: Number(np.duration) || 0,
      elapsed,
      trackSince: this.trackSince || nowMs,
      bpm: snap.bpm,
      periodMs: snap.periodMs,
      beatRef: snap.beatRef,
      downbeatRef: snap.downbeatRef,
      conf: snap.conf,
      energy: snap.energy,
      outLatencyMs: this.outLatencyMs,
      sentAt: nowMs
    };
    if (this.artPending && this.art) {
      pkt.art = this.art;
      this.artPending = false;
    }
    this.onMusic?.(pkt);
  }

  getStatus() {
    const snap = this.demoMode
      ? { bpm: this.demoBpm, conf: 0.99, energy: 0.7, audible: true }
      : this.analyzer.snapshot();
    return {
      helperAvailable: Boolean(this.helperPath),
      helperPath: this.helperPath,
      state: this.helperState,
      message: this.helperMessage,
      target: this.target,
      demoMode: this.demoMode,
      demoBpm: this.demoBpm,
      sampleRate: this.sampleRate,
      outLatencyMs: this.outLatencyMs,
      bpm: snap.bpm,
      conf: snap.conf,
      energy: snap.energy,
      audible: snap.audible,
      nowPlaying: this.nowPlaying
    };
  }

  _emitStatus() {
    this.onStatus?.(this.getStatus());
  }
}
