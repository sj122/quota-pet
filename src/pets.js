'use strict';

const fs = require('fs');
const path = require('path');
const { codexHome } = require('./paths');

// Codex 桌宠精灵图规格（来自 Codex 桌面端）：每格 192×208，8 列；
// v1 共 9 行，v2 共 11 行（多出的两行是 16 个方向的“看向”帧）。
const CELL_W = 192;
const CELL_H = 208;
const COLUMNS = 8;

function readHead(file, bytes = 64) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// 只解析文件头拿宽高。Codex 的 spritesheet.webp 有时其实是 PNG，所以两种都认。
function imageInfo(file) {
  const b = readHead(file);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8L') {
      const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
      return {
        type: 'image/webp',
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === 'VP8 ') {
      return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

function loadPetDir(dir, source) {
  const metaFile = path.join(dir, 'pet.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    return null;
  }
  const spritePath = path.resolve(dir, meta.spritesheetPath || 'spritesheet.webp');
  if (!spritePath.startsWith(path.resolve(dir) + path.sep)) return null;
  let info;
  let stat;
  try {
    info = imageInfo(spritePath);
    stat = fs.statSync(spritePath);
  } catch {
    return null;
  }
  if (!info || !info.width || !info.height) return null;

  let rows = info.width === CELL_W * COLUMNS ? Math.round(info.height / CELL_H) : meta.spriteVersionNumber === 2 ? 11 : 9;
  if (rows < 9) rows = 9;
  return {
    id: String(meta.id || path.basename(dir)),
    displayName: String(meta.displayName || meta.id || path.basename(dir)),
    description: String(meta.description || ''),
    source,
    spritePath,
    mime: info.type,
    width: info.width,
    height: info.height,
    columns: COLUMNS,
    rows,
    cellW: info.width / COLUMNS,
    cellH: info.height / rows,
    hasLookFrames: rows >= 11,
    version: stat.mtimeMs | 0,
  };
}

function listPets(extraDirs = []) {
  const roots = [
    { dir: path.join(codexHome, 'pets'), source: 'codex' },
    ...extraDirs,
    { dir: path.join(__dirname, '../assets/pets'), source: 'bundled' },
  ];
  const pets = [];
  const seen = new Set();
  for (const { dir, source } of roots) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const pet = loadPetDir(path.join(dir, name), source);
      if (pet && !seen.has(pet.id)) {
        seen.add(pet.id);
        pets.push(pet);
      }
    }
  }
  return pets;
}

module.exports = { listPets, imageInfo, CELL_W, CELL_H, COLUMNS };
