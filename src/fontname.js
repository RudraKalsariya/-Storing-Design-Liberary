// Reads a font's real name ("Inter Bold") and declared type (serif, sans, script…)
// out of the file, so fonts get a proper title and land in the right Fonts
// subfolder. Handles TTF/OTF and WOFF; WOFF2 falls back to the filename.

import zlib from 'node:zlib';

function tablesFromSfnt(buf, wanted) {
  const tables = {};
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('latin1', rec, rec + 4);
    if (!wanted.includes(tag)) continue;
    const offset = buf.readUInt32BE(rec + 8);
    tables[tag] = buf.subarray(offset, offset + buf.readUInt32BE(rec + 12));
  }
  return tables;
}

function tablesFromWoff(buf, wanted) {
  const tables = {};
  const numTables = buf.readUInt16BE(12);
  for (let i = 0; i < numTables; i++) {
    const rec = 44 + i * 20;
    const tag = buf.toString('latin1', rec, rec + 4);
    if (!wanted.includes(tag)) continue;
    const offset = buf.readUInt32BE(rec + 4);
    const compLength = buf.readUInt32BE(rec + 8);
    const origLength = buf.readUInt32BE(rec + 12);
    const data = buf.subarray(offset, offset + compLength);
    tables[tag] = compLength < origLength ? zlib.inflateSync(data) : data;
  }
  return tables;
}

/**
 * The type a font's designer declared in the file: OS/2 family class first,
 * then PANOSE, then the fixed-pitch flag. Null when the file doesn't say.
 */
function fontType(os2, post) {
  if (post?.length >= 16 && post.readUInt32BE(12) !== 0) return 'mono';
  if (!os2 || os2.length < 42) return null;
  const familyClass = os2.readUInt8(30);
  const [family, serifStyle, , proportion] = os2.subarray(32, 36);
  if (family === 2 && proportion === 9) return 'mono';
  if (familyClass === 10 || family === 3) return 'script';
  if (familyClass === 9 || family === 4) return 'display';
  if (familyClass === 8) return 'sans';
  if (familyClass >= 1 && familyClass <= 7) return 'serif';
  if (family === 2 && serifStyle >= 11 && serifStyle <= 13) return 'sans';
  if (family === 2 && serifStyle >= 2 && serifStyle <= 10) return 'serif';
  return null;
}

/** Names often say it outright: "Work Sans", "Young Serif", "DM Mono". */
function typeFromName(name) {
  if (/\bmono(space)?\b|\bcode\b/i.test(name)) return 'mono';
  if (/\bsans\b|grotesk|grotesque|\bgothic\b/i.test(name)) return 'sans';
  if (/\bserif\b|\bslab\b/i.test(name)) return 'serif';
  if (/\bscript\b|\bhand(written)?\b|\bbrush\b|\bcalligraph/i.test(name)) return 'script';
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
    const wanted = ['name', 'OS/2', 'post'];
    let tables = null;
    if (sig === 'wOFF') tables = tablesFromWoff(buf, wanted);
    else if (sig === '\x00\x01\x00\x00' || sig === 'OTTO' || sig === 'true') tables = tablesFromSfnt(buf, wanted);
    if (!tables?.name) return null;
    const n = readNames(tables.name);
    // 16/17 are the typographic family/subfamily, 1/2 the legacy ones, 4 the full name.
    const family = n[16] || n[1];
    const style = n[17] || n[2];
    let type = null;
    try {
      type = fontType(tables['OS/2'], tables.post);
    } catch {}
    type ||= typeFromName(`${n[16] || ''} ${n[1] || ''} ${n[4] || ''}`);
    return { family, style, fullName: n[4] || [family, style].filter(Boolean).join(' '), designer: n[9] || '', type };
  } catch {
    return null;
  }
}
