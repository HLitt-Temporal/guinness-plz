/*
  The second look at a price, after a store has been placed on the map.

  Research says "this page lists Guinness at $17.99." The price check opens
  that page in a headless browser and asks a verifier agent to point at the
  price and the product on it, by copying the words. This file is the part
  that does not trust the verifier either: a quote only counts when it is
  really in the page text, and the price only counts when it is inside the
  quote. The verifier can say "not found." It cannot make a price true.

  This file is bundled into the workflow, so it stays free of the browser and
  the network. price-page.ts opens the page. temporal/agents.ts runs the agent.
*/

export interface PriceCheck {
  // verified: the page shows this Guinness product at this price.
  // mismatch: the page shows this Guinness product at a different price.
  // not_on_page: the page loaded, but no quotable Guinness price was found.
  // unreadable: the page did not load, or asked for human verification.
  status: 'verified' | 'mismatch' | 'not_on_page' | 'unreadable';
  page_price: number | null;
  note: string;
}

// What the verifier agent fills in. The quotes are copied from the page text.
export interface VerifierVerdict {
  found: boolean;
  page_price: number | null;
  price_quote: string;
  pack_quote: string;
  notes: string;
}

// What the page activity hands back. text is an excerpt, not the whole page.
export interface PricePage {
  status: 'ok' | 'blocked' | 'failed';
  text: string;
  url: string;
  note: string;
}

// Enough page for the product block and its price, small enough for one model call.
const MAX_PAGE_CHARS = 12_000;
// Lines kept around each line that names Guinness. Prices usually sit just below.
const LINES_BEFORE = 4;
const LINES_AFTER = 8;
const MAX_QUOTE_CHARS = 300;
const GUINNESS = /\bguinness\b/i;

function squash(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A retailer page is mostly menus and footers. Keep the lines near "Guinness"
// so the verifier reads the product, not the site navigation.
export function pageExcerpt(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (!/guinness/i.test(line)) return;
    const last = Math.min(lines.length - 1, index + LINES_AFTER);
    for (let near = Math.max(0, index - LINES_BEFORE); near <= last; near += 1) keep.add(near);
  });
  const chosen = keep.size ? [...keep].sort((a, b) => a - b).map((index) => lines[index]) : lines;
  return chosen.join('\n').slice(0, MAX_PAGE_CHARS);
}

function onPage(quote: string, page: string) {
  const wanted = squash(quote);
  return wanted.length >= 3 && wanted.length <= MAX_QUOTE_CHARS && page.includes(wanted);
}

// "$17.99", "17.99", and for a whole-dollar price "$18" all count.
function quoteShowsPrice(quote: string, price: number) {
  const plain = squash(quote).replace(/,/g, '');
  if (plain.includes(price.toFixed(2))) return true;
  return Number.isInteger(price) && new RegExp(`\\$\\s?${price}(?![\\d.])`).test(plain);
}

function notOnPage(note: string): PriceCheck {
  return { status: 'not_on_page', page_price: null, note };
}

export function checkPriceEvidence(
  claimed: number,
  verdict: VerifierVerdict,
  pageText: string,
): PriceCheck {
  const page = squash(pageText);
  const price = verdict.page_price;
  if (!verdict.found || price == null || !Number.isFinite(price) || price <= 0) {
    return notOnPage('No Guinness price was found on the cited page.');
  }
  if (!onPage(verdict.price_quote, page) || !quoteShowsPrice(verdict.price_quote, price)) {
    return notOnPage('The price the verifier reported is not in the page text, so it was ignored.');
  }
  if (!onPage(verdict.pack_quote, page) || !GUINNESS.test(verdict.pack_quote)) {
    return notOnPage('The cited page does not clearly show a Guinness product next to the price.');
  }
  if (Math.abs(price - claimed) < 0.005) {
    return {
      status: 'verified',
      page_price: price,
      note: 'Price and Guinness product found on the cited page.',
    };
  }
  return {
    status: 'mismatch',
    page_price: price,
    note: `The cited page shows $${price.toFixed(2)}, not $${claimed.toFixed(2)}.`,
  };
}
