import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ROOT, LIBRARY_DIR, INBOX_DIR, settings, saveSettings, aiEnabled, MODELS } from './config.js';
import * as store from './store.js';
import { ingestFile, ingestText, resort, resumePending } from './ingest.js';
import { verifyKey } from './classify.js';

store.load();

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const app = express();

// Only this app's own page may use the library. A website open in your browser
// can send requests to 127.0.0.1 too, so anything carrying another site's
// Origin (or a Host that isn't this machine) is turned away.
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return res.status(403).end();
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return res.status(403).end();
  next();
});

app.use(express.json({ limit: '5mb' }));

// The page starts in your chosen theme, so there's no flash of the wrong one.
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (_req, res) => {
  res.type('html').send(indexHtml.replace('<html lang="en">', `<html lang="en" data-theme="${settings.theme}">`));
});
app.use(express.static(path.join(ROOT, 'public'), { index: false }));
// The library itself, so the app can show your files. dotfiles are needed for .thumbs.
app.use('/files', express.static(LIBRARY_DIR, { dotfiles: 'allow', index: false, maxAge: '1h' }));

// No size limit: the only ceiling is your disk.
const upload = multer({
  storage: multer.diskStorage({
    destination: INBOX_DIR,
    filename: (_req, _file, cb) => cb(null, `upload-${store.newId()}`),
  }),
});

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

// A folder picked in the Add dialog, or empty for "sort it for me".
const targetFolder = (name) => (typeof name === 'string' && name.trim()) || undefined;

function publicItem(item) {
  const url = (rel) => rel && `/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
  const { hash, inbox, ...rest } = item;
  return { ...rest, src: url(item.file || item.inbox), thumbSrc: url(item.thumb) };
}

function publicCategory(c) {
  const items = store.categoryItems(c.name);
  return { ...c, count: items.length, latest: items.map((i) => i.createdAt).sort().at(-1) || c.createdAt };
}

app.get(
  '/api/library',
  wrap(async (_req, res) => {
    res.json({
      ai: { enabled: aiEnabled(), hasKey: Boolean(settings.apiKey), model: settings.model },
      libraryDir: LIBRARY_DIR,
      categories: store.listCategories().map(publicCategory),
      items: store.allItems().map(publicItem),
    });
  }),
);

app.post(
  '/api/upload',
  upload.array('files'),
  wrap(async (req, res) => {
    const results = [];
    for (const f of req.files || []) {
      // Browsers send filenames as latin1; recover UTF-8 names like "café.png".
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const { item, duplicate } = await ingestFile(f.path, name, f.mimetype, { target: targetFolder(req.body?.category) });
      results.push({ item: publicItem(item), duplicate });
    }
    res.json({ results });
  }),
);

app.post(
  '/api/paste',
  wrap(async (req, res) => {
    const { item, duplicate } = await ingestText(String(req.body?.text || ''), { target: targetFolder(req.body?.category) });
    res.json({ results: [{ item: publicItem(item), duplicate }] });
  }),
);

app.patch(
  '/api/items/:id',
  wrap(async (req, res) => {
    const { category, title, description, tags } = req.body || {};
    if (!store.getItem(req.params.id)) throw store.httpError(404, 'Item not found');
    const patch = {};
    if (typeof title === 'string') patch.title = title.trim();
    if (typeof description === 'string') patch.description = description.trim();
    if (Array.isArray(tags)) patch.tags = tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    let item = store.updateItem(req.params.id, patch);
    if (typeof category === 'string' && category.trim()) item = await store.moveItem(req.params.id, category.trim());
    res.json({ item: publicItem(item) });
  }),
);

app.post(
  '/api/items/:id/resort',
  wrap(async (req, res) => {
    res.json({ item: publicItem(resort(req.params.id)) });
  }),
);

app.delete(
  '/api/items/:id',
  wrap(async (req, res) => {
    await store.deleteItem(req.params.id);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/categories',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw store.httpError(400, 'Folder needs a name');
    const parent = typeof req.body?.parent === 'string' && req.body.parent;
    const category = parent
      ? store.createSubfolder(parent, name)
      : (await store.ensureCategory(name, { description: String(req.body?.description || ''), createdBy: 'you' })).category;
    res.json({ category: publicCategory(category) });
  }),
);

app.patch(
  '/api/categories/:name',
  wrap(async (req, res) => {
    const { name, description } = req.body || {};
    const category = await store.renameCategory(req.params.name, name, description);
    res.json({ category: publicCategory(category) });
  }),
);

app.delete(
  '/api/categories/:name',
  wrap(async (req, res) => {
    await store.removeCategory(req.params.name);
    res.json({ ok: true });
  }),
);

app.get('/api/settings', (_req, res) => {
  res.json({
    hasKey: Boolean(settings.apiKey),
    keyHint: settings.apiKey ? `…${settings.apiKey.slice(-4)}` : '',
    autoSort: settings.autoSort,
    model: settings.model,
    models: MODELS,
    libraryDir: LIBRARY_DIR,
    theme: settings.theme,
    version: VERSION,
  });
});

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const { apiKey, autoSort, model, theme } = req.body || {};
    const patch = {};
    if (['system', 'light', 'dark'].includes(theme)) patch.theme = theme;
    if (typeof model === 'string' && MODELS.some((m) => m.id === model)) patch.model = model;
    if (typeof autoSort === 'boolean') patch.autoSort = autoSort;
    if (typeof apiKey === 'string') {
      const key = apiKey.trim();
      if (key) {
        const problem = await verifyKey(key, patch.model || settings.model);
        if (problem) throw store.httpError(400, problem);
      }
      patch.apiKey = key;
    }
    saveSettings(patch);
    store.events.emit('settings');
    res.json({ ok: true, ai: { enabled: aiEnabled(), hasKey: Boolean(settings.apiKey), model: settings.model } });
  }),
);

// Live updates: the page watches this to see things get sorted.
app.get('/api/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onItem = (item) => send('item', publicItem(item));
  const onSorted = (info) => send('sorted', info);
  const onDeleted = (id) => send('deleted', { id });
  const onCategories = () => send('categories', store.listCategories().map(publicCategory));
  const onSettings = () => send('settings', { enabled: aiEnabled(), hasKey: Boolean(settings.apiKey), model: settings.model });
  store.events.on('item', onItem);
  store.events.on('sorted', onSorted);
  store.events.on('deleted', onDeleted);
  store.events.on('categories', onCategories);
  store.events.on('settings', onSettings);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    store.events.off('item', onItem);
    store.events.off('sorted', onSorted);
    store.events.off('deleted', onDeleted);
    store.events.off('categories', onCategories);
    store.events.off('settings', onSettings);
  });
});

app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

/** Starts the library. Port 0 picks any free port. */
export function startServer({ port, host = '127.0.0.1', fallbackToAnyPort = false }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resumePending();
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
      resolve({ server, url });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && fallbackToAnyPort && port !== 0) resolve(startServer({ port: 0, host }));
      else reject(err);
    });
  });
}
