// Decides which folder something belongs in. Some file types are sorted by
// simple rules (fonts always go to Fonts); everything visual is shown to Claude,
// which picks an existing folder or invents a new one.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { settings } from './config.js';
import { listCategories, categoryItems } from './store.js';

// File types we never need to look at to sort.
export const RULES = [
  { exts: ['ttf', 'otf', 'woff', 'woff2'], kind: 'font', category: 'Fonts', description: 'Typeface files you can install or preview.' },
  { exts: ['mp4', 'mov', 'webm', 'm4v'], kind: 'video', category: 'Motion', description: 'Videos, animations and motion references.' },
  {
    exts: ['psd', 'ai', 'fig', 'sketch', 'xd', 'indd', 'afdesign', 'afphoto', 'aep', 'prproj', 'procreate', 'kra', 'xcf'],
    kind: 'file',
    category: 'Source Files',
    description: 'Editable working files from design tools.',
  },
  { exts: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'usdz', 'blend', 'c4d', '3ds'], kind: 'file', category: '3D Models', description: '3D models and scenes.' },
  { exts: ['zip', 'rar', '7z', 'tar', 'gz'], kind: 'file', category: 'Archives', description: 'Compressed bundles and asset packs.' },
];

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'tif', 'tiff', 'bmp', 'heic', 'heif'];

export function ruleFor(ext) {
  return RULES.find((r) => r.exts.includes(ext)) || null;
}

const Classification = z.object({
  category: z.string().describe('Exact name of an existing folder, or the name of a new one.'),
  new_category_description: z
    .string()
    .describe('If you are creating a new folder, one short sentence on what belongs in it. Otherwise an empty string.'),
  title: z.string().describe('A short, specific name for this item, 2-6 words.'),
  description: z.string().describe('One sentence on what makes this worth keeping as a design reference.'),
  tags: z.array(z.string()).describe('3-8 lowercase tags: style, technique, medium, mood, notable colors.'),
});

const SYSTEM_PROMPT = `You sort a designer's personal reference library. Everything they save — images, PDFs, links, notes — goes into exactly one folder, and you choose it. They never sort anything by hand, so your choice is the whole system.

How to choose the folder:
- Folders describe what the item is as a design reference: its format, discipline or technique. Typical folders look like Poster Layouts, Patterns, 3D Illustrations, Typography, Logos & Marks, UI Design, Packaging, Editorial Layouts, Photography, Color Palettes, Icons, Mockups, Illustrations, Textures. Sort by what it is, not by its subject: a poster with a cat on it is a poster layout, not "Animals".
- Reuse an existing folder whenever the item genuinely belongs there, and return its name exactly as written.
- When no existing folder fits, create a new one. The library is meant to grow new folders as the collection widens, so do not force an item into a poor fit just to avoid creating one. Never invent near-duplicates of an existing folder.
- New folder names are Title Case, plural where it reads naturally, 1-3 words. Not so narrow that only this item fits ("Blue Neon Posters"), not so broad that it means nothing ("Design", "Inspiration", "Images", "Misc").
- A font specimen image belongs with typography, a screenshot of an app or website with UI design, a seamless or repeating motif with patterns, rendered 3D artwork with 3D illustrations.

The title should help the designer find this again later, so name what is distinctive about it ("Swiss Grid Jazz Poster", "Chrome Blob Render"), never a generic label like "Image" or "Design".`;

let client = null;
let clientKey = null;
function getClient() {
  if (!client || clientKey !== settings.apiKey) {
    client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 4 });
    clientKey = settings.apiKey;
  }
  return client;
}

/** Checks a key before saving it, so a typo shows up in Settings rather than as failed sorts. */
export async function verifyKey(apiKey, model) {
  try {
    await new Anthropic({ apiKey, maxRetries: 1 }).models.retrieve(model);
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'That API key was not accepted. Check that you copied all of it.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'This key is not allowed to use the API yet. Check billing in the Claude Console.';
    if (err instanceof Anthropic.NotFoundError) return 'This key cannot use that model. Pick another model.';
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection.';
    return err.message;
  }
}

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

export class AIUnavailableError extends Error {}

function describeFolders() {
  const cats = listCategories();
  if (!cats.length) return 'There are no folders yet. This is the first item in the library, so create a folder for it.';
  return (
    'Existing folders:\n' +
    cats
      .map((c) => {
        const n = categoryItems(c.name).length;
        return `- ${c.name}${c.description ? ` — ${c.description}` : ''} (${n} item${n === 1 ? '' : 's'})`;
      })
      .join('\n')
  );
}

/**
 * @param {Array} blocks  content blocks describing the item (image / document / text)
 * @param {string} context  extra plain-text context (filename, URL, etc.)
 */
export async function classify(blocks, context) {
  if (!settings.apiKey) throw new AIUnavailableError('No API key added');

  const params = {
    model: settings.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { format: betaZodOutputFormat(Classification), ...(settings.effort ? { effort: settings.effort } : {}) },
    messages: [
      {
        role: 'user',
        content: [...blocks, { type: 'text', text: [context, describeFolders(), 'Which folder does this go in?'].filter(Boolean).join('\n\n') }],
      },
    ],
  };
  if (FALLBACK_MODELS.includes(settings.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let response;
  try {
    response = await getClient().beta.messages.parse(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new AIUnavailableError('Your Anthropic API key was rejected');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to classify this item');
  const out = response.parsed_output;
  if (!out || !out.category?.trim()) throw new Error('Claude returned no category');

  return {
    category: out.category.trim(),
    categoryDescription: out.new_category_description.trim(),
    title: out.title.trim(),
    description: out.description.trim(),
    tags: [...new Set(out.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))].slice(0, 10),
  };
}
