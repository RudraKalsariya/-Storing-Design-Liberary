// Reads a font's real name ("Inter Bold") out of its `name` table, so fonts get a
// proper title instead of a filename. Handles TTF/OTF and WOFF; WOFF2 falls back
// to the filename.

import zlib from 'node:zlib';

function nameTableFromSfnt(buf) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      const offset = buf.readUInt32BE(rec + 8);
      const length = buf.readUInt32BE(rec + 12);
      return buf.subarray(offset, offset + length);
    }
  }
  return null;
}

function nameTableFromWoff(buf) {
  const numTables = buf.readUInt16BE(12);
  for (let i = 0; i < numTables; i++) {
    const rec = 44 + i * 20;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      const offset = buf.readUInt32BE(rec + 4);
      const compLength = buf.readUInt32BE(rec + 8);
      const origLength = buf.readUInt32BE(rec + 12);
      const data = buf.subarray(offset, offset + compLength);
      return compLength < origLength ? zlib.inflateSync(data) : data;
    }
  }
  return null;
}

function readNames(table) {
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  const names = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platformId = table.readUInt16BE(r);
    const nameId = table.readUInt16BE(r + 6);
    const length = table.readUInt16BE(r + 8);
    const offset = table.readUInt16BE(r + 10);
    const raw = table.subarray(stringOffset + offset, stringOffset + offset + length);
    let text;
    if (platformId === 3 || platformId === 0) {
      const swapped = Buffer.from(raw);
      swapped.swap16();
      text = swapped.toString('utf16le');
    } else if (platformId === 1) {
      text = raw.toString('latin1');
    } else continue;
    // Prefer Windows/Unicode English strings, which come first in practice.
    if (!names[nameId] || platformId === 3) names[nameId] = text.trim();
  }
  return names;
}

export function fontInfo(buf) {
  try {
    const sig = buf.toString('latin1', 0, 4);
    let table = null;
    if (sig === 'wOFF') table = nameTableFromWoff(buf);
    else if (sig === '\x00\x01\x00\x00' || sig === 'OTTO' || sig === 'true') table = nameTableFromSfnt(buf);
    if (!table) return null;
    const n = readNames(table);
    // 16/17 are the typographic family/subfamily, 1/2 the legacy ones, 4 the full name.
    const family = n[16] || n[1];
    const style = n[17] || n[2];
    return { family, style, fullName: n[4] || [family, style].filter(Boolean).join(' '), designer: n[9] || '' };
  } catch {
    return null;
  }
}
