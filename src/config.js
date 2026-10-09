import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env if present (Node 20.12+ has this built in, no dotenv needed).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const PORT = Number(process.env.PORT || 4321);
export const HOST = process.env.HOST || '127.0.0.1';

// Where everything lives. Each category is a real folder in here, so the
// library is just as browsable in Finder / Explorer as it is in the app.
export const LIBRARY_DIR = path.resolve(ROOT, process.env.LIBRARY_DIR || 'library');
export const INDEX_FILE = path.join(LIBRARY_DIR, '.library.json');
export const THUMBS_DIR = path.join(LIBRARY_DIR, '.thumbs');
export const INBOX_DIR = path.join(LIBRARY_DIR, '.inbox');

export const MODEL = process.env.SORT_MODEL || 'claude-opus-5-5';
export const EFFORT = process.env.SORT_EFFORT ?? 'low';
export const CONCURRENCY = Math.max(1, Number(process.env.SORT_CONCURRENCY || 3));

export const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

for (const dir of [LIBRARY_DIR, THUMBS_DIR, INBOX_DIR]) fs.mkdirSync(dir, { recursive: true });
