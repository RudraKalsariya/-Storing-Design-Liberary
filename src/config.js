import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (Node 20.12+ has this built in, no dotenv needed).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Settings you change inside the app (API key, model, auto-sort) are saved here.
// The desktop app points DATA_DIR at its own app-data folder.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const saved = readSaved();

export const settings = {
  apiKey: saved.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
  autoSort: saved.autoSort ?? true,
  model: saved.model || process.env.SORT_MODEL || 'claude-opus-5-5',
  effort: process.env.SORT_EFFORT ?? 'low',
  libraryDir: path.resolve(ROOT, saved.libraryDir || process.env.LIBRARY_DIR || 'library'),
};

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most accurate' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest' },
];

export function saveSettings(patch) {
  const next = { ...readSaved(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  for (const key of ['apiKey', 'autoSort', 'model']) if (key in patch) settings[key] = patch[key];
}

/** Claude sorts new things only when you've added a key and left auto-sort on. */
export const aiEnabled = () => Boolean(settings.autoSort && settings.apiKey);

export const PORT = Number(process.env.PORT || 4321);
export const HOST = process.env.HOST || '127.0.0.1';

// Where everything lives. Each category is a real folder in here, so the
// library is just as browsable in Finder / Explorer as it is in the app.
// Changing it takes effect the next time the app starts.
export const LIBRARY_DIR = settings.libraryDir;
export const INDEX_FILE = path.join(LIBRARY_DIR, '.library.json');
export const THUMBS_DIR = path.join(LIBRARY_DIR, '.thumbs');
export const INBOX_DIR = path.join(LIBRARY_DIR, '.inbox');

export const CONCURRENCY = Math.max(1, Number(process.env.SORT_CONCURRENCY || 3));

for (const dir of [LIBRARY_DIR, THUMBS_DIR, INBOX_DIR]) fs.mkdirSync(dir, { recursive: true });
