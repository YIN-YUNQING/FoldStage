// FoldStage Companion Core Server (macOS / Windows / Linux).
// Runs on 127.0.0.1:8772 (tunneled to Android via `adb reverse tcp:8772 tcp:8772`).
// Serves:
//   - Desktop Studio GUI (GET /)
//   - Studio control API (/api/*)
//   - Open USB Phone API (/v1/events, /v1/music, /v1/models, /v1/models/:id/*, /v1/device-status)
//   - Desktop browser live stage preview (/preview/*)

import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdbManager } from './adb.mjs';
import { AudioBridge } from './audio-bridge.mjs';
import {
  deleteModel,
  importModelZip,
  listModels,
  resolveModelFilePath,
  updateModel
} from './importer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  moc3: 'application/octet-stream',
  task: 'application/octet-stream'
};

function mimeOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function readBody(req, maxBytes = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, cors = false) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (cors) headers['access-control-allow-origin'] = '*';
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function sendFile(res, filePath, cors = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const headers = {
    'content-type': mimeOf(filePath),
    'content-length': fs.statSync(filePath).size,
    'cache-control': 'no-store'
  };
  if (cors) headers['access-control-allow-origin'] = '*';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function isLoopbackAddr(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function getLanInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      // Compute subnet broadcast address from ip + netmask
      let bcast = '255.255.255.255';
      try {
        const ip = info.address.split('.').map(Number);
        const mask = info.netmask.split('.').map(Number);
        bcast = ip.map((v, i) => (v | (~mask[i] & 255))).join('.');
      } catch {}
      out.push({ name, address: info.address, broadcast: bcast });
    }
  }
  // Prefer RFC1918 LAN addresses (192.168.*, 10.*, 172.16-31.*) over Tailscale/VPN 100.64.*
  out.sort((a, b) => {
    const score = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
    return score(a.address) - score(b.address);
  });
  return out;
}

export function createCompanionServer({ port = Number(process.env.FOLDSTAGE_PORT || 8772), projectRoot = PROJECT_ROOT } = {}) {
  const phoneClients = new Set();
  const studioClients = new Set();
  const udpPort = port + 1; // UDP discovery beacon on 8773
  let udpSock = null;
  let udpTimer = null;

  let latestMusic = null;
  let latestMusicAt = 0;
  let latestArt = null;
  let latestArtKey = '';
  let phoneSyncStatus = { state: 'idle', message: '', syncedModels: 0, totalModels: 0, deviceModel: '', updatedAt: 0 };

  const sseWrite = (res, obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  const broadcastPhone = (obj) => {
    for (const res of phoneClients) sseWrite(res, obj);
  };
  const broadcastStudio = (obj) => {
    for (const res of studioClients) sseWrite(res, obj);
  };

  const adb = new AdbManager({
    port,
    projectRoot,
    onUpdate: (st) => broadcastStudio({ type: 'adb', adb: st })
  });

  const handleMusicPacket = (pkt) => {
    if (!pkt || typeof pkt !== 'object') return;
    const art = typeof pkt.art === 'string' && pkt.art.length < 900000 ? pkt.art : null;
    const clean = { ...pkt };
    delete clean.art;
    const key = `${clean.title || ''}\u0001${clean.artist || ''}`;
    if (art) {
      latestArt = art;
      latestArtKey = key;
    }
    latestMusic = { ...clean, type: 'music', at: Date.now() };
    latestMusicAt = Date.now();
    const out = art ? { ...latestMusic, art } : latestMusic;
    broadcastPhone(out);
    broadcastStudio({ type: 'music', music: out });
  };

  const audio = new AudioBridge({
    projectRoot,
    onMusic: handleMusicPacket,
    onStatus: (st) => broadcastStudio({ type: 'audio', audio: st })
  });

  const getFullStatus = () => {
    const lanIfaces = getLanInterfaces();
    return {
      version: '1.0.0',
      platform: process.platform,
      port,
      lanUrls: lanIfaces.map((x) => `http://${x.address}:${port}`),
      phoneClients: phoneClients.size,
      adb: adb.getStatus(),
      audio: audio.getStatus(),
      models: listModels(),
      phoneSync: phoneSyncStatus,
      music: latestMusic && Date.now() - latestMusicAt < 5000 ? latestMusic : null
    };
  };

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = urlObj.pathname;

    // CORS preflight for local phone WebView & external third-party scripts
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-filename'
      });
      res.end();
      return;
    }

    try {
      // ---- Studio GUI ----
      if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
        return sendFile(res, path.join(projectRoot, 'desktop', 'ui', 'index.html'));
      }

      // ---- Desktop browser preview of Web Hologram Stage ----
      if (req.method === 'GET' && (route === '/preview' || route === '/preview/')) {
        return sendFile(res, path.join(projectRoot, 'web', 'index.html'));
      }
      if (req.method === 'GET' && route.startsWith('/preview/')) {
        const rel = decodeURIComponent(route.slice('/preview/'.length));
        const target = path.normalize(path.join(projectRoot, 'web', rel));
        if (!target.startsWith(path.join(projectRoot, 'web') + path.sep)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        return sendFile(res, target);
      }

      // ---- Open USB Phone API (/v1/*) ----
      if (req.method === 'GET' && route === '/v1/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*'
        });
        phoneClients.add(res);
        req.on('close', () => {
          phoneClients.delete(res);
          broadcastStudio({ type: 'phone_count', phoneClients: phoneClients.size });
        });
        sseWrite(res, { type: 'hello', server: 'foldstage-companion', version: '1.0.0', modelsCount: listModels().length });
        if (latestMusic && Date.now() - latestMusicAt < 5000) {
          const curKey = `${latestMusic.title || ''}\u0001${latestMusic.artist || ''}`;
          sseWrite(res, latestArt && latestArtKey === curKey ? { ...latestMusic, art: latestArt } : latestMusic);
        }
        broadcastStudio({ type: 'phone_count', phoneClients: phoneClients.size });
        return;
      }

      if (req.method === 'GET' && route === '/v1/music') {
        if (latestMusic && Date.now() - latestMusicAt < 5000) {
          const curKey = `${latestMusic.title || ''}\u0001${latestMusic.artist || ''}`;
          return sendJson(res, 200, latestArt && latestArtKey === curKey ? { ...latestMusic, art: latestArt } : latestMusic, true);
        }
        return sendJson(res, 200, { playing: false }, true);
      }

      // Open music ingestion endpoint (lets any external script / Windows / Linux tool push music beats)
      if (req.method === 'POST' && route === '/v1/music') {
        const raw = await readBody(req, 2 * 1024 * 1024);
        const pkt = JSON.parse(raw.toString('utf8'));
        handleMusicPacket(pkt);
        return sendJson(res, 202, { ok: true }, true);
      }

      if (req.method === 'GET' && route === '/v1/models') {
        return sendJson(res, 200, { models: listModels() }, true);
      }

      if (req.method === 'GET' && route.startsWith('/v1/models/')) {
        const rest = route.slice('/v1/models/'.length);
        const slash = rest.indexOf('/');
        if (slash < 0) return sendJson(res, 404, { error: 'Not found' }, true);
        const id = decodeURIComponent(rest.slice(0, slash));
        const rel = decodeURIComponent(rest.slice(slash + 1));
        const filePath = resolveModelFilePath(id, rel);
        if (!filePath) return sendJson(res, 404, { error: 'File not found' }, true);
        return sendFile(res, filePath, true);
      }

      if (req.method === 'POST' && route === '/v1/device-status') {
        const raw = await readBody(req, 64 * 1024);
        const st = JSON.parse(raw.toString('utf8'));
        phoneSyncStatus = { ...phoneSyncStatus, ...st, updatedAt: Date.now() };
        broadcastStudio({ type: 'phone_sync', phoneSync: phoneSyncStatus });
        return sendJson(res, 200, { ok: true }, true);
      }

      // ---- Direct APK download over LAN Wi-Fi ----
      if (req.method === 'GET' && route === '/download/foldstage.apk') {
        const apk = adb.findApkPath();
        if (!apk) return sendJson(res, 404, { error: 'foldstage.apk not built yet' }, true);
        res.writeHead(200, {
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': 'attachment; filename="foldstage.apk"',
          'content-length': fs.statSync(apk).size,
          'cache-control': 'no-store'
        });
        fs.createReadStream(apk).pipe(res);
        return;
      }

      // ---- Studio GUI Control API (/api/* — restricted to localhost only for LAN safety) ----
      if (route.startsWith('/api/') && !isLoopbackAddr(req.socket.remoteAddress)) {
        return sendJson(res, 403, { error: 'Studio API is restricted to localhost' });
      }
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive'
        });
        studioClients.add(res);
        req.on('close', () => studioClients.delete(res));
        sseWrite(res, { type: 'snapshot', ...getFullStatus() });
        return;
      }

      if (req.method === 'GET' && route === '/api/status') {
        return sendJson(res, 200, getFullStatus());
      }

      if (req.method === 'GET' && route === '/api/apps') {
        const result = await audio.listApps();
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && route === '/api/capture') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        const result = audio.startCapture(body.id || 'all', body.name || body.id || 'All System Audio');
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && route === '/api/capture/stop') {
        audio.stop();
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/demo') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        if (body.enabled === false) {
          audio.stop();
          return sendJson(res, 200, { ok: true, demoMode: false });
        }
        const result = audio.startDemo(body.bpm || 128);
        return sendJson(res, 200, result);
      }

      if (req.method === 'GET' && route === '/api/models') {
        return sendJson(res, 200, { models: listModels() });
      }

      if (req.method === 'POST' && route === '/api/models/import') {
        const raw = await readBody(req, 256 * 1024 * 1024);
        const filename = decodeURIComponent(req.headers['x-filename'] || urlObj.searchParams.get('filename') || 'model.zip');
        const customName = urlObj.searchParams.get('name') || undefined;
        const record = importModelZip(raw, filename, { name: customName });
        const models = listModels();
        broadcastStudio({ type: 'models', models });
        broadcastPhone({ type: 'models_changed', count: models.length, at: Date.now() });
        return sendJson(res, 200, { ok: true, model: record, models });
      }

      if (route.startsWith('/api/models/') && route !== '/api/models/import') {
        const id = decodeURIComponent(route.slice('/api/models/'.length));
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
          const model = updateModel(id, patch);
          const models = listModels();
          broadcastStudio({ type: 'models', models });
          broadcastPhone({ type: 'models_changed', count: models.length, at: Date.now() });
          return sendJson(res, 200, { ok: true, model, models });
        }
        if (req.method === 'DELETE') {
          const ok = deleteModel(id);
          const models = listModels();
          broadcastStudio({ type: 'models', models });
          broadcastPhone({ type: 'models_changed', count: models.length, at: Date.now() });
          return sendJson(res, ok ? 200 : 404, { ok, models });
        }
      }

      if (req.method === 'POST' && route === '/api/adb/install') {
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
        const result = await adb.installApk(body.serial);
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && route === '/api/adb/launch') {
        const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}');
        const result = await adb.launchApp(body.serial);
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && route === '/api/adb/sync') {
        await adb.poll();
        broadcastPhone({ type: 'models_changed', force: true, count: listModels().length, at: Date.now() });
        return sendJson(res, 200, { ok: true, phoneClients: phoneClients.size });
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message || err) }, route.startsWith('/v1/'));
    }
  });

  // Periodic SSE heartbeat
  const hb = setInterval(() => {
    for (const res of phoneClients) { try { res.write(': beat\n\n'); } catch {} }
    for (const res of studioClients) { try { res.write(': beat\n\n'); } catch {} }
  }, 15000);
  hb.unref?.();

  return {
    server,
    adb,
    audio,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          adb.start();
          // Start UDP LAN discovery beacon (port 8773) so phones on the same Wi-Fi auto-connect without cables
          try {
            udpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            udpSock.on('error', () => {});
            udpSock.bind(() => {
              try { udpSock.setBroadcast(true); } catch {}
              const sendBeacon = () => {
                const ifaces = getLanInterfaces();
                if (!ifaces.length || !udpSock) return;
                const payload = Buffer.from(JSON.stringify({
                  app: 'foldstage',
                  port,
                  host: os.hostname(),
                  ips: ifaces.map((x) => x.address)
                }));
                const targets = new Set(['255.255.255.255', ...ifaces.map((x) => x.broadcast)]);
                for (const dst of targets) {
                  try { udpSock.send(payload, 0, payload.length, udpPort, dst); } catch {}
                }
              };
              sendBeacon();
              udpTimer = setInterval(sendBeacon, 2500);
              udpTimer.unref?.();
            });
          } catch {}
          const lan = getLanInterfaces().map((x) => `http://${x.address}:${port}`).join(', ');
          console.log(`[FoldStage Companion] Listening on http://127.0.0.1:${port}${lan ? ` (LAN: ${lan})` : ''}`);
          resolve({ port });
        });
      });
    },
    stop() {
      clearInterval(hb);
      if (udpTimer) clearInterval(udpTimer);
      try { udpSock?.close(); } catch {}
      adb.stop();
      audio.stop();
      server.close();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createCompanionServer();
  app.start().catch((err) => {
    console.error('[FoldStage Companion] Failed to start:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => { app.stop(); process.exit(0); });
  process.on('SIGTERM', () => { app.stop(); process.exit(0); });
}
