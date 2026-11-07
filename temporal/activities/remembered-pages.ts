/*
  The price pages that worked for an area, saved between searches.

  A web search cites whatever it finds that time, so two searches from the same
  address can come back with different stores. Once the verifier has found a
  store's price on a page, that page is saved here. The next search for the
  same area reads those pages again first. Nothing here names a retailer: the
  list is whatever earlier searches found.

  One JSON file next to the app, keyed by ZIP code when the area has one.
  A missing or unreadable file is an empty memory, not an error.
*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BeerRunActivities, RememberedPage } from '../contracts.ts';

const MEMORY_FILE = fileURLToPath(new URL('../../data/price-pages.json', import.meta.url));
const MAX_PAGES = 8;

interface Memory {
  [area: string]: { saved_at: string; pages: RememberedPage[] };
}

function areaKey(area: string) {
  return area.match(/\b\d{5}\b/)?.[0] ?? area.trim().toLowerCase();
}

async function readMemory(): Promise<Memory> {
  try {
    const parsed = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Memory) : {};
  } catch {
    return {};
  }
}

function isPage(value: unknown): value is RememberedPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return ['name', 'address', 'product', 'source_url'].every(
    (field) => typeof page[field] === 'string' && page[field] !== '',
  );
}

export const rememberedPages: BeerRunActivities['rememberedPages'] = async (area) => {
  const saved = (await readMemory())[areaKey(area)];
  return Array.isArray(saved?.pages) ? saved.pages.filter(isPage).slice(0, MAX_PAGES) : [];
};

export const rememberPages: BeerRunActivities['rememberPages'] = async (area, pages) => {
  const memory = await readMemory();
  memory[areaKey(area)] = {
    saved_at: new Date().toISOString(),
    pages: pages.filter(isPage).slice(0, MAX_PAGES),
  };
  await mkdir(fileURLToPath(new URL('../../data/', import.meta.url)), { recursive: true });
  const temporary = `${MEMORY_FILE}.tmp`;
  await writeFile(temporary, `${JSON.stringify(memory, null, 2)}\n`);
  await rename(temporary, MEMORY_FILE);
};
