// Library — front end. No framework: a masonry grid, a viewer, and live updates
// from the server as things get sorted.

const main = document.getElementById('main');
const searchInput = document.getElementById('search');
const viewerEl = document.getElementById('viewer');
const toastsEl = document.getElementById('toasts');

const state = {
  items: new Map(),
  categories: [],
  ai: { enabled: true },
  query: '',
  previews: new Map(), // local object URLs shown while an upload is being sorted
  viewer: null, // { id, ids }
};

// ---------- tiny DOM helper (text is always set as text, never HTML) ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

const KIND_LABEL = { image: 'Image', font: 'Font', pdf: 'PDF', video: 'Video', link: 'Link', note: 'Note', file: 'File' };

// ---------- routing ----------

function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (hash === 'folders') return { view: 'folders' };
  if (hash.startsWith('f/')) return { view: 'folder', name: hash.slice(2) };
  return { view: 'all' };
}

const folderHref = (name) => `#/f/${encodeURIComponent(name)}`;

// ---------- data ----------

function counts() {
  const map = new Map();
  for (const item of state.items.values()) if (item.category) map.set(item.category, (map.get(item.category) || 0) + 1);
  return map;
}

// Fonts can hold subfolders: "Fonts/Serif" is shown as "Serif" inside Fonts, and "Fonts › Serif" elsewhere.
const labelOf = (cat) => cat.label || cat.name;
const displayPath = (name) => (name || '').split('/').join(' › ');
const findCat = (name) => state.categories.find((c) => c.name === name);
const subfoldersOf = (name) => state.categories.filter((c) => c.parent === name).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
const inFolder = (item, name) => item.category === name || item.category?.startsWith(`${name}/`);

/** Items in a folder, including its subfolders. */
function totalIn(name, c = counts()) {
  return [...c].reduce((n, [cat, k]) => n + (cat === name || cat.startsWith(`${name}/`) ? k : 0), 0);
}

/** <option>s for every folder, subfolders listed under their parent. */
function folderOptions(selected) {
  const top = state.categories.filter((c) => !c.parent).sort((a, b) => a.name.localeCompare(b.name));
  return top.flatMap((c) => [
    el('option', { value: c.name, selected: c.name === selected }, c.name),
    ...subfoldersOf(c.name).map((sub) => el('option', { value: sub.name, selected: sub.name === selected }, `${c.name} › ${labelOf(sub)}`)),
  ]);
}

function sortedItems() {
  return [...state.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function matches(item, terms) {
  if (!terms.length) return true;
  const hay = [item.title, item.description, item.category, item.originalName, item.site, item.url, item.fontFamily, item.kind, ...(item.tags || []), item.text?.slice(0, 2000)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function visibleItems(r = route()) {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  return sortedItems().filter((i) => (r.view !== 'folder' || inFolder(i, r.name)) && matches(i, terms));
}

// ---------- tiles ----------

const tileCache = new Map();
const loadedFonts = new Set();

function ensureFont(item) {
  const family = `lib-${item.id}`;
  if (!loadedFonts.has(item.id) && item.src) {
    loadedFonts.add(item.id);
    new FontFace(family, `url("${item.src}")`)
      .load()
      .then((f) => document.fonts.add(f))
      .catch(() => {});
  }
  return `"${family}", var(--font)`;
}

function ratioOf(item) {
  if (item.width && item.height) return Math.min(2.4, Math.max(0.45, item.height / item.width));
  return { font: 1, note: 1.15, pdf: 1.3, video: 0.5625, link: 0.75, file: 1 }[item.kind] || 1;
}

function imageFor(item) {
  if (item.kind === 'image' && item.ext === '.gif' && item.status === 'ready') return item.src;
  return item.thumbSrc || state.previews.get(item.id) || null;
}

function tileMedia(item) {
  const img = imageFor(item);
  const bg = item.colors?.[0];
  if (img) {
    return el('img', { src: img, alt: item.title || '', loading: 'lazy', decoding: 'async', style: { objectPosition: ratioOf(item) >= 2.4 ? 'top' : 'center', background: bg || '' } });
  }
  if (item.kind === 'video' && item.src) {
    const v = el('video', { src: item.src, muted: true, loop: true, playsInline: true, preload: 'metadata' });
    v.addEventListener('loadedmetadata', () => {
      if (v.videoWidth) v.parentElement.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
    });
    return v;
  }
  if (item.kind === 'font') {
    return el(
      'div',
      { class: 'card font', style: { fontFamily: ensureFont(item) } },
      el('div', { class: 'kind font-name' }, item.title || 'Font'),
      el('div', { class: 'aa' }, 'Aa'),
      el('div', { class: 'glyphs' }, 'ABCDEFGHIJKLM abcdefghijklm 0123456789'),
    );
  }
  if (item.kind === 'note') {
    return el('div', { class: 'card note' }, el('div', { class: 'body' }, item.text || item.title), el('div', { class: 'kind' }, 'Note'));
  }
  if (item.kind === 'link') {
    return el('div', { class: 'card' }, el('div', { class: 'kind' }, 'Link'), el('div', { class: 'name' }, item.title), el('div', { class: 'host' }, item.site || ''));
  }
  return el(
    'div',
    { class: 'card file' },
    el('div', { class: 'kind' }, KIND_LABEL[item.kind] || 'File'),
    el('div', { class: 'ext' }, (item.ext || '').slice(1).toUpperCase() || '?'),
    el('div', { class: 'name' }, item.title || item.originalName || ''),
  );
}

function buildTile(item) {
  const media = el('div', { class: 'media', style: { aspectRatio: `1 / ${ratioOf(item)}` } }, tileMedia(item));

  const tile = el(
    'div',
    {
      class: `tile ${item.status}`,
      tabIndex: 0,
      role: 'button',
      'aria-label': item.title || 'Item',
      'data-id': item.id,
      draggable: item.status !== 'processing',
      onclick: () => openViewer(item.id),
      onkeydown: (e) => e.key === 'Enter' && openViewer(item.id),
      ondragstart: (e) => {
        e.dataTransfer.setData(ITEM_DRAG, item.id);
        e.dataTransfer.effectAllowed = 'move';
        document.body.classList.add('dragging-item');
      },
      ondragend: () => document.body.classList.remove('dragging-item'),
    },
    media,
  );
  // Let the tile itself be dragged, not the picture inside it.
  tile.querySelectorAll('img').forEach((img) => (img.draggable = false));

  if (item.kind === 'link' && imageFor(item)) {
    tile.append(el('div', { class: 'link-caption' }, el('b', {}, item.title), el('small', {}, item.site || '')));
  }
  if (item.kind === 'video') {
    tile.addEventListener('mouseenter', () => tile.querySelector('video')?.play().catch(() => {}));
    tile.addEventListener('mouseleave', () => tile.querySelector('video')?.pause());
  }

  if (item.status === 'processing') tile.append(el('span', { class: 'badge' }, 'Sorting…'));
  else if (item.status === 'error') tile.append(el('span', { class: 'badge' }, 'Couldn’t sort'));
  else tile.append(el('div', { class: 'meta' }, el('b', {}, item.title || 'Untitled'), el('small', {}, displayPath(item.category))));
  return tile;
}

function tileFor(item) {
  const sig = [item.status, item.thumbSrc, item.src, item.title, item.category, state.previews.has(item.id)].join('|');
  const cached = tileCache.get(item.id);
  if (cached && cached.sig === sig) return cached.node;
  const node = buildTile(item);
  tileCache.set(item.id, { sig, node });
  return node;
}

// ---------- masonry grid with incremental loading ----------

const PAGE = 90;
let grid = null;
let gridObserver = null;

function columnCount(width) {
  if (width < 520) return 2;
  return Math.max(2, Math.min(7, Math.floor((width + 14) / 270)));
}

function renderGrid(items, keepShown) {
  const container = el('div', { class: 'grid' });
  const width = main.clientWidth - parseFloat(getComputedStyle(main).paddingLeft) * 2;
  const n = columnCount(width);
  const cols = Array.from({ length: n }, () => el('div', { class: 'col' }));
  container.append(...cols);
  grid = { items, cols, heights: new Array(n).fill(0), shown: 0 };
  addToGrid(Math.max(PAGE, keepShown || 0));

  const sentinel = el('div', { class: 'sentinel' });
  gridObserver?.disconnect();
  gridObserver = new IntersectionObserver((entries) => entries[0].isIntersecting && addToGrid(PAGE), { rootMargin: '1200px' });
  requestAnimationFrame(() => gridObserver.observe(sentinel));
  return el('div', {}, container, sentinel);
}

function addToGrid(count) {
  if (!grid) return;
  const end = Math.min(grid.items.length, grid.shown + count);
  for (let i = grid.shown; i < end; i++) {
    const item = grid.items[i];
    const c = grid.heights.indexOf(Math.min(...grid.heights));
    grid.cols[c].append(tileFor(item));
    grid.heights[c] += ratioOf(item) + (item.kind === 'link' && imageFor(item) ? 0.2 : 0) + 0.06;
  }
  grid.shown = end;
}

// ---------- views ----------

/** Dropping a tile onto a folder chip moves it there. */
const ITEM_DRAG = 'application/x-library-item';

function dropTarget(node, folderName) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(ITEM_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop-here');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-here'));
  node.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes(ITEM_DRAG)) return;
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove('drop-here');
    const id = e.dataTransfer.getData(ITEM_DRAG);
    if (!id || state.items.get(id)?.category === folderName) return;
    try {
      await api(`/api/items/${id}`, { method: 'PATCH', body: { category: folderName } });
      toast(`Moved to ${displayPath(folderName)}`);
    } catch (err) {
      toast(err.message);
    }
  });
  return node;
}

function chipsRow(active) {
  const c = counts();
  const total = state.items.size;
  const top = active?.split('/')[0];
  const cats = state.categories
    .filter((cat) => !cat.parent)
    .sort((a, b) => (a.name === 'Unsorted') - (b.name === 'Unsorted') || a.name.localeCompare(b.name));
  return el(
    'div',
    { class: 'chips' },
    el('a', { class: `chip ${active ? '' : 'on'}`, href: '#/' }, 'Everything', el('span', {}, total)),
    cats.map((cat) => dropTarget(el('a', { class: `chip ${top === cat.name ? 'on' : ''}`, href: folderHref(cat.name) }, cat.name, el('span', {}, totalIn(cat.name, c))), cat.name)),
  );
}

/** Inside Fonts: a row for its subfolders. Drag fonts onto them to arrange. */
function subfolderRow(parent, active) {
  const c = counts();
  return el(
    'div',
    { class: 'chips subchips' },
    dropTarget(el('a', { class: `chip ${active === parent.name ? 'on' : ''}`, href: folderHref(parent.name) }, `All ${parent.name.toLowerCase()}`, el('span', {}, totalIn(parent.name, c))), parent.name),
    subfoldersOf(parent.name).map((sub) =>
      dropTarget(el('a', { class: `chip ${active === sub.name ? 'on' : ''}`, href: folderHref(sub.name) }, labelOf(sub), el('span', {}, c.get(sub.name) || 0)), sub.name),
    ),
    el('button', { class: 'chip ghost', onclick: () => newSubfolder(parent) }, '+ Subfolder'),
  );
}

function emptyLibrary() {
  return el(
    'div',
    { class: 'empty' },
    el('h1', {}, 'Drop anything here.'),
    el(
      'p',
      {},
      state.ai.enabled
        ? 'Posters, patterns, 3D renders, fonts, PDFs, links. Paste, drop or add them and each one is sorted into the right folder for you. New folders appear as your collection grows.'
        : 'Posters, patterns, 3D renders, fonts, PDFs, links. Paste, drop or add them and pick a folder. Turn on auto-sorting in Settings to have Claude file them for you.',
    ),
    el(
      'div',
      { class: 'hint' },
      el('button', { class: 'pill', onclick: () => openAddDialog() }, 'Choose files'),
      el('span', { class: 'pill' }, 'or paste ', el('kbd', {}, navigator.platform.includes('Mac') ? '⌘V' : 'Ctrl V')),
    ),
  );
}

function folderHeading(cat, n) {
  const parent = cat.parent && findCat(cat.parent);
  const tools = el(
    'div',
    { class: 'tools' },
    !cat.permanent && el('button', { class: 'pill', onclick: () => renameFolder(cat) }, 'Rename'),
    el('button', { class: 'pill', onclick: () => describeFolder(cat) }, cat.description ? 'Edit description' : 'Add description'),
    cat.permanent && el('button', { class: 'pill', onclick: () => newSubfolder(cat) }, 'New subfolder'),
    !cat.permanent && n === 0 && !subfoldersOf(cat.name).length && el('button', { class: 'pill danger', onclick: () => deleteFolder(cat) }, 'Delete folder'),
  );
  const hint = cat.permanent && subfoldersOf(cat.name).length ? 'Drag a font onto a subfolder below to move it there.' : '';
  return el(
    'div',
    { class: 'heading' },
    parent && el('a', { class: 'crumb', href: folderHref(parent.name) }, `← ${parent.name}`),
    el('h1', {}, labelOf(cat)),
    el('p', {}, [cat.description, plural(n, 'item'), hint].filter(Boolean).join(' · ')),
    tools,
  );
}

function foldersView() {
  const c = counts();
  const latestBy = new Map();
  const previews = new Map();
  for (const item of sortedItems()) {
    if (!item.category) continue;
    const top = item.category.split('/')[0];
    if (!latestBy.has(top)) latestBy.set(top, item.createdAt);
    const list = previews.get(top) || [];
    if (list.length < 4 && imageFor(item)) list.push(imageFor(item));
    previews.set(top, list);
  }
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const cats = state.categories
    .filter((cat) => !cat.parent)
    .filter((cat) => terms.every((t) => `${cat.name} ${cat.description}`.toLowerCase().includes(t)))
    .sort((a, b) => (latestBy.get(b.name) || b.createdAt).localeCompare(latestBy.get(a.name) || a.createdAt));

  if (!cats.length) {
    return el(
      'div',
      { class: 'quiet' },
      el('p', {}, state.categories.length ? 'No folders match.' : 'No folders yet.'),
      !state.categories.length && el('button', { class: 'pill', onclick: newFolder }, 'New folder'),
    );
  }

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'heading' },
      el('h1', {}, 'Folders'),
      el('p', {}, plural(state.categories.filter((cat) => !cat.parent).length, 'folder')),
      el('div', { class: 'tools' }, el('button', { class: 'pill', onclick: newFolder }, 'New folder')),
    ),
    el(
      'div',
      { class: 'folders' },
      cats.map((cat) => {
        const imgs = previews.get(cat.name) || [];
        const cls = ['', 'one', 'two', 'three', ''][imgs.length];
        const collage = el(
          'div',
          { class: `collage ${cls}` },
          imgs.length
            ? imgs.map((src) => el('div', { style: { backgroundImage: `url("${src}")` } }))
            : el('div', { class: 'glyph', style: { gridColumn: '1 / -1', gridRow: '1 / -1' } }, cat.name === 'Fonts' ? 'Aa' : cat.name[0]),
        );
        const subs = subfoldersOf(cat.name).length;
        return el(
          'a',
          { class: 'folder', href: folderHref(cat.name) },
          collage,
          el('h3', {}, cat.name),
          el('p', {}, [plural(totalIn(cat.name, c), 'item'), subs && plural(subs, 'subfolder')].filter(Boolean).join(' · ')),
        );
      }),
    ),
  );
}

let lastRouteKey = '';

function render() {
  const r = route();
  document.querySelector('[data-nav="folders"]').classList.toggle('on', r.view === 'folders');
  const routeKey = `${r.view}|${r.name || ''}|${state.query}`;
  const keepShown = routeKey === lastRouteKey ? grid?.shown : 0;
  if (routeKey !== lastRouteKey) window.scrollTo(0, 0);
  lastRouteKey = routeKey;

  const frag = [];
  if (r.view === 'folders') {
    grid = null;
    frag.push(foldersView());
  } else if (!state.items.size && r.view !== 'folder') {
    grid = null;
    frag.push(emptyLibrary());
  } else {
    frag.push(chipsRow(r.view === 'folder' ? r.name : null));
    const items = visibleItems(r);
    if (r.view === 'folder') {
      const cat = findCat(r.name);
      if (!cat) {
        location.hash = '#/';
        return;
      }
      frag.push(folderHeading(cat, totalIn(cat.name)));
      const parent = cat.permanent ? cat : cat.parent && findCat(cat.parent);
      if (parent?.permanent) frag.push(subfolderRow(parent, cat.name));
    }
    if (state.query) frag.push(el('div', { class: 'quiet', style: { padding: '0 0 18px', textAlign: 'left' } }, `${plural(items.length, 'result')} for “${state.query}”`));
    if (items.length) frag.push(renderGrid(items, keepShown));
    else if (!state.query) frag.push(el('div', { class: 'quiet' }, 'Nothing in here yet.'));
    else grid = null;
  }
  main.replaceChildren(...frag);
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 60);
}

let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (Math.abs(window.innerWidth - lastWidth) > 40) {
    lastWidth = window.innerWidth;
    scheduleRender();
  }
});

// ---------- folder actions ----------

async function newFolder() {
  const name = prompt('New folder name');
  if (!name?.trim()) return;
  try {
    const { category } = await api('/api/categories', { method: 'POST', body: { name } });
    await refresh();
    location.hash = folderHref(category.name);
  } catch (e) {
    toast(e.message);
  }
}

async function newSubfolder(parent) {
  const name = prompt(`New subfolder in ${parent.name}`);
  if (!name?.trim()) return;
  try {
    const { category } = await api('/api/categories', { method: 'POST', body: { name, parent: parent.name } });
    await refresh();
    location.hash = folderHref(category.name);
  } catch (e) {
    toast(e.message);
  }
}

async function renameFolder(cat) {
  const name = prompt('Rename folder (use the name of another folder to merge into it)', labelOf(cat));
  if (!name || name.trim() === labelOf(cat)) return;
  try {
    const { category } = await api(`/api/categories/${encodeURIComponent(cat.name)}`, { method: 'PATCH', body: { name } });
    await refresh();
    location.hash = folderHref(category.name);
  } catch (e) {
    toast(e.message);
  }
}

async function describeFolder(cat) {
  const description = prompt('What belongs in this folder? (Claude uses this when sorting)', cat.description || '');
  if (description == null) return;
  try {
    await api(`/api/categories/${encodeURIComponent(cat.name)}`, { method: 'PATCH', body: { description } });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function deleteFolder(cat) {
  try {
    await api(`/api/categories/${encodeURIComponent(cat.name)}`, { method: 'DELETE' });
    location.hash = cat.parent ? folderHref(cat.parent) : '#/folders';
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- viewer ----------

function openViewer(id) {
  const ids = (grid?.items || visibleItems()).map((i) => i.id);
  state.viewer = { id, ids };
  viewerEl.hidden = false;
  document.body.style.overflow = 'hidden';
  renderViewer();
}

function closeViewer() {
  state.viewer = null;
  viewerEl.hidden = true;
  document.body.style.overflow = '';
  // Forget what was shown too, or reopening the same item would leave the stage empty.
  const stage = viewerEl.querySelector('.viewer-stage');
  stage.replaceChildren();
  delete stage.dataset.id;
  delete stage.dataset.status;
}

function stepViewer(dir) {
  if (!state.viewer) return;
  const { ids, id } = state.viewer;
  const i = ids.indexOf(id);
  const next = ids[(i + dir + ids.length) % ids.length];
  if (next && next !== id) {
    state.viewer.id = next;
    renderViewer();
  }
}

function stageFor(item) {
  if (item.kind === 'image') return el('img', { src: item.status === 'ready' ? item.src : imageFor(item) || item.src, alt: item.title || '', onerror: (e) => item.thumbSrc && (e.target.src = item.thumbSrc) });
  if (item.kind === 'video') return el('video', { src: item.src, controls: true, autoplay: true, loop: true, playsInline: true });
  if (item.kind === 'pdf') return el('iframe', { src: item.src, title: item.title });
  if (item.kind === 'link' && item.thumbSrc) return el('a', { href: item.url, target: '_blank', rel: 'noopener' }, el('img', { src: item.thumbSrc, alt: item.title || '' }));
  if (item.kind === 'font') {
    const family = ensureFont(item);
    return el(
      'div',
      { class: 'specimen', style: { fontFamily: family } },
      el('p', { class: 'big' }, 'Aa Gg Rr'),
      el('p', { class: 'row' }, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      el('p', { class: 'row' }, 'abcdefghijklmnopqrstuvwxyz'),
      el('p', { class: 'row' }, '0123456789 !?&@#%(){}'),
      el('textarea', { rows: 2, style: { fontFamily: family }, value: 'The quick brown fox jumps over the lazy dog', 'aria-label': 'Type to preview' }),
    );
  }
  if (item.kind === 'note') {
    const box = el('div', { class: 'note-view' }, item.text || '');
    if (item.src) fetch(item.src).then((r) => r.text()).then((t) => (box.textContent = t)).catch(() => {});
    return box;
  }
  if (item.kind === 'link') return el('div', { class: 'file-view' }, el('div', { class: 'ext' }, item.site || 'Link'), el('p', {}, item.title));
  return el('div', { class: 'file-view' }, el('div', { class: 'ext' }, (item.ext || '').slice(1).toUpperCase() || 'FILE'), el('p', {}, item.originalName || item.title));
}

function whyText(item) {
  if (item.status === 'processing') return 'Sorting…';
  if (item.status === 'error' || item.error) return item.error || 'Something went wrong.';
  if (item.sortedBy === 'fallback') return 'Waiting for a folder. Pick one above.';
  if (item.kind === 'font' && item.sortedBy === 'rule') return item.category?.includes('/') ? 'Placed by the type stored in the font file' : 'Its type is unknown. Pick a subfolder above.';
  return { ai: 'Sorted by Claude', rule: `${KIND_LABEL[item.kind] || 'Files'}s always go here`, you: 'Put here by you' }[item.sortedBy] || '';
}

function renderViewer() {
  const item = state.items.get(state.viewer?.id);
  if (!item) return closeViewer();
  const stage = viewerEl.querySelector('.viewer-stage');
  if (stage.dataset.id !== item.id || stage.dataset.status !== item.status) {
    stage.replaceChildren(stageFor(item));
    stage.dataset.id = item.id;
    stage.dataset.status = item.status;
  }
  viewerEl.querySelectorAll('.viewer-nav').forEach((b) => (b.hidden = state.viewer.ids.length < 2));

  const select = el(
    'select',
    {
      'aria-label': 'Folder',
      disabled: item.status === 'processing',
      onchange: async (e) => {
        let category = e.target.value;
        if (category === '__new') {
          category = prompt('New folder name');
          if (!category) return renderViewer();
        }
        try {
          await api(`/api/items/${item.id}`, { method: 'PATCH', body: { category } });
          toast(`Moved to ${displayPath(category)}`);
        } catch (err) {
          toast(err.message);
        }
      },
    },
    !item.category && el('option', { value: '', selected: true }, 'Sorting…'),
    folderOptions(item.category),
    el('option', { value: '__new' }, '+ New folder…'),
  );

  const title = el('textarea', {
    class: 'title',
    rows: 1,
    value: item.title || '',
    'aria-label': 'Title',
    onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), e.target.blur()),
    onblur: (e) => {
      const v = e.target.value.trim();
      if (v && v !== item.title) api(`/api/items/${item.id}`, { method: 'PATCH', body: { title: v } }).catch((err) => toast(err.message));
    },
  });

  const facts = [
    ['Type', KIND_LABEL[item.kind] || 'File'],
    item.fontFamily && ['Family', [item.fontFamily, item.fontStyle].filter(Boolean).join(' · ')],
    item.width && ['Size', `${item.width} × ${item.height}`],
    item.size && ['File size', formatBytes(item.size)],
    item.url && ['Source', el('a', { href: item.url, target: '_blank', rel: 'noopener', style: { textDecoration: 'underline' } }, item.site || item.url)],
    ['Added', new Date(item.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })],
    item.file && ['On disk', item.file],
  ].filter(Boolean);

  const why = whyText(item);
  const panel = viewerEl.querySelector('.viewer-panel');
  panel.replaceChildren();
  panel.append(
    el(
      'div',
      { style: { display: 'contents' } },
    el('div', { class: 'field' }, el('label', {}, 'Folder'), select, why && el('div', { class: `why ${item.error || item.status === 'error' ? 'err' : ''}` }, why)),
    el('div', {}, title, item.description && el('p', { class: 'desc' }, item.description)),
    item.tags?.length > 0 &&
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Tags'),
        el('div', { class: 'tags' }, item.tags.map((t) => el('button', { class: 'tag', onclick: () => searchFor(t) }, t))),
      ),
    item.colors?.length > 0 &&
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Colors'),
        el(
          'div',
          { class: 'swatches' },
          item.colors.map((c) =>
            el('button', {
              class: 'swatch',
              title: c,
              style: { background: c },
              onclick: () => navigator.clipboard?.writeText(c).then(() => toast(`Copied ${c}`)),
            }),
          ),
        ),
      ),
    el('dl', { class: 'facts' }, facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    el(
      'div',
      { class: 'buttons' },
      item.url
        ? el('a', { class: 'pill', href: item.url, target: '_blank', rel: 'noopener' }, 'Visit page')
        : item.src && el('a', { class: 'pill', href: item.src, target: '_blank', rel: 'noopener' }, 'Open original'),
      window.desktop
        ? item.file && el('button', { class: 'pill', onclick: () => window.desktop.showItem(item.file) }, window.desktop.platform === 'darwin' ? 'Show in Finder' : 'Show in folder')
        : item.src && item.kind !== 'link' && el('a', { class: 'pill', href: item.src, download: item.originalName || '' }, 'Download'),
      (state.ai.enabled || item.kind === 'font') &&
      el(
        'button',
        {
          class: 'pill',
          title: 'Ask Claude to pick the folder again',
          disabled: item.status === 'processing',
          onclick: () => api(`/api/items/${item.id}/resort`, { method: 'POST' }).catch((e) => toast(e.message)),
        },
        'Re-sort',
      ),
      el(
        'button',
        {
          class: 'pill danger',
          onclick: async () => {
            if (!confirm('Delete this from your library? The file is removed from disk too.')) return;
            const { ids } = state.viewer;
            const i = ids.indexOf(item.id);
            await api(`/api/items/${item.id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
            state.viewer.ids = ids.filter((x) => x !== item.id);
            if (state.viewer.ids.length) {
              state.viewer.id = state.viewer.ids[Math.min(i, state.viewer.ids.length - 1)];
              renderViewer();
            } else closeViewer();
          },
        },
        'Delete',
      ),
    ),
    ),
  );
}

viewerEl.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act || (act.classList.contains('viewer-stage') && e.target !== act)) return;
  if (act.dataset.act === 'close') closeViewer();
  if (act.dataset.act === 'prev') stepViewer(-1);
  if (act.dataset.act === 'next') stepViewer(1);
});

function searchFor(text) {
  closeViewer();
  searchInput.value = text;
  state.query = text;
  if (route().view === 'folders') location.hash = '#/';
  render();
}

// ---------- toasts ----------

function toast(content, { thumb, badge, action, duration = 3200 } = {}) {
  const node = el('div', { class: 'toast' }, thumb && el('img', { src: thumb, alt: '' }), el('span', {}, content), badge && el('span', { class: 'new' }, badge), action && el('button', { onclick: action.run }, action.label));
  toastsEl.append(node);
  while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
  const remove = () => {
    node.classList.add('leave');
    setTimeout(() => node.remove(), 260);
  };
  if (duration) setTimeout(remove, duration);
  return { remove, set: (text) => (node.querySelector('span').textContent = text) };
}

// ---------- sheets (the Add and Settings dialogs) ----------

let openSheetState = null;

function openSheet(title, body, { onClose } = {}) {
  closeSheet();
  const sheet = el(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'sheet-head' }, el('h2', {}, title), el('button', { class: 'round ghost small', 'aria-label': 'Close', onclick: () => closeSheet() }, closeIcon())),
    body,
  );
  const backdrop = el('div', { class: 'sheet-backdrop', onmousedown: (e) => e.target === backdrop && closeSheet() }, sheet);
  document.body.append(backdrop);
  openSheetState = { backdrop, onClose };
  return sheet;
}

function closeSheet() {
  if (!openSheetState) return;
  const { backdrop, onClose } = openSheetState;
  openSheetState = null;
  backdrop.remove();
  onClose?.();
}

function closeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = '<path d="M6 6l12 12M18 6 6 18"/>';
  return svg;
}

// ---------- adding things ----------

const isImageFile = (f) => f.type.startsWith('image/') && !f.type.includes('heic');
const AUTO = '__auto';
const NEW = '__new';

/** `category` is the folder you picked; leave it out to let Claude sort. */
async function uploadFiles(fileList, category) {
  const files = [...fileList];
  if (!files.length) return;
  const t = toast(`Adding ${plural(files.length, 'thing')}…`, { duration: 0 });
  let dupes = 0;
  try {
    for (let i = 0; i < files.length; i += 12) {
      const chunk = files.slice(i, i + 12);
      const fd = new FormData();
      if (category) fd.append('category', category);
      chunk.forEach((f, j) => fd.append('files', f, f.name || `pasted-${Date.now()}-${j}.png`));
      const { results } = await api('/api/upload', { method: 'POST', body: fd });
      results.forEach(({ item, duplicate }, j) => {
        if (duplicate) return dupes++;
        if (isImageFile(chunk[j]) && !(state.items.get(item.id) || item).thumbSrc) state.previews.set(item.id, URL.createObjectURL(chunk[j]));
        // Live updates may already have delivered a newer (even sorted) version of this item.
        if (!state.items.has(item.id)) state.items.set(item.id, item);
      });
      if (route().view === 'folders') location.hash = category ? folderHref(category) : '#/';
      scheduleRender();
    }
    if (dupes) toast(dupes === files.length ? 'Already in your library' : `${plural(dupes, 'duplicate')} skipped`);
  } catch (e) {
    toast(`Upload failed: ${e.message}`);
  } finally {
    t.remove();
  }
}

async function addText(text, category) {
  const value = text.trim();
  if (!value) return;
  const isUrl = /^https?:\/\/\S+$/i.test(value);
  const t = toast(isUrl ? 'Saving link…' : 'Saving note…', { duration: 0 });
  try {
    const { results } = await api('/api/paste', { method: 'POST', body: { text: value, category } });
    const { item, duplicate } = results[0];
    if (duplicate) toast('Already in your library');
    else if (!state.items.has(item.id)) state.items.set(item.id, item);
    if (route().view === 'folders') location.hash = category ? folderHref(category) : '#/';
    scheduleRender();
  } catch (e) {
    toast(e.message);
  } finally {
    t.remove();
  }
}

/**
 * Pasting or dropping straight onto the page:
 * inside a folder it goes into that folder, otherwise Claude sorts it,
 * and with auto-sorting off you're asked which folder.
 */
function quickAdd({ files, text }) {
  if (addDialog) return addDialog.stage({ files, text });
  const r = route();
  if (r.view === 'folder') return files ? uploadFiles(files, r.name) : addText(text, r.name);
  if (state.ai.enabled) return files ? uploadFiles(files) : addText(text);
  openAddDialog({ files, text });
}

let addDialog = null;

function openAddDialog({ files = [], text = '' } = {}) {
  const staged = [];
  const urls = [];
  const r = route();
  let lastFolder = null;
  try {
    lastFolder = localStorage.getItem('lastFolder');
  } catch {}

  const list = el('div', { class: 'staged' });
  const linkInput = el('input', { class: 'field-input', type: 'text', placeholder: 'Or paste a link or a note', value: text || '', oninput: update });
  const newFolderInput = el('input', { class: 'field-input', type: 'text', placeholder: 'New folder name', hidden: true, oninput: update });
  const addButton = el('button', { class: 'pill solid', onclick: submit }, 'Add');
  const filePicker = el('input', { type: 'file', multiple: true, hidden: true, onchange: () => (stage({ files: filePicker.files }), (filePicker.value = '')) });

  const defaultTarget =
    r.view === 'folder' ? r.name : state.ai.enabled ? AUTO : findCat(lastFolder) ? lastFolder : state.categories.length ? state.categories[0].name : NEW;
  const select = el(
    'select',
    { class: 'field-input', 'aria-label': 'Folder', onchange: update },
    el('option', { value: AUTO, disabled: !state.ai.enabled, selected: defaultTarget === AUTO }, state.ai.enabled ? '✦ Sort automatically' : '✦ Sort automatically (turn on in Settings)'),
    folderOptions(defaultTarget),
    el('option', { value: NEW, selected: defaultTarget === NEW }, '+ New folder…'),
  );

  const drop = el(
    'button',
    { class: 'dropzone', onclick: () => filePicker.click() },
    el('b', {}, 'Choose files'),
    el('span', {}, ' or drop them here'),
  );

  function stage({ files: more, text: moreText }) {
    for (const f of more || []) {
      staged.push(f);
      urls.push(isImageFile(f) ? URL.createObjectURL(f) : null);
    }
    if (moreText && !linkInput.value.trim()) linkInput.value = moreText;
    renderStaged();
    update();
  }

  function renderStaged() {
    list.replaceChildren(
      ...staged.map((f, i) =>
        el(
          'div',
          { class: 'staged-item', title: f.name },
          urls[i] ? el('img', { src: urls[i], alt: '' }) : el('span', {}, (f.name.split('.').pop() || 'file').slice(0, 5).toUpperCase()),
          el('button', { class: 'remove', 'aria-label': `Remove ${f.name}`, onclick: () => (staged.splice(i, 1), urls.splice(i, 1), renderStaged(), update()) }, '×'),
        ),
      ),
    );
    list.hidden = !staged.length;
  }

  function target() {
    if (select.value === AUTO) return undefined;
    if (select.value === NEW) return newFolderInput.value.trim();
    return select.value;
  }

  function update() {
    newFolderInput.hidden = select.value !== NEW;
    const n = staged.length + (linkInput.value.trim() ? 1 : 0);
    addButton.textContent = n ? `Add ${plural(n, 'item')}` : 'Add';
    addButton.disabled = !n || (select.value === NEW && !newFolderInput.value.trim());
  }

  function submit() {
    const category = target();
    const files = [...staged];
    const link = linkInput.value.trim();
    if (category) {
      try {
        localStorage.setItem('lastFolder', category);
      } catch {}
    }
    closeSheet();
    if (files.length) uploadFiles(files, category);
    if (link) addText(link, category);
  }

  const body = el(
    'div',
    { class: 'sheet-body' },
    drop,
    filePicker,
    list,
    linkInput,
    el('div', { class: 'field' }, el('label', {}, 'Put it in'), select, newFolderInput),
    el('div', { class: 'sheet-actions' }, el('button', { class: 'pill', onclick: () => closeSheet() }, 'Cancel'), addButton),
  );

  openSheet('Add to library', body, {
    onClose: () => {
      urls.forEach((u) => u && URL.revokeObjectURL(u));
      addDialog = null;
    },
  });
  addDialog = { stage };
  stage({ files, text });
  if (select.value === NEW) newFolderInput.focus();
}

// ---------- settings ----------

async function openSettings() {
  let s;
  try {
    s = await api('/api/settings');
  } catch (e) {
    return toast(e.message);
  }
  const keyInput = el('input', { class: 'field-input', type: 'password', placeholder: s.hasKey ? `Saved key ${s.keyHint} — paste a new one to replace it` : 'sk-ant-…', autocomplete: 'off', spellcheck: false });
  const autoSort = el('input', { type: 'checkbox', checked: s.autoSort });
  const model = el('select', { class: 'field-input' }, s.models.map((m) => el('option', { value: m.id, selected: m.id === s.model }, m.label)));
  const error = el('p', { class: 'form-error', hidden: true });
  const saveButton = el('button', { class: 'pill solid', onclick: () => save() }, 'Save');

  async function save(extra = {}) {
    error.hidden = true;
    saveButton.disabled = true;
    saveButton.textContent = keyInput.value.trim() ? 'Checking key…' : 'Saving…';
    try {
      const body = { autoSort: autoSort.checked, model: model.value, ...extra };
      if (keyInput.value.trim()) body.apiKey = keyInput.value.trim();
      const { ai } = await api('/api/settings', { method: 'PUT', body });
      state.ai = ai;
      closeSheet();
      toast(ai.enabled ? 'Auto-sorting is on' : ai.hasKey ? 'Auto-sorting is off' : 'Saved. You choose folders yourself');
      render();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save';
    }
  }

  const desktop = window.desktop;
  const themes = [
    ['system', 'System'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];
  const themeButtons = themes.map(([value, label]) =>
    el('button', { class: value === s.theme ? 'on' : '', 'data-theme-choice': value, onclick: () => chooseTheme(value) }, label),
  );
  async function chooseTheme(value) {
    applyTheme(value);
    themeButtons.forEach((b) => b.classList.toggle('on', b.dataset.themeChoice === value));
    try {
      await api('/api/settings', { method: 'PUT', body: { theme: value } });
    } catch (e) {
      toast(e.message);
    }
  }
  const body = el(
    'div',
    { class: 'sheet-body' },
    el('section', { class: 'settings-section' }, el('h3', {}, 'Appearance'), el('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' }, themeButtons)),
    el(
      'section',
      { class: 'settings-section' },
      el('h3', {}, 'Auto-sorting'),
      el(
        'p',
        { class: 'muted' },
        'Optional. With an Anthropic API key, Claude looks at everything you add and files it into a folder for you, making new folders when needed. It costs about a cent per image, paid to Anthropic. Without a key you pick the folder yourself.',
      ),
      el('label', { class: 'toggle' }, autoSort, el('span', {}, 'Sort new things automatically')),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'API key'),
        keyInput,
        el('div', { class: 'hint' }, 'Get one at ', el('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener' }, 'platform.claude.com'), '. It stays on this computer.'),
      ),
      s.hasKey && el('button', { class: 'pill danger', onclick: () => ((keyInput.value = ''), save({ apiKey: '' })) }, 'Remove saved key'),
      el('div', { class: 'field' }, el('label', {}, 'Model'), model),
    ),
    el(
      'section',
      { class: 'settings-section' },
      el('h3', {}, 'Library folder'),
      el('p', { class: 'path' }, s.libraryDir),
      desktop
        ? el(
            'div',
            { class: 'row' },
            el('button', { class: 'pill', onclick: () => desktop.openLibraryFolder() }, desktop.platform === 'darwin' ? 'Open in Finder' : 'Open folder'),
            el(
              'button',
              {
                class: 'pill',
                onclick: () => {
                  if (confirm('Point the app at a different folder? Your current folder stays where it is. Move it there first in Finder/Explorer if you want to keep using it. The app will restart.')) desktop.chooseLibraryFolder();
                },
              },
              'Change…',
            ),
          )
        : el('p', { class: 'hint' }, 'To store it somewhere else, set LIBRARY_DIR in .env and restart.'),
    ),
    el('p', { class: 'hint' }, `Magpie ${s.version}`),
    error,
    el('div', { class: 'sheet-actions' }, el('button', { class: 'pill', onclick: () => closeSheet() }, 'Cancel'), saveButton),
  );
  openSheet('Settings', body);
}

/** Light, Dark, or follow the system. The desktop window's frame follows along. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  window.desktop?.setTheme(theme);
}

// ---------- paste, drop, buttons ----------

const typingInField = (e) => e.target.closest?.('input, textarea, select, [contenteditable]');

document.addEventListener('paste', (e) => {
  if (typingInField(e)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    return quickAdd({ files });
  }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text) {
    e.preventDefault();
    quickAdd({ text });
  }
});

const dropEl = document.getElementById('drop');
let dragDepth = 0;
const isExternalDrag = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/html');
document.addEventListener('dragenter', (e) => {
  if (!isExternalDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  const r = route();
  dropEl.firstElementChild.textContent = r.view === 'folder' ? `Drop to add to ${r.name}` : 'Drop to add to your library';
  dropEl.hidden = Boolean(addDialog); // the Add dialog is its own drop target
});
document.addEventListener('dragover', (e) => isExternalDrag(e) && e.preventDefault());
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropEl.hidden = true;
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  const dt = e.dataTransfer;
  if (dt.types.includes(ITEM_DRAG)) return;
  if (dt.files?.length) return quickAdd({ files: [...dt.files] });
  // Dragged from another browser tab: prefer the actual image over the page link.
  const html = dt.getData('text/html');
  const imgSrc = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.src;
  const url = (imgSrc && /^https?:/.test(imgSrc) && imgSrc) || dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || dt.getData('text/plain');
  if (url) quickAdd({ text: url });
});

document.getElementById('add').addEventListener('click', () => openAddDialog());
document.getElementById('settings').addEventListener('click', () => openSettings());

// ---------- keyboard & search ----------

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim();
    render();
  }, 120);
});

document.addEventListener('keydown', (e) => {
  if (openSheetState) {
    if (e.key === 'Escape') closeSheet();
    return;
  }
  if (state.viewer && !typingInField(e)) {
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
    return;
  }
  if (e.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    state.query = '';
    searchInput.blur();
    render();
  }
  if (e.key === '/' && !typingInField(e)) {
    e.preventDefault();
    searchInput.focus();
  }
});

window.addEventListener('hashchange', () => {
  closeViewer();
  render();
});

// ---------- live updates ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('item', (e) => {
    const item = JSON.parse(e.data);
    state.items.set(item.id, item);
    if (item.thumbSrc && state.previews.has(item.id)) {
      // Keep the local preview until the real thumbnail has loaded, to avoid a flash.
      const img = new Image();
      img.onload = img.onerror = () => {
        URL.revokeObjectURL(state.previews.get(item.id));
        state.previews.delete(item.id);
        scheduleRender();
      };
      img.src = item.thumbSrc;
    }
    scheduleRender();
    if (state.viewer?.id === item.id) renderViewer();
  });
  es.addEventListener('sorted', (e) => {
    const { id, category, created, previous, by } = JSON.parse(e.data);
    const item = state.items.get(id);
    const thumb = item && imageFor(item);
    // Things you put somewhere yourself don't need announcing, unless you're elsewhere.
    if (by === 'you' && route().view === 'folder' && route().name === category) return;
    const verb = by === 'you' || by === 'fallback' ? 'Added to' : previous && previous === category ? 'Still belongs in' : 'Sorted into';
    toast(`${verb} ${displayPath(category)}`, {
      thumb,
      badge: created ? 'New folder' : null,
      action: { label: 'View', run: () => (location.hash = folderHref(category)) },
    });
  });
  es.addEventListener('deleted', (e) => {
    const { id } = JSON.parse(e.data);
    state.items.delete(id);
    tileCache.delete(id);
    scheduleRender();
  });
  es.addEventListener('settings', (e) => {
    state.ai = JSON.parse(e.data);
    render();
  });
  es.addEventListener('categories', (e) => {
    state.categories = JSON.parse(e.data);
    scheduleRender();
    if (state.viewer) renderViewer();
  });
  // Re-sync after the connection drops (e.g. the server restarted).
  let dropped = false;
  es.addEventListener('error', () => (dropped = true));
  es.addEventListener('open', () => dropped && refresh());
}

async function refresh() {
  const data = await api('/api/library');
  state.ai = data.ai;
  state.categories = data.categories;
  state.items = new Map(data.items.map((i) => [i.id, i]));
  render();
}

if (window.desktop) document.documentElement.classList.add('desktop', `os-${window.desktop.platform}`);
refresh().then(connectEvents);
