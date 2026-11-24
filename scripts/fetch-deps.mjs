#!/usr/bin/env node
// Downloads frontend runtime dependencies (Three.js, PIXI, pixi-live2d-display,
// Live2D Cubism Core, and offline MediaPipe FaceLandmarker) into web/vendor/.
// Keeps third-party binaries and proprietary Cubism Core out of the Git repository.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');

const FILES = [
  {
    dest: 'three.module.min.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js',
      'https://unpkg.com/three@0.170.0/build/three.module.min.js'
    ]
  },
  {
    dest: 'pixi.min.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
      'https://unpkg.com/pixi.js@6.5.10/dist/browser/pixi.min.js'
    ]
  },
  {
    dest: 'cubism4.min.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
      'https://unpkg.com/pixi-live2d-display@0.4.0/dist/cubism4.min.js'
    ]
  },
  {
    dest: 'live2dcubismcore.min.js',
    urls: [
      'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
    ]
  },
  {
    dest: 'mediapipe/vision_bundle.mjs',
    urls: [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    ]
  },
  {
    dest: 'mediapipe/wasm/vision_wasm_internal.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js'
    ]
  },
  {
    dest: 'mediapipe/wasm/vision_wasm_internal.wasm',
    urls: [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm'
    ]
  },
  {
    dest: 'mediapipe/wasm/vision_wasm_nosimd_internal.js',
    urls: [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js'
    ]
  },
  {
    dest: 'mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    urls: [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm',
      'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm'
    ]
  },
  {
    dest: 'mediapipe/face_landmarker.task',
    urls: [
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
    ]
  }
];

async function download(urls, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(target, buf);
      return buf.length;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function main() {
  const force = process.argv.includes('--force');
  console.log(`Fetching FoldStage runtime dependencies into ${VENDOR} ...`);
  for (const item of FILES) {
    const target = path.join(VENDOR, item.dest);
    if (!force && fs.existsSync(target) && fs.statSync(target).size > 100) {
      console.log(`  [skip] ${item.dest} (${(fs.statSync(target).size / 1024).toFixed(1)} KB)`);
      continue;
    }
    const bytes = await download(item.urls, target);
    console.log(`  [ok]   ${item.dest} (${(bytes / 1024).toFixed(1)} KB)`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed to fetch dependencies:', err);
  process.exit(1);
});
