// The library index: categories (= folders on disk) and items (= files in them).
// Everything is kept in memory and persisted to library/.library.json.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LIBRARY_DIR, INDEX_FILE, THUMBS_DIR } from './config.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

export const UNSORTED = 'Unsorted';

let state = { version: 1, categories: {}, items: {} };

// ---------- persistence ----------

export function load() {
  if (fs.existsSync(INDEX_FILE)) {
    state = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    state.categories ??= {};
    state.items ??= {};
  }
  ensureFontsFolder();
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
}

export function flush() {
  clearTimeout(saveTimer);
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, INDEX_FILE);
}

// ---------- helpers ----------

export const newId = () => crypto.randomBytes(6).toString('hex');

export function slugify(text, max = 48) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

function folderSafe(name) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  return clean || UNSORTED;
}

// "Poster Layout", "poster layouts" and "Poster  Layouts" are the same folder.
const keyOf = (name) =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.replace(/ies$/, 'y').replace(/(ss|x|ch|sh)es$/, '$1').replace(/([^s])s$/, '$1'))
    .join(' ');

export function findCategory(name) {
  if (!name) return null;
  const k = keyOf(name);
  return Object.values(state.categories).find((c) => keyOf(c.name) === k) || null;
}

const abs = (rel) => path.join(LIBRARY_DIR, rel);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

async function uniquePath(dir, base, ext, current) {
  const free = async (p) => path.resolve(p) === path.resolve(current) || !(await exists(p));
  let candidate = path.join(dir, `${base}${ext}`);
  for (let n = 2; !(await free(candidate)); n++) candidate = path.join(dir, `${base}-${n}${ext}`);
  return candidate;
}

// ---------- categories ----------
//
// A category is a folder on disk. Most are top-level. The permanent Fonts folder
// can also hold subfolders ("Fonts/Serif"), whose `name` is the full path and
// `label` the subfolder's own name.

export const FONTS = 'Fonts';
const FONT_TYPES = { sans: 'Sans Serif', serif: 'Serif', display: 'Display', script: 'Script', mono: 'Monospace' };

export const labelOf = (cat) => cat.label || cat.name;

export function listCategories() {
  return Object.values(state.categories);
}

export function childrenOf(name) {
  return Object.values(state.categories).filter((c) => c.parent === name);
}

function addCategory(label, { parent = null, description = '', createdBy = 'ai' } = {}) {
  const display = folderSafe(label);
  const parentCat = parent && state.categories[parent];
  const name = parentCat ? `${parentCat.name}/${display}` : display;
  const base = parentCat ? `${parentCat.folder}/${display}` : display;
  let folder = base;
  for (let n = 2; Object.values(state.categories).some((c) => c.folder.toLowerCase() === folder.toLowerCase()); n++) {
    folder = `${base} ${n}`;
  }
  const category = {
    name,
    ...(parentCat ? { label: display, parent: parentCat.name } : {}),
    folder,
    description,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  state.categories[name] = category;
  fs.mkdirSync(abs(folder), { recursive: true });
  save();
  events.emit('categories');
  return category;
}

/** Fonts always exists, and starts out with a subfolder for each common type. */
function ensureFontsFolder() {
  const fonts = state.categories[FONTS] || addCategory(FONTS, { description: 'Typeface files, arranged by type.', createdBy: 'rule' });
  fonts.permanent = true;
  fs.mkdirSync(abs(fonts.folder), { recursive: true });
  if (!state.fontTypesSeeded) {
    for (const label of Object.values(FONT_TYPES)) {
      if (!childrenOf(FONTS).some((c) => keyOf(c.label) === keyOf(label))) addCategory(label, { parent: FONTS, createdBy: 'you' });
    }
    state.fontTypesSeeded = true;
    save();
  }
}

/** The Fonts subfolder for a detected type ("serif"), if you still have one. */
export function fontTypeFolder(type) {
  const label = FONT_TYPES[type];
  return (label && childrenOf(FONTS).find((c) => keyOf(c.label) === keyOf(label))?.name) || null;
}

export async function ensureCategory(name, { description = '', createdBy = 'ai' } = {}) {
  const existing = state.categories[name] || findCategory(name);
  if (existing) {
    if (!existing.description && description) {
      existing.description = description;
      save();
    }
    return { category: existing, created: false };
  }
  // "poster layouts" -> "Poster Layouts"; names with deliberate casing ("UI Design", "3D") are kept.
  const cased = name === name.toLowerCase() ? name.replace(/(^|[\s/&-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : name;
  return { category: addCategory(cased, { description, createdBy }), created: true };
}

export function createSubfolder(parentName, label) {
  const parent = state.categories[parentName];
  if (!parent) throw httpError(404, 'Folder not found');
  if (!parent.permanent) throw httpError(400, 'Subfolders can only be made inside Fonts');
  const existing = childrenOf(parentName).find((c) => keyOf(c.label) === keyOf(label));
  return existing || addCategory(label, { parent: parentName, createdBy: 'you' });
}

export function categoryItems(name) {
  return Object.values(state.items).filter((i) => i.category === name);
}

export async function renameCategory(oldName, newName, description) {
  const cat = state.categories[oldName];
  if (!cat) throw httpError(404, 'Folder not found');
  if (description !== undefined) cat.description = description;
  // Once you've named or described a folder yourself, it's yours: never auto-removed.
  if (!cat.permanent) cat.createdBy = 'you';

  const wanted = newName?.trim();
  if (wanted && wanted !== labelOf(cat)) {
    if (cat.permanent) throw httpError(400, `The ${cat.name} folder can't be renamed`);
    // Renaming onto another folder at the same level = merge into it.
    const target = Object.values(state.categories).find(
      (c) => c !== cat && (c.parent || null) === (cat.parent || null) && keyOf(labelOf(c)) === keyOf(wanted),
    );
    if (target) {
      for (const item of categoryItems(oldName)) await moveItem(item.id, target.name, { quiet: true });
      if (state.categories[oldName]) await removeCategory(oldName);
      events.emit('categories');
      return target;
    }
    const display = folderSafe(wanted);
    const parent = cat.parent && state.categories[cat.parent];
    const name = parent ? `${parent.name}/${display}` : display;
    const folder = parent ? `${parent.folder}/${display}` : display;
    const oldDir = abs(cat.folder);
    const newDir = abs(folder);
    // Two-step rename so a case-only change works on case-insensitive filesystems.
    const tmpDir = abs(`.rename-${newId()}`);
    if (await exists(oldDir)) {
      await fsp.rename(oldDir, tmpDir);
      await fsp.rename(tmpDir, newDir);
    } else {
      await fsp.mkdir(newDir, { recursive: true });
    }
    delete state.categories[oldName];
    Object.assign(cat, { name, folder }, parent ? { label: display } : {});
    state.categories[name] = cat;
    for (const item of Object.values(state.items)) {
      if (item.category === oldName) {
        item.category = name;
        if (item.file) item.file = path.posix.join(folder, path.posix.basename(item.file));
      }
    }
  }
  save();
  events.emit('categories');
  return cat;
}

export async function removeCategory(name) {
  const cat = state.categories[name];
  if (!cat) throw httpError(404, 'Folder not found');
  if (cat.permanent) throw httpError(400, `The ${cat.name} folder is permanent`);
  if (childrenOf(name).length) throw httpError(409, 'Folder has subfolders');
  if (categoryItems(name).length) throw httpError(409, 'Folder is not empty');
  delete state.categories[name];
  // Only remove the folder if nothing else (like .DS_Store) is left behind.
  try {
    const dir = abs(cat.folder);
    const left = (await fsp.readdir(dir)).filter((f) => f !== '.DS_Store' && f !== 'Thumbs.db');
    if (!left.length) await fsp.rm(dir, { recursive: true });
  } catch {}
  save();
  events.emit('categories');
}

// ---------- items ----------

export function getItem(id) {
  return state.items[id];
}

export function findByHash(hash) {
  return Object.values(state.items).find((i) => i.hash === hash);
}

export function allItems() {
  return Object.values(state.items).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addItem(item) {
  state.items[item.id] = item;
  save();
  emitItem(item);
  return item;
}

export function updateItem(id, patch) {
  const item = state.items[id];
  if (!item) return null;
  Object.assign(item, patch);
  save();
  emitItem(item);
  return item;
}

export function emitItem(item) {
  events.emit('item', item);
}

export function absPath(item) {
  return abs(item.file || item.inbox);
}

/** Puts a file into its category folder with a readable name. */
export async function placeFile(item, sourceAbs, categoryName) {
  const cat = state.categories[categoryName];
  const dir = abs(cat.folder);
  const base = `${slugify(item.title) || 'item'}-${item.id.slice(0, 6)}`;
  const dest = await uniquePath(dir, base, item.ext, sourceAbs);
  if (path.resolve(sourceAbs) !== path.resolve(dest)) await moveFile(sourceAbs, dest);
  item.file = path.relative(LIBRARY_DIR, dest).split(path.sep).join('/');
  item.category = cat.name;
  delete item.inbox;
}

export async function moveItem(id, categoryName, { quiet = false } = {}) {
  const item = state.items[id];
  if (!item) throw httpError(404, 'Item not found');
  const { category } = await ensureCategory(categoryName, { createdBy: 'you' });
  if (item.category === category.name) return item;
  const previous = item.category;
  await placeFile(item, absPath(item), category.name);
  item.sortedBy = 'you';
  save();
  if (!quiet) emitItem(item);
  await pruneIfEmpty(previous);
  return item;
}

/** Folders Claude created disappear again once they are empty; yours stay. */
export async function pruneIfEmpty(name) {
  const cat = name && state.categories[name];
  if (cat && cat.createdBy === 'ai' && !categoryItems(name).length) await removeCategory(name);
}

export async function deleteItem(id) {
  const item = state.items[id];
  if (!item) throw httpError(404, 'Item not found');
  for (const p of [absPath(item), item.thumb && abs(item.thumb)]) {
    if (p) await fsp.rm(p, { force: true });
  }
  delete state.items[id];
  save();
  events.emit('deleted', id);
}

export function thumbPathFor(id) {
  return { abs: path.join(THUMBS_DIR, `${id}.webp`), rel: `.thumbs/${id}.webp` };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
