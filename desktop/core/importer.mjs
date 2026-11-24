// Pure-JS cross-platform Live2D .zip importer & model library manager.
// Uses only Node.js built-ins (node:zlib, node:fs) so it works identically on
// macOS, Windows, and Linux without external `unzip` / PowerShell tools.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export function getDataDir() {
  return process.env.FOLDSTAGE_DATA_DIR || path.join(os.homedir(), '.foldstage');
}

export function getModelsDir() {
  const dir = path.join(getDataDir(), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- Pure-JS ZIP parser (Store + Deflate, UTF-8 safe) ----
export function parseZipEntries(buf) {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end
  const minPos = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid ZIP archive: EOCD header not found');

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let pos = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen);
    const name = rawName.toString((flags & 0x800) ? 'utf8' : 'utf8').replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (name.startsWith('__MACOSX/') || path.basename(name) === '.DS_Store') continue;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(compData);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    if (uncompSize > 0 && data.length !== uncompSize) {
      throw new Error(`Size mismatch for ${name}: expected ${uncompSize}, got ${data.length}`);
    }
    entries.push({ name, data });
  }
  return entries;
}

function sanitizeRelPath(p) {
  const clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw new Error(`Unsafe path in archive: ${p}`);
  return parts.join('/');
}

function slugify(str) {
  const s = String(str || 'model')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'model-' + crypto.randomBytes(3).toString('hex');
}

// Analyze a model3.json and all extracted relative file paths to classify
// Standing vs Performance models and resolve play/action/finish/idle motions.
export function analyzeModelFiles(modelRelPath, modelJson, allRelFiles) {
  const refs = modelJson?.FileReferences || {};
  const moc = refs.Moc;
  const textures = Array.isArray(refs.Textures) ? refs.Textures : [];
  if (!moc) throw new Error('model3.json is missing FileReferences.Moc');
  if (!textures.length) throw new Error('model3.json is missing FileReferences.Textures');

  const fileSet = new Set(allRelFiles);
  if (!fileSet.has(moc)) {
    throw new Error(`Referenced Moc file not found: ${moc}`);
  }
  for (const t of textures) {
    if (!fileSet.has(t)) {
      throw new Error(`Referenced texture not found: ${t}`);
    }
  }

  // Collect all motion file paths from model3.json Motions + motions/ directory
  const motionFiles = new Set();
  const motionsObj = refs.Motions || {};
  for (const arr of Object.values(motionsObj)) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item.File === 'string' && fileSet.has(item.File)) {
        motionFiles.add(item.File);
      }
    }
  }
  for (const f of allRelFiles) {
    if (f.toLowerCase().endsWith('.motion3.json')) motionFiles.add(f);
  }

  const allMotions = [...motionFiles].sort();
  const matchMotion = (re) => allMotions.filter((f) => re.test(path.basename(f).toLowerCase()));

  const play01 = matchMotion(/(^|_)play0?1_0?[12]\.motion3\.json$/);
  const play02 = matchMotion(/(^|_)play0?2_0?[12]\.motion3\.json$/);
  const fill = matchMotion(/(^|_)play0?[12]_0?3\.motion3\.json$/);
  const anyPlay = matchMotion(/(^|_)play\d+.*\.motion3\.json$/);
  const action = matchMotion(/(^|_)action_?\d*\.motion3\.json$/);
  const finish = matchMotion(/(^|_)finish_?\d*\.motion3\.json$/)[0] || null;
  const idle = matchMotion(/(^|_)idle_?\d*\.motion3\.json$/)[0] || null;

  const hasPerformanceMotions = play01.length > 0 || play02.length > 0 || anyPlay.length > 0;
  const calm = play01.length ? play01 : anyPlay;
  const drive = play02.length ? play02 : calm;

  const expressions = Array.isArray(refs.Expressions)
    ? refs.Expressions.map((e) => e?.Name).filter(Boolean)
    : [];

  return {
    role: hasPerformanceMotions ? 'performance' : 'standing',
    modelFile: modelRelPath,
    moc,
    textureCount: textures.length,
    expressionCount: expressions.length,
    motionCount: allMotions.length,
    motions: hasPerformanceMotions
      ? {
          calm,
          drive,
          fill: fill.length ? fill : drive,
          action,
          finish,
          idle
        }
      : {
          idle,
          gestures: allMotions.slice(0, 60)
        }
  };
}

function readLibraryIndex() {
  const indexPath = path.join(getModelsDir(), 'index.json');
  if (!fs.existsSync(indexPath)) return { models: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (Array.isArray(parsed.models)) return parsed;
  } catch {}
  return { models: [] };
}

function writeLibraryIndex(idx) {
  const indexPath = path.join(getModelsDir(), 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
}

export function listModels() {
  const idx = readLibraryIndex();
  const dir = getModelsDir();
  const valid = idx.models.filter((m) => fs.existsSync(path.join(dir, m.id, m.modelFile)));
  if (valid.length !== idx.models.length) {
    idx.models = valid;
    writeLibraryIndex(idx);
  }
  return valid;
}

// Import a Live2D .zip buffer into ~/.foldstage/models/<id>/
export function importModelZip(zipBuffer, originalFilename = 'model.zip', options = {}) {
  const entries = parseZipEntries(zipBuffer);
  if (!entries.length) throw new Error('ZIP archive is empty');

  // Find all model3.json and *.model3.json files
  const candidates = entries.filter((e) => {
    const base = path.posix.basename(e.name).toLowerCase();
    return base === 'model3.json' || base.endsWith('.model3.json');
  });
  if (!candidates.length) {
    throw new Error('No model3.json / *.model3.json found in ZIP. Please upload a valid Cubism 3/4 Live2D model package.');
  }

  // Prefer gestures.model3.json -> model3.json -> shortest path *.model3.json
  candidates.sort((a, b) => {
    const score = (n) => {
      const base = path.basename(n).toLowerCase();
      if (base === 'gestures.model3.json') return 0;
      if (base === 'model3.json') return 1;
      if (base === 'scene.model3.json') return 3;
      return 2;
    };
    const sa = score(a.name), sb = score(b.name);
    if (sa !== sb) return sa - sb;
    return a.name.length - b.name.length;
  });

  const chosen = candidates[0];
  const rootPrefix = path.posix.dirname(chosen.name);
  const stripPrefix = rootPrefix === '.' ? '' : rootPrefix + '/';

  // Filter entries belonging to the model root and strip common wrapper directory
  const relEntries = [];
  for (const e of entries) {
    if (stripPrefix && !e.name.startsWith(stripPrefix)) continue;
    const rel = sanitizeRelPath(stripPrefix ? e.name.slice(stripPrefix.length) : e.name);
    if (!rel) continue;
    relEntries.push({ rel, data: e.data });
  }

  const modelRelPath = sanitizeRelPath(stripPrefix ? chosen.name.slice(stripPrefix.length) : chosen.name);
  let modelJson;
  try {
    modelJson = JSON.parse(chosen.data.toString('utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${modelRelPath}: ${err.message}`);
  }

  const allRelFiles = relEntries.map((e) => e.rel);
  const analysis = analyzeModelFiles(modelRelPath, modelJson, allRelFiles);

  // Derive clean display name and unique ID
  const zipStem = path.basename(originalFilename, path.extname(originalFilename));
  const folderHint = rootPrefix && rootPrefix !== '.' ? path.posix.basename(rootPrefix) : zipStem;
  const displayName = (options.name || folderHint || path.basename(modelRelPath, '.model3.json')).trim();
  const baseId = slugify(options.id || displayName);

  const idx = readLibraryIndex();
  let id = baseId;
  const existingIdx = idx.models.findIndex((m) => m.id === id);
  if (existingIdx >= 0 && !options.overwrite) {
    let n = 2;
    while (idx.models.some((m) => m.id === `${baseId}-${n}`)) n++;
    id = `${baseId}-${n}`;
  }

  const destDir = path.join(getModelsDir(), id);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  let totalBytes = 0;
  for (const e of relEntries) {
    const outPath = path.join(destDir, e.rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, e.data);
    totalBytes += e.data.length;
  }

  const role = options.role === 'performance' || options.role === 'standing' ? options.role : analysis.role;
  const hasAnyDefaultStanding = idx.models.some((m) => m.role === 'standing' && m.isDefault);
  const hasAnyDefaultPerf = idx.models.some((m) => m.role === 'performance' && m.isDefaultPerformance);

  const record = {
    id,
    name: displayName,
    role,
    modelFile: analysis.modelFile,
    moc: analysis.moc,
    textureCount: analysis.textureCount,
    expressionCount: analysis.expressionCount,
    motionCount: analysis.motionCount,
    motions: analysis.motions,
    files: allRelFiles,
    sizeBytes: totalBytes,
    isDefault: role === 'standing' && !hasAnyDefaultStanding,
    isDefaultPerformance: role === 'performance' && !hasAnyDefaultPerf,
    version: Date.now()
  };

  if (existingIdx >= 0 && options.overwrite) {
    idx.models[existingIdx] = record;
  } else {
    idx.models.push(record);
  }
  // If there is no default standing model at all yet, mark first model as default
  if (!idx.models.some((m) => m.isDefault) && idx.models.length > 0) {
    idx.models[0].isDefault = true;
  }
  writeLibraryIndex(idx);
  return record;
}

export function updateModel(id, patch = {}) {
  const idx = readLibraryIndex();
  const m = idx.models.find((x) => x.id === id);
  if (!m) throw new Error(`Model not found: ${id}`);

  if (typeof patch.name === 'string' && patch.name.trim()) {
    m.name = patch.name.trim().slice(0, 64);
  }
  if (patch.role === 'standing' || patch.role === 'performance') {
    m.role = patch.role;
  }
  if (patch.isDefault === true) {
    for (const x of idx.models) x.isDefault = x.id === id;
  }
  if (patch.isDefaultPerformance === true) {
    for (const x of idx.models) x.isDefaultPerformance = x.id === id;
  }
  m.version = Date.now();
  writeLibraryIndex(idx);
  return m;
}

export function deleteModel(id) {
  const idx = readLibraryIndex();
  const pos = idx.models.findIndex((x) => x.id === id);
  if (pos < 0) return false;
  idx.models.splice(pos, 1);
  if (idx.models.length > 0 && !idx.models.some((m) => m.isDefault)) {
    idx.models[0].isDefault = true;
  }
  if (!idx.models.some((m) => m.isDefaultPerformance)) {
    const perf = idx.models.find((m) => m.role === 'performance');
    if (perf) perf.isDefaultPerformance = true;
  }
  writeLibraryIndex(idx);
  fs.rmSync(path.join(getModelsDir(), id), { recursive: true, force: true });
  return true;
}

export function resolveModelFilePath(id, relPath) {
  const safeId = sanitizeRelPath(id);
  const safeRel = sanitizeRelPath(relPath);
  const root = path.join(getModelsDir(), safeId);
  const full = path.normalize(path.join(root, safeRel));
  if (!full.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}
