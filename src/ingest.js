// Takes whatever you give the library (files, pasted links, pasted text), looks
// at it, asks the sorter where it goes, and files it into that folder.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { INBOX_DIR, LIBRARY_DIR, CONCURRENCY, aiEnabled } from './config.js';
import * as store from './store.js';
import { classify, classifyFont, ruleFor, IMAGE_EXTS, AIUnavailableError } from './classify.js';
import { fontInfo } from './fontname.js';

const MAX_PDF_BYTES = 24 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// ---------- work queue ----------

const queue = [];
let running = 0;

function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    processItem(id).finally(() => {
      running--;
      pump();
    });
  }
}

/** Anything left half-sorted when the app last stopped gets picked up again. */
export function resumePending() {
  for (const item of store.allItems()) {
    if (item.status === 'processing') enqueue(item.id);
  }
}

// ---------- helpers ----------

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/tiff': 'tiff', 'image/bmp': 'bmp', 'image/heic': 'heic',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'font/ttf': 'ttf', 'font/otf': 'otf', 'font/woff': 'woff', 'font/woff2': 'woff2', 'text/plain': 'txt',
};

const extOf = (name) => path.extname(name || '').slice(1).toLowerCase();

function kindFor(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt' || ext === 'md') return 'note';
  return ruleFor(ext)?.kind || 'file';
}

function titleFromName(name) {
  const base = path.basename(name || '', path.extname(name || ''));
  const t = base.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(image|img|screenshot|untitled|download|file|pasted)?\s*\d*$/i.test(t) ? '' : t;
}

async function hashFile(p) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), h);
  return h.digest('hex');
}

const hashText = (s) => crypto.createHash('sha256').update(s).digest('hex');

function newItem(fields) {
  return {
    status: 'processing',
    category: null,
    file: null,
    title: '',
    description: '',
    tags: [],
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

// ---------- intake ----------

/**
 * A file that has already been written somewhere inside the library folder.
 * `target` is a folder you picked yourself; without one, the sorter decides.
 */
export async function ingestFile(tmpPath, originalName, mime = '', { target } = {}) {
  const ext = extOf(originalName) || MIME_EXT[mime.split(';')[0]] || '';
  const hash = await hashFile(tmpPath);
  const dup = store.findByHash(hash);
  if (dup) {
    await fsp.rm(tmpPath, { force: true });
    return { item: dup, duplicate: true };
  }
  const id = store.newId();
  const inbox = `.inbox/${id}${ext ? `.${ext}` : ''}`;
  await fsp.rename(tmpPath, path.join(LIBRARY_DIR, inbox));
  const { size } = await fsp.stat(path.join(LIBRARY_DIR, inbox));
  const item = newItem({
    id,
    kind: kindFor(ext),
    inbox,
    originalName,
    ext: ext ? `.${ext}` : '',
    mime,
    size,
    hash,
    title: titleFromName(originalName),
    target: target || undefined,
  });
  store.addItem(item);
  enqueue(id);
  return { item, duplicate: false };
}

/** Pasted text: a link to an image/file, a link to a page, or just a note. */
export async function ingestText(text, { target } = {}) {
  const value = text.trim();
  if (!value) throw store.httpError(400, 'Nothing to save');
  if (/^https?:\/\/\S+$/i.test(value)) return ingestUrl(value, { target });

  const hash = hashText(`note:${value}`);
  const dup = store.findByHash(hash);
  if (dup) return { item: dup, duplicate: true };
  const id = store.newId();
  const inbox = `.inbox/${id}.txt`;
  await fsp.writeFile(path.join(LIBRARY_DIR, inbox), value);
  const firstLine = value.split('\n')[0].slice(0, 60);
  const item = newItem({ id, kind: 'note', inbox, ext: '.txt', size: Buffer.byteLength(value), hash, text: value.slice(0, 5000), title: firstLine, target: target || undefined });
  store.addItem(item);
  enqueue(id);
  return { item, duplicate: false };
}

async function ingestUrl(url, { target }) {
  const hash = hashText(`url:${url}`);
  const dup = store.findByHash(hash);
  if (dup) return { item: dup, duplicate: true };

  let res = null;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA, accept: 'text/html,image/*,*/*;q=0.8' } });
  } catch {}
  const type = (res?.headers.get('content-type') || '').toLowerCase();

  // A direct link to an image, PDF, font or video: download it and treat it like a dropped file.
  if (res?.ok && res.body && /^(image\/|video\/|font\/|application\/pdf|application\/(x-)?font)/.test(type)) {
    let name = '';
    try {
      name = decodeURIComponent(path.basename(new URL(res.url).pathname));
    } catch {}
    if (!extOf(name)) name = `${name || 'download'}.${MIME_EXT[type.split(';')[0]] || 'bin'}`;
    const tmp = path.join(INBOX_DIR, `download-${store.newId()}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    return ingestFile(tmp, name, type, { target });
  }

  // Otherwise it's a page: keep it as a bookmark with its preview image.
  let meta = {};
  if (res?.ok && type.includes('html')) {
    try {
      meta = parsePageMeta((await res.text()).slice(0, 2_000_000), res.url);
    } catch {}
  }
  const host = new URL(url).hostname.replace(/^www\./, '');
  const id = store.newId();
  const inbox = `.inbox/${id}.url`;
  await fsp.writeFile(path.join(LIBRARY_DIR, inbox), `[InternetShortcut]\r\nURL=${url}\r\n`);
  const item = newItem({
    id,
    kind: 'link',
    inbox,
    ext: '.url',
    hash,
    url,
    site: meta.siteName || host,
    pageTitle: meta.title || '',
    pageDescription: meta.description || '',
    previewUrl: meta.image || '',
    title: meta.title || host,
    target: target || undefined,
  });
  store.addItem(item);
  enqueue(id);
  return { item, duplicate: false };
}

function parsePageMeta(html, base) {
  const decode = (s) =>
    s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  const metas = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !metas[key]) metas[key] = decode(attrs.content);
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let image = metas['og:image'] || metas['og:image:url'] || metas['twitter:image'] || '';
  try {
    if (image) image = new URL(image, base).href;
  } catch {
    image = '';
  }
  return {
    title: metas['og:title'] || metas['twitter:title'] || (titleTag ? decode(titleTag) : ''),
    description: metas['og:description'] || metas.description || '',
    siteName: metas['og:site_name'] || '',
    image,
  };
}

// ---------- looking at things ----------

function hex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** A small palette of the most present, visibly different colors. */
async function paletteOf(img) {
  const { data, info } = await img.clone().resize(48, 48, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Map();
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bin.n++;
    bins.set(key, bin);
    total++;
  }
  const picked = [];
  for (const bin of [...bins.values()].sort((a, b) => b.n - a.n)) {
    if (bin.n / total < 0.01 || picked.length >= 6) break;
    const c = { r: bin.r / bin.n, g: bin.g / bin.n, b: bin.b / bin.n };
    if (picked.every((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) > 48)) picked.push(c);
  }
  return picked.map(hex);
}

/** Thumbnail, size, colors, and a right-sized copy for Claude to look at. */
async function lookAtImage(input, id, { svg = false, forAI = true } = {}) {
  const img = sharp(input, { limitInputPixels: false, ...(svg ? { density: 200 } : {}) }).rotate();
  const meta = await img.metadata();
  const swap = (meta.orientation || 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  const thumb = store.thumbPathFor(id);
  await img.clone().resize({ width: 720, withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumb.abs);
  const colors = await paletteOf(img).catch(() => []);
  const forClaude = forAI && await img
    .clone()
    .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  return {
    patch: { width, height, thumb: thumb.rel, colors },
    block: forClaude && { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: forClaude.toString('base64') } },
  };
}

async function look(item, src, forAI) {
  const ext = item.ext.slice(1);
  const name = item.originalName ? `Original filename: ${item.originalName}` : '';

  if (item.kind === 'image') {
    try {
      const { patch, block } = await lookAtImage(src, item.id, { svg: ext === 'svg', forAI });
      return { patch, blocks: [block], context: name };
    } catch {
      return { patch: {}, blocks: null, context: name, unreadable: 'This image format could not be read.' };
    }
  }

  if (item.kind === 'pdf') {
    const blocks = [];
    if (forAI && item.size <= MAX_PDF_BYTES) {
      const data = (await fsp.readFile(src)).toString('base64');
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    }
    return { patch: {}, blocks, context: `${name}\nThis is a PDF${blocks.length ? '' : ' too large to show you; judge from its name'}.` };
  }

  if (item.kind === 'note') {
    const text = (await fsp.readFile(src, 'utf8')).slice(0, 20000);
    return {
      patch: { text: text.slice(0, 5000) },
      blocks: [{ type: 'text', text: `A text note they saved:\n"""\n${text}\n"""` }],
      context: name,
    };
  }

  if (item.kind === 'link') {
    const blocks = [];
    let patch = {};
    if (item.thumb && forAI) {
      // Re-sorting: reuse the preview we already downloaded.
      const buf = await fsp.readFile(path.join(LIBRARY_DIR, item.thumb));
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: buf.toString('base64') } });
    } else if (item.previewUrl) {
      try {
        const res = await fetch(item.previewUrl, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': UA } });
        if (res.ok) {
          const looked = await lookAtImage(Buffer.from(await res.arrayBuffer()), item.id, { forAI });
          patch = looked.patch;
          if (looked.block) blocks.push(looked.block);
        }
      } catch {}
    }
    const context = [
      `A web page they bookmarked: ${item.url}`,
      item.pageTitle && `Page title: ${item.pageTitle}`,
      item.pageDescription && `Page description: ${item.pageDescription}`,
      blocks.length ? 'The image above is the page’s preview image.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    blocks.push({ type: 'text', text: context });
    return { patch, blocks, context: '' };
  }

  if (item.kind === 'font') {
    const info = fontInfo(await fsp.readFile(src));
    return {
      patch: info
        ? {
            title: info.fullName || item.title,
            fontFamily: info.family,
            fontStyle: info.style,
            tags: [info.family, info.style, info.type && ({ sans: 'sans serif', mono: 'monospace' }[info.type] || info.type)].filter(Boolean).map((t) => t.toLowerCase()),
          }
        : {},
      rule: ruleFor(ext),
      font: info,
    };
  }

  return { patch: {}, rule: ruleFor(ext) || { category: 'Files', description: 'Other files.' } };
}

// ---------- sorting ----------

async function processItem(id) {
  const item = store.getItem(id);
  if (!item) return;
  const previousCategory = item.category;
  try {
    const src = store.absPath(item);
    const useAI = !item.target && aiEnabled();
    const seen = await look(item, src, useAI);
    Object.assign(item, seen.patch);

    let decision;
    if (item.target) {
      decision = { category: item.target, sortedBy: 'you' };
    } else if (item.kind === 'font') {
      decision = { category: store.FONTS, sortedBy: 'rule', ...(await fontFolderFor(seen.font)) };
    } else if (seen.rule) {
      decision = { category: seen.rule.category, categoryDescription: seen.rule.description, sortedBy: 'rule' };
    } else if (!useAI) {
      // Auto-sorting is off: it waits in Unsorted until you pick a folder.
      decision = { category: store.UNSORTED, categoryDescription: 'Things waiting for a folder.', sortedBy: 'fallback' };
      delete item.error;
    } else {
      try {
        if (seen.unreadable) throw new Error(seen.unreadable);
        decision = { ...(await classify(seen.blocks, seen.context)), sortedBy: 'ai' };
        delete item.error;
      } catch (err) {
        if (!(err instanceof AIUnavailableError)) console.error(`[sort] ${item.originalName || item.url || id}:`, err.message);
        decision = {
          category: store.UNSORTED,
          categoryDescription: 'Things waiting for a folder.',
          sortedBy: 'fallback',
        };
        item.error = err instanceof AIUnavailableError ? `${err.message}. Check your API key in Settings.` : err.message;
      }
    }

    const { category, created } = await store.ensureCategory(decision.category, {
      description: decision.categoryDescription,
      createdBy: { ai: 'ai', you: 'you' }[decision.sortedBy] || 'rule',
    });
    if (decision.title) item.title = decision.title;
    if (decision.description) item.description = decision.description;
    if (decision.tags?.length) item.tags = decision.tags;
    if (!item.title) item.title = titleFromName(item.originalName) || 'Untitled';
    delete item.target;

    await store.placeFile(item, src, category.name);
    store.updateItem(id, { status: 'ready', sortedBy: decision.sortedBy, sortedAt: new Date().toISOString() });
    store.events.emit('sorted', { id, category: category.name, created, previous: previousCategory, by: decision.sortedBy });
    if (previousCategory && previousCategory !== category.name) await store.pruneIfEmpty(previousCategory);
  } catch (err) {
    console.error(`[sort] failed for ${id}:`, err);
    store.updateItem(id, { status: 'error', error: err.message });
  }
}

/**
 * Which Fonts subfolder a font goes in: the type stored in the file or hinted
 * by its name, else Claude's guess from the name (if auto-sorting is on).
 * Unknown fonts stay at the top of Fonts.
 */
async function fontFolderFor(info) {
  if (!info) return {};
  const byType = store.fontTypeFolder(info.type);
  if (byType) return { category: byType, sortedBy: 'rule' };
  if (!aiEnabled()) return {};
  const subfolders = store.childrenOf(store.FONTS);
  try {
    const label = await classifyFont(info, subfolders.map(store.labelOf));
    const match = subfolders.find((c) => store.labelOf(c) === label);
    return match ? { category: match.name, sortedBy: 'ai' } : {};
  } catch (err) {
    if (!(err instanceof AIUnavailableError)) console.error(`[sort] font ${info.fullName}:`, err.message);
    return {};
  }
}

/** Ask the sorter again (e.g. after adding an API key, or if it guessed wrong). */
export function resort(id) {
  const item = store.getItem(id);
  if (!item) throw store.httpError(404, 'Item not found');
  if (!aiEnabled() && item.kind !== 'font') throw store.httpError(400, 'Turn on auto-sorting in Settings to use Re-sort');
  store.updateItem(id, { status: 'processing' });
  enqueue(id);
  return item;
}
