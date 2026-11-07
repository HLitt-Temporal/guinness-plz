/*
  Opens the page a price was cited from, for the price check.

  This is a tool our code calls with a URL the search already returned. The
  verifier agent never picks the URL. The page text goes to the verifier as
  data. A page that says "ignore your instructions" is just a page.

  Retailer sites often block headless browsers or draw prices with scripts
  after load. Either way this returns a status instead of throwing, and the
  store keeps its research price with "could not read the page" beside it.
  Only a browser that will not start throws, so Temporal retries the activity.
*/

import { chromium } from 'playwright';
import { pageExcerpt } from './price-check.ts';
import type { PricePage } from './price-check.ts';
import { WorkflowError } from './workflow.ts';

const BLOCKED =
  /access denied|verify you are human|unusual traffic|are you a robot|captcha|enable javascript and cookies|attention required|request blocked/i;
// Most product pages draw the price within a few seconds of load.
const SETTLE_MS = 8000;

// The URL came from a web search, but a search result can still point at a
// private address. This browser never opens one.
function isPublicWebUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[')) return false;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!ipv4) return host.includes('.');
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  const privateRange =
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  return !privateRange;
}

export async function openPricePage(url: string): Promise<PricePage> {
  if (!isPublicWebUrl(url)) {
    return { status: 'failed', text: '', url, note: 'The cited link is not a public web page.' };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new WorkflowError(
      'Could not start headless Chromium. Run npm run browser:install, then retry.',
    );
  }
  try {
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    const landed = page.url();
    if (!isPublicWebUrl(landed)) {
      return {
        status: 'failed',
        text: '',
        url,
        note: 'The cited page redirected off the public web.',
      };
    }
    const text = await page.locator('body').innerText({ timeout: 10_000 });
    const status = response?.status() ?? 0;
    if (status >= 400 || BLOCKED.test(text.slice(0, 4000))) {
      return {
        status: 'blocked',
        text: '',
        url: landed,
        note:
          status >= 400
            ? `The retailer page returned HTTP ${status} to the headless browser.`
            : 'The retailer page asked for human verification.',
      };
    }
    return { status: 'ok', text: pageExcerpt(text), url: landed, note: '' };
  } catch {
    return {
      status: 'failed',
      text: '',
      url,
      note: 'The cited page did not load in the headless browser.',
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
