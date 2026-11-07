import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPriceEvidence, pageExcerpt } from '../price-check.ts';
import type { VerifierVerdict } from '../price-check.ts';
import { offerProblem, validateWatch } from '../workflow.ts';
import { offer } from './temporal-harness.ts';

const page = 'Home > Beer\nGuinness Draught Stout 8pk 14.9oz Cans\n$18.00\nAdd to cart';
const quoted: VerifierVerdict = {
  found: true,
  page_price: 18,
  price_quote: '$18.00',
  pack_quote: 'Guinness Draught Stout 8pk 14.9oz Cans',
  notes: '',
};

test('a price quoted from the page with a Guinness product is verified', () => {
  assert.equal(checkPriceEvidence(18, quoted, page).status, 'verified');
  const single = { ...quoted, pack_quote: 'Guinness Extra Stout 11.2oz Bottle' };
  const singlePage = 'Guinness Extra Stout 11.2oz Bottle\n$18.00';
  assert.equal(checkPriceEvidence(18, single, singlePage).status, 'verified');
  const wholeDollar = { ...quoted, price_quote: 'Price $18 each' };
  const wholeDollarPage = 'Guinness Draught Stout 8pk 14.9oz Cans\nPrice $18 each';
  assert.equal(checkPriceEvidence(18, wholeDollar, wholeDollarPage).status, 'verified');
});

test('a different quoted price is a mismatch that names the page price', () => {
  const check = checkPriceEvidence(16.99, quoted, page);
  assert.equal(check.status, 'mismatch');
  assert.equal(check.page_price, 18);
  assert.match(check.note, /\$18\.00, not \$16\.99/);
});

test('quotes that are not in the page text do not count', () => {
  const invented = { ...quoted, price_quote: 'Sale $14.99', page_price: 14.99 };
  assert.equal(checkPriceEvidence(14.99, invented, page).status, 'not_on_page');
  const priceNotInQuote = { ...quoted, price_quote: 'Add to cart' };
  assert.equal(checkPriceEvidence(18, priceNotInQuote, page).status, 'not_on_page');
  const noPack = { ...quoted, pack_quote: 'Home > Beer' };
  assert.equal(checkPriceEvidence(18, noPack, page).status, 'not_on_page');
  assert.equal(checkPriceEvidence(18, { ...quoted, found: false }, page).status, 'not_on_page');
});

test('the page excerpt keeps the product block and drops the site menus', () => {
  const menus = Array.from({ length: 40 }, (_, index) => `Menu item ${index}`).join('\n');
  const excerpt = pageExcerpt(`${menus}\nGuinness Draught 8pk\n$18.00\n${menus}`);
  assert.match(excerpt, /Guinness Draught 8pk\n\$18\.00/);
  assert.ok(!excerpt.includes('Menu item 20'));
});

test('offerProblem says why an offer cannot be used', () => {
  const sources = new Set(['https://store.test/product']);
  assert.equal(offerProblem(offer, sources), null);
  assert.equal(offerProblem({ ...offer, pack_count: 12 }, sources), null);
  assert.equal(offerProblem({ ...offer, pack_count: 1 }, sources), null);
  assert.match(offerProblem({ ...offer, pack_count: 0 }, sources)!, /how many units/);
  assert.match(offerProblem({ ...offer, price: null }, sources)!, /No public price/);
  assert.match(offerProblem(offer, new Set())!, /not one the web search returned/);
});

test('a watch needs an allowed interval and a target, and stops after two weeks', () => {
  const search = { address: '123 Main St, Austin, TX', radius: 10, mpg: 25, demo: true };
  const watch = validateWatch({ ...search, target_price: 12, interval_hours: 24 });
  assert.equal(watch.max_checks, 14);
  assert.equal(watch.search.demo, true);
  assert.throws(
    () => validateWatch({ ...search, target_price: 12, interval_hours: 1 }),
    /interval/,
  );
  assert.throws(() => validateWatch({ ...search, interval_hours: 24 }), /Target price/);
});
