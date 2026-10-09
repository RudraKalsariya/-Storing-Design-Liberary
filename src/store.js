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

export function listCategories() {
  return Object.values(state.categories);
}

export async function ensureCategory(name, { description = '', createdBy = 'ai' } = {}) {
  const existing = findCategory(name);
  if (existing) {
    if (!existing.description && description) {
      existing.description = description;
      save();
    }
    return { category: existing, created: false };
  }
  // "poster layouts" -> "Poster Layouts"; names with deliberate casing ("UI Design", "3D") are kept.
  const cased = name === name.toLowerCase() ? name.replace(/(^|[\s/&-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : name;
  const display = folderSafe(cased);
  let folder = display;
  for (let n = 2; Object.values(state.categories).some((c) => c.folder.toLowerCase() === folder.toLowerCase()); n++) {
    folder = `${display} ${n}`;
  }
  const category = { name: display, folder, description, createdBy, createdAt: new Date().toISOString() };
  state.categories[display] = category;
  await fsp.mkdir(abs(folder), { recursive: true });
  save();
  events.emit('categories');
  return { category, created: true };
}

export function categoryItems(name) {
  return Object.values(state.items).filter((i) => i.category === name);
}

export async function renameCategory(oldName, newName, description) {
  const cat = state.categories[oldName];
  if (!cat) throw httpError(404, 'Folder not found');
  if (description !== undefined) cat.description = description;
  // Once you've named or described a folder yourself, it's yours: never auto-removed.
  cat.createdBy = 'you';

  if (newName && newName.trim() && newName.trim() !== oldName) {
    const target = findCategory(newName);
    if (target && target !== cat) {
      // Renaming onto an existing folder = merge into it.
      for (const item of categoryItems(oldName)) await moveItem(item.id, target.name, { quiet: true });
      if (state.categories[oldName]) await removeCategory(oldName);
      events.emit('categories');
      return target;
    }
    const display = folderSafe(newName);
    const oldDir = abs(cat.folder);
    const newDir = abs(display);
    // Two-step rename so a case-only change works on case-insensitive filesystems.
    const tmpDir = abs(`.rename-${newId()}`);
    if (await exists(oldDir)) {
      await fsp.rename(oldDir, tmpDir);
      await fsp.rename(tmpDir, newDir);
    } else {
      await fsp.mkdir(newDir, { recursive: true });
    }
    delete state.categories[oldName];
    cat.name = display;
    cat.folder = display;
    state.categories[display] = cat;
    for (const item of Object.values(state.items)) {
      if (item.category === oldName) {
        item.category = display;
        if (item.file) item.file = path.posix.join(display, path.posix.basename(item.file));
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
