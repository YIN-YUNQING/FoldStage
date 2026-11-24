#!/usr/bin/env node
// Cross-platform entry point for FoldStage Companion.
// Starts the local HTTP/SSE Companion server and optionally opens the Studio GUI window.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createCompanionServer } from './core/server.mjs';

const port = Number(process.env.FOLDSTAGE_PORT || 8772);
const noOpen = process.argv.includes('--no-open');

function openStudioWindow(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    // Prefer Edge/Chrome in standalone desktop app-window mode for native GUI feel
    const browsers = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    const found = browsers.find((p) => fs.existsSync(p));
    if (found) {
      spawn(found, [`--app=${url}`, '--window-size=1080,760'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

const app = createCompanionServer({ port });
app.start()
  .then(() => {
    const url = `http://127.0.0.1:${port}/`;
    if (!noOpen) openStudioWindow(url);
  })
  .catch((err) => {
    console.error('[FoldStage] Could not start:', err.message);
    process.exit(1);
  });

process.on('SIGINT', () => { app.stop(); process.exit(0); });
process.on('SIGTERM', () => { app.stop(); process.exit(0); });
