/*
  Map lookups for the workflow. This file is a tool our code calls. It is not
  a tool we hand to the model.

  The model is good at reading a messy web page and bad at being exact about
  coordinates and drive time. So location and distance are read from public map
  pages by a headless browser (Chromium with no window). If the page is
  ambiguous, asks for a CAPTCHA, or does not show one clear route, this throws.
  The workflow then says the distance is unavailable. It does not invent miles.

  createHeadlessMaps() is opened once per live search and closed when that
  search finishes, success or failure.
*/

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { WorkflowError, radiusMiles } from './workflow.ts';
import type { Point } from './workflow.ts';

export interface RouteEvidence {
  miles: number;
  minutes: number;
  source_url: string;
}

// Coordinates have to come from the address result itself. A pin from the map
// camera, or a missing pin, is not a location we will drive from.
export function pointFromSearchResult(lat: string | null, lng: string | null): Point {
  if (!lat || !lng) throw new WorkflowError('The address result has no location coordinates.');
  const point = { lat: Number(lat), lng: Number(lng) };
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lng) > 180
  )
    throw new WorkflowError('Invalid address location coordinates.');
  return point;
}
// Read one distance and one duration out of a route card. Two distances means
// the card mixed routes together, and we refuse to pick one.
export function parseDrivingRoute(text: string): { miles: number; minutes: number } {
  const clean = text.replace(/\u00a0|\u202f/g, ' ');
  const distances = [...clean.matchAll(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(miles?|mi|km)\b/gi)];
  if (distances.length !== 1)
    throw new WorkflowError('Driving route distance was unavailable or ambiguous.');
  const [distance] = distances;
  const hours = [...clean.matchAll(/\b(\d+)\s*(?:hours?|hr|h)\b/gi)];
  const minutes = [...clean.matchAll(/\b(\d+)\s*(?:minutes?|min)\b/gi)];
  if (hours.length > 1 || minutes.length > 1 || (!hours.length && !minutes.length))
    throw new WorkflowError('Driving time was unavailable or ambiguous.');
  const miles =
    Number(distance[1].replaceAll(',', '')) *
    (distance[2].toLowerCase() === 'km' ? 0.6213711922 : 1);
  const duration =
    (hours.length ? Number(hours[0][1]) * 60 : 0) + (minutes.length ? Number(minutes[0][1]) : 0);
  if (miles <= 0 || miles > 1000 || duration <= 0 || duration > 1440)
    throw new WorkflowError('Driving route measurements were invalid.');
  return { miles, minutes: duration };
}
// Street, avenue, and spelled-out directions get shortened so "West North
// Avenue" and "W North Ave" can be compared. This is string matching, not geocoding.
const ADDRESS_WORDS: Record<string, string> = {
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  street: 'st',
  avenue: 'ave',
  road: 'rd',
  drive: 'dr',
  boulevard: 'blvd',
  lane: 'ln',
  court: 'ct',
  parkway: 'pkwy',
  place: 'pl',
  circle: 'cir',
  terrace: 'ter',
  trail: 'trl',
  highway: 'hwy',
  square: 'sq',
  plaza: 'plz',
  alley: 'aly',
  expressway: 'expy',
  freeway: 'fwy',
  crescent: 'cres',
  crossing: 'xing',
  point: 'pt',
  saint: 'st',
  mount: 'mt',
  fort: 'ft',
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
  sixth: '6th',
  seventh: '7th',
  eighth: '8th',
  ninth: '9th',
  tenth: '10th',
  eleventh: '11th',
  twelfth: '12th',
};

const ADDRESS_WORD_PATTERN = new RegExp(
  `\\b(${Object.keys(ADDRESS_WORDS)
    .sort((a, b) => b.length - a.length)
    .join('|')})\\b`,
  'g',
);

const STATE_NAMES: Record<string, string> = {
  al: 'alabama',
  ak: 'alaska',
  az: 'arizona',
  ar: 'arkansas',
  ca: 'california',
  co: 'colorado',
  ct: 'connecticut',
  de: 'delaware',
  dc: 'district of columbia',
  fl: 'florida',
  ga: 'georgia',
  hi: 'hawaii',
  id: 'idaho',
  il: 'illinois',
  in: 'indiana',
  ia: 'iowa',
  ks: 'kansas',
  ky: 'kentucky',
  la: 'louisiana',
  me: 'maine',
  md: 'maryland',
  ma: 'massachusetts',
  mi: 'michigan',
  mn: 'minnesota',
  ms: 'mississippi',
  mo: 'missouri',
  mt: 'montana',
  ne: 'nebraska',
  nv: 'nevada',
  nh: 'new hampshire',
  nj: 'new jersey',
  nm: 'new mexico',
  ny: 'new york',
  nc: 'north carolina',
  nd: 'north dakota',
  oh: 'ohio',
  ok: 'oklahoma',
  or: 'oregon',
  pa: 'pennsylvania',
  ri: 'rhode island',
  sc: 'south carolina',
  sd: 'south dakota',
  tn: 'tennessee',
  tx: 'texas',
  ut: 'utah',
  vt: 'vermont',
  va: 'virginia',
  wa: 'washington',
  wv: 'west virginia',
  wi: 'wisconsin',
  wy: 'wyoming',
};

const UNIT_PART = /^(?:apt|apartment|unit|suite|ste|bldg|building|rm|room|floor|#)\s*[#a-z0-9-]+$/i;
// Two search hits for one building can sit a short distance apart. Farther
// than this, we treat them as different places and refuse to choose.
const SAME_PLACE_MILES = 1;

function normalizeAddress(value: string): string {
  ADDRESS_WORD_PATTERN.lastIndex = 0;
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ADDRESS_WORD_PATTERN, (word) => ADDRESS_WORDS[word])
    .replace(/\b([ns])\s+([ew])\b/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const STATE_BY_TOKEN: Record<string, string> = {};
for (const [abbreviation, name] of Object.entries(STATE_NAMES)) {
  STATE_BY_TOKEN[abbreviation] = abbreviation;
  STATE_BY_TOKEN[normalizeAddress(name)] = abbreviation;
}

function collapseInitials(value: string): string {
  return value.replace(/\b([a-z])\s+(?=[a-z]\b)/g, '$1');
}

function significantWords(value: string): string[] {
  return collapseInitials(normalizeAddress(value))
    .split(' ')
    .filter((word) => word && !/^\d+$/.test(word));
}

function stateIn(value: string): string {
  const words = significantWords(value);
  for (let length = Math.min(4, words.length); length > 0; length -= 1) {
    for (let index = words.length - length; index >= 0; index -= 1) {
      const state = STATE_BY_TOKEN[words.slice(index, index + length).join(' ')];
      if (state) return state;
    }
  }
  return '';
}

function exactState(value: string): string {
  return STATE_BY_TOKEN[significantWords(value).join(' ')] ?? '';
}

function stripThe(value: string): string {
  return value.replace(/^the /, '');
}

function withoutUnit(value: string): string {
  return value
    .replace(
      /\s+(?:(?:apt|apartment|unit|suite|ste|bldg|building|rm|room|floor|fl)\s*|#)\s*[a-z0-9-]+\s*$/i,
      '',
    )
    .trim();
}

interface ParsedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

function parseUsAddress(query: string): ParsedAddress {
  const zip =
    query
      .match(/\b(\d{5})(?:-\d{4})?\b/g)
      ?.at(-1)
      ?.slice(0, 5) ?? '';
  const parts = query
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !UNIT_PART.test(part));
  const street = normalizeAddress(withoutUnit(parts[0] ?? ''));
  let city = '';
  let state = '';
  if (parts.length >= 3) {
    city = stripThe(normalizeAddress(parts[1]));
    state = stateIn(parts.slice(2).join(' '));
  } else if (parts.length === 2) {
    const words = significantWords(parts[1]);
    let stateLength = 0;
    for (let length = Math.min(4, words.length); length > 0; length -= 1) {
      const phrase = words.slice(-length).join(' ');
      if (STATE_BY_TOKEN[phrase]) {
        state = STATE_BY_TOKEN[phrase];
        stateLength = length;
        break;
      }
    }
    city = stripThe(words.slice(0, words.length - stateLength).join(' '));
  }
  return { street, city, state, zip };
}

const SPELLED_ORDINALS: Record<string, string> = {
  first: '1st',
  second: '2nd',
  third: '3rd',
  fourth: '4th',
  fifth: '5th',
  sixth: '6th',
  seventh: '7th',
  eighth: '8th',
  ninth: '9th',
  tenth: '10th',
  eleventh: '11th',
  twelfth: '12th',
};

// OpenStreetMap search is picky about "Northwest" versus "NW" and "First"
// versus "1st". The query is rewritten before it is typed into the search box.
export function mapSearchQuery(address: string): string {
  const parts = address.split(',');
  parts[0] = parts[0]
    .replace(/\b(?:north\s*west|northwest|n\s*\.\s*w)\.?(?![a-z])/gi, 'NW')
    .replace(/\b(?:north\s*east|northeast|n\s*\.\s*e)\.?(?![a-z])/gi, 'NE')
    .replace(/\b(?:south\s*west|southwest|s\s*\.\s*w)\.?(?![a-z])/gi, 'SW')
    .replace(/\b(?:south\s*east|southeast|s\s*\.\s*e)\.?(?![a-z])/gi, 'SE')
    .replace(
      /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/gi,
      (word) => SPELLED_ORDINALS[word.toLowerCase()],
    )
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return parts.join(',');
}

// True when the text on the map result is the same US street address we asked
// for: number, street, city, state, and ZIP. A nearby business with a similar
// name does not pass.
export function addressMatches(
  query: string,
  shown: string,
  options?: { ignoreZip?: boolean },
): boolean {
  const parsed = parseUsAddress(query);
  const streetTokens = parsed.street.split(' ').filter(Boolean);
  if (!/\d/.test(streetTokens[0] ?? '') || streetTokens.length < 2) return false;
  const shownNormalized = normalizeAddress(shown);
  if (!` ${shownNormalized} `.includes(` ${parsed.street} `)) return false;
  if (!options?.ignoreZip && parsed.zip && !new RegExp(`\\b${parsed.zip}\\b`).test(shownNormalized))
    return false;
  const components = shown.split(',').map((part) => stripThe(normalizeAddress(part)));
  if (parsed.city && !components.includes(parsed.city)) return false;
  if (parsed.state && !shown.split(',').some((part) => exactState(part) === parsed.state))
    return false;
  return true;
}

function listedInUnitedStates(text: string): boolean {
  return /\bUnited States\b/.test(text);
}

// Pick one result or fail. Several hits are ok only when they are the same
// place. "More results" is the caller's problem; this function only chooses
// among the candidates it was given.
export function selectStreetAddress<
  T extends { text: string; lat: string | null; lng: string | null },
>(query: string, candidates: T[]): T {
  const inCountry = candidates.filter((candidate) => listedInUnitedStates(candidate.text));
  const strict = inCountry.filter((candidate) => addressMatches(query, candidate.text));
  // OpenStreetMap sometimes files a building under a neighboring ZIP.
  const matches = strict.length
    ? strict
    : inCountry.filter((candidate) => addressMatches(query, candidate.text, { ignoreZip: true }));
  if (!matches.length)
    throw new WorkflowError('Public map search did not return one matching US street address.');
  const points = matches.map((candidate) => pointFromSearchResult(candidate.lat, candidate.lng));
  // One street address is often a building plus a nearby place at slightly different coordinates.
  const scattered = points.some((point) => radiusMiles(points[0], point) > SAME_PLACE_MILES);
  if (scattered)
    throw new WorkflowError('Public map search did not return one matching US street address.');
  return matches[0];
}
// Leave if the site bounced us to a consent wall or a bot check. Working
// around that check is not part of this tool.
async function navigate(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!['www.google.com', 'www.openstreetmap.org'].includes(new URL(page.url()).hostname))
    throw new WorkflowError('Maps redirected to a consent or verification page.');
  const text = await page.locator('body').innerText({ timeout: 10000 });
  if (/unusual traffic|verify you are human|before you continue to google|not a robot/i.test(text))
    throw new WorkflowError(
      'Maps requires consent or human verification. No route estimate was inferred.',
    );
}
// Start one throwaway browser for this search. geocode and route share it.
// geocode remembers addresses it already resolved, because the same store can
// be checked twice and we do not need to search the map twice.
export async function createHeadlessMaps() {
  let context: BrowserContext;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(30000);
  } catch {
    await browser?.close().catch(() => {});
    throw new WorkflowError(
      'Could not start headless Chromium. Run npm run browser:install, then retry.',
    );
  }
  const geocodes = new Map<
    string,
    { point: Point; address: string; locality: string; source_url: string }
  >();
  return {
    // Search OpenStreetMap for this address and take the coordinates off the
    // matching result link. Up to three pages of results are scanned. A page
    // with no exact match is not a reason to use a nearby hit.
    async geocode(address: string) {
      const cached = geocodes.get(address);
      if (cached) return cached;
      const page = await context.newPage();
      try {
        const query = new URLSearchParams({ query: mapSearchQuery(address) });
        await navigate(page, `https://www.openstreetmap.org/search?${query}`);
        const readCandidates = () =>
          page.locator('a.set_position[data-lat][data-lon]').evaluateAll((nodes) =>
            nodes.map((n) => ({
              text: (n as HTMLElement).innerText,
              lat: n.getAttribute('data-lat'),
              lng: n.getAttribute('data-lon'),
              href: (n as HTMLAnchorElement).href,
            })),
          );
        await page
          .locator('a.set_position[data-lat][data-lon]')
          .first()
          .waitFor({ state: 'visible' });
        let candidates = await readCandidates();
        let selected: (typeof candidates)[number] | undefined;
        for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
          try {
            selected = selectStreetAddress(address, candidates);
            break;
          } catch (error) {
            if (
              !(error instanceof WorkflowError) ||
              !error.message.includes('one matching US street address')
            )
              throw error;
            const more = page.locator('.search_more a.btn');
            if (pageNumber === 2 || !(await more.count())) throw error;
            const before = candidates.length;
            await more.click();
            try {
              await page.waitForFunction(
                (count) =>
                  document.querySelectorAll('a.set_position[data-lat][data-lon]').length > count,
                before,
              );
            } catch {
              throw error;
            }
            candidates = await readCandidates();
          }
        }
        if (!selected)
          throw new WorkflowError(
            'Public map search did not return one matching US street address.',
          );
        const locality = address.includes(',')
          ? address.split(',').slice(1).join(',').trim()
          : selected.text.split(',').slice(-3).join(',').trim();
        const result = {
          point: pointFromSearchResult(selected.lat, selected.lng),
          address: selected.text,
          locality,
          source_url: selected.href,
        };
        geocodes.set(address, result);
        return result;
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError(
          'Headless public-map search could not confirm the street address. Try a more precise address.',
        );
      } finally {
        await page.close();
      }
    },
    // Open the public Google Maps directions URL for these two points and read
    // the first driving card only. The whole page can list alternate routes,
    // and mixing them would invent a trip that is not on the map.
    async route(a: Point, b: Point): Promise<RouteEvidence> {
      const query = new URLSearchParams({
        api: '1',
        origin: `${a.lat},${a.lng}`,
        destination: `${b.lat},${b.lng}`,
        travelmode: 'driving',
        hl: 'en',
        avoid: 'tolls,ferries',
      });
      const source_url = `https://www.google.com/maps/dir/?${query}`;
      const page = await context.newPage();
      try {
        await navigate(page, source_url);
        const card = page.locator('div[data-trip-index="0"]').first();
        await card.waitFor({ state: 'visible' });
        if (!(await card.locator('[aria-label="Driving"]').count()))
          throw new WorkflowError('Map result is not a driving route.');
        const measurements = parseDrivingRoute(await card.innerText());
        return { ...measurements, source_url };
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError('Headless Maps could not read a driving route.');
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser!.close();
    },
  };
}
