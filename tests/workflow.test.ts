/*
  Tests for the workflow with the agent and the browser swapped out.

  providers() below is a fake tool set. liveSearch still runs the real checks
  and the real ranking, but geocode, route, stores, and gas return canned data.
  That is how these tests can prove "a price with no cited URL is dropped"
  without calling OpenAI or opening Chromium. A test that needs the real model
  is not in this file. Live research has to be tried in the app, with a key.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validate,
  rank,
  demoSearch,
  supported,
  radiusMiles,
  liveSearch,
  gasSearchLocation,
  findLocalStores,
  sameStoreName,
  WorkflowError,
} from '../workflow.ts';
import type { SearchOptions, Store, Offer, Providers, ResearchResult } from '../workflow.ts';

const options = (): SearchOptions => ({
  address: '123 Sample St, Chicago, IL 60601',
  radius: 10,
  mpg: 25,
  gas_override: null,
  demo: true,
});
const store = (price: number, miles: number): Store => ({
  name: 'Sample',
  address: 'Branch',
  product: 'Guinness Draught 8-pack',
  pack_count: 8,
  price,
  currency: 'USD',
  source_url: 'https://store.test/product',
  availability: 'unknown',
  branch_price_confirmed: false,
  notes: '',
  id: String(price),
  radius_miles: 1,
  round_trip_miles: miles,
  round_trip_minutes: 10,
  fuel_cost: null,
  total: null,
});
const offer: Offer = store(18, 7);
// A stand-in for liveProviders(). The workflow calls these the same way it
// would call the model and the browser. Change what they return to test a
// failure, a far-away store, or a missing source URL.
function providers(offers: Offer[] = [offer]): Providers {
  let routes = 0;
  return {
    async geocode(address) {
      return {
        point: address === 'Far branch' ? { lat: 45, lng: -87 } : { lat: 41.88, lng: -87.63 },
        address: address + ', Chicago, IL, USA',
      };
    },
    async route() {
      return ++routes % 2 ? { miles: 3, minutes: 8 } : { miles: 4, minutes: 10 };
    },
    async stores() {
      return {
        data: { stores: offers, notes: '' },
        sources: new Set(['https://store.test/product']),
      };
    },
    async gas() {
      return {
        data: {
          price: 3.5,
          source_url: 'https://gas.test',
          location: 'Chicago',
          observed_date: new Date().toISOString().slice(0, 10),
          notes: '',
        },
        sources: new Set(['https://gas.test']),
      };
    },
  };
}
test('rejects invalid address, radius, MPG, gas and mode', () => {
  const values = {
    radius: [0, 51, NaN, true],
    mpg: [0, -3, 'no'],
    gas_override: [0, Infinity],
    address: [null, ''],
    demo: ['false'],
  };
  for (const [field, items] of Object.entries(values))
    for (const value of items)
      assert.throws(() => validate({ ...options(), [field]: value }), WorkflowError);
});
test('round-trip fuel can change the winner', () => {
  const result = rank([store(15, 50), store(18, 2)], 4, 25);
  assert.equal(result[0].price, 18);
  assert.equal(result[0].total, 18.32);
  assert.equal(result[1].fuel_cost, 8);
});
test('missing gas does not become free fuel', () => {
  const [result] = rank([store(18, 4)], null, 25);
  assert.equal(result.total, null);
  assert.equal(result.fuel_cost, null);
});
test('demo filters radius and honors override', () => {
  const result = demoSearch({ ...options(), radius: 2, gas_override: 4 });
  assert.equal(result.demo, true);
  assert.equal(result.stores.length, 1);
  assert.equal(result.gas.price, 4);
});
test('source matching and geographic radius', () => {
  assert.equal(
    supported('https://store.test/product/', new Set(['https://store.test/product'])),
    true,
  );
  assert.equal(
    supported('https://store.test/other', new Set(['https://store.test/product'])),
    false,
  );
  assert.equal(supported('javascript:alert(1)', new Set(['javascript:alert(1)'])), false);
  assert.ok(Math.abs(radiusMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 69.09) < 0.1);
});
test('live filters wrong packs, stock, unsourced prices, distant stores and duplicates', async () => {
  const p = providers([
    offer,
    { ...offer, pack_count: 0 },
    { ...offer, availability: 'out_of_stock' },
    { ...offer, source_url: 'https://unsupported.test' },
    { ...offer, address: 'Far branch' },
    offer,
  ]);
  const progress: number[] = [];
  const result = await liveSearch({ ...options(), demo: false }, p, (step) => progress.push(step));
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].round_trip_miles, 7);
  assert.equal(result.stores[0].total, 18.98);
  assert.deepEqual(progress, [0, 1, 2, 3]);
});
test('failed route keeps shelf price; gas failure is explicit', async () => {
  const p = providers();
  p.route = async () => {
    throw new WorkflowError('No route');
  };
  p.gas = async () => {
    throw new WorkflowError('Gas lookup failed');
  };
  const result = await liveSearch(options(), p);
  assert.equal(result.stores.length, 1);
  assert.equal(result.gas.price, null);
  assert.equal(result.stores[0].round_trip_miles, null);
  assert.equal(result.stores[0].total, null);
  assert.ok(result.warnings.some((w) => w.includes('Driving distance unavailable')));
});
test('gas search uses the city and state from the address area', () => {
  assert.deepEqual(gasSearchLocation('Chicago, IL 60601'), {
    city: 'Chicago',
    region: 'Illinois',
  });
  assert.deepEqual(gasSearchLocation('St. Louis, MO'), { city: 'St. Louis', region: 'Missouri' });
  assert.deepEqual(gasSearchLocation('Bronx, NY 10451'), { city: 'Bronx', region: 'New York' });
});
test('a cited gas page still counts when the link only adds tracking parameters', async () => {
  const p = providers();
  const gas = await p.gas('Chicago, IL');
  gas.data.source_url = 'https://gas.test/prices';
  gas.sources = new Set(['https://gas.test/prices?utm=1']);
  p.gas = async () => gas;
  const result = await liveSearch(options(), p);
  assert.equal(result.gas.price, 3.5);
});
test('undated, old and unsourced gas prices cannot produce totals', async () => {
  for (const [date, url] of [
    ['', 'https://gas.test'],
    ['2020-01-01', 'https://gas.test'],
    [new Date().toISOString().slice(0, 10), 'https://unsourced.test'],
  ]) {
    const p = providers();
    const gas = await p.gas('Chicago');
    gas.data.observed_date = date;
    gas.data.source_url = url;
    p.gas = async () => gas;
    const result = await liveSearch(options(), p);
    assert.equal(result.gas.price, null);
    assert.equal(result.stores[0].total, null);
  }
});
test('store names match with punctuation and initials, not across different retailers', () => {
  assert.equal(sameStoreName("Litt's Bottle Shop", 'Litts Bottle Shop North'), true);
  assert.equal(sameStoreName('H-E-B', 'HEB'), true);
  assert.equal(sameStoreName('Corner Bottle Shop', 'Other Grocery'), false);
});
test('prices are looked up only for stores named in local listings', async () => {
  const prompts: string[] = [];
  const corner = {
    ...offer,
    name: 'Corner Bottle Shop',
    address: 'Austin',
    source_url: 'https://corner.test/guinness',
  };
  const warehouse = {
    ...offer,
    name: 'Sample Warehouse',
    address: '90 Farm Rd, Austin, TX',
    source_url: 'https://warehouse.test/guinness',
  };
  const research: Parameters<typeof findLocalStores>[2] = async <T>(
    prompt: string,
    _schema: unknown,
    name: string,
  ) => {
    prompts.push(prompt);
    if (name === 'nearby_stores') {
      return {
        data: {
          places: [
            {
              name: 'Corner Bottle Shop',
              address: '10 Main St, Austin, TX',
              category: 'liquor_store',
            },
            { name: 'Sample Warehouse', address: '90 Farm Rd, Austin, TX', category: 'grocery' },
          ],
          notes: 'Listed nearby.',
        },
        sources: new Set(['https://listings.test/liquor']),
      } as ResearchResult<T>;
    }
    const listed = prompt.includes('Sample Warehouse') ? warehouse : corner;
    return {
      data: {
        stores: [listed, { ...offer, name: 'Unlisted National Chain', address: '1 Nowhere Ave' }],
        notes: '',
      },
      sources: new Set([listed.source_url, 'https://national.test/guinness']),
    } as ResearchResult<T>;
  };
  const result = await findLocalStores('Austin, Texas', 10, research);
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /Corner Bottle Shop/);
  assert.doesNotMatch(prompts[1], /Sample Warehouse/);
  assert.match(prompts[2], /Sample Warehouse/);
  assert.deepEqual(
    result.data.stores.map((store) => store.name),
    ['Corner Bottle Shop', 'Sample Warehouse'],
  );
  assert.equal(result.data.stores[0].address, '10 Main St, Austin, TX');
  assert.equal(result.sources.has('https://corner.test/guinness'), true);
  assert.equal(result.sources.has('https://national.test/guinness'), true);
});
test('no local listings means no price search', async () => {
  let calls = 0;
  const research: Parameters<typeof findLocalStores>[2] = async <T>() => {
    calls += 1;
    return { data: { places: [], notes: '' }, sources: new Set<string>() } as ResearchResult<T>;
  };
  const result = await findLocalStores('Austin, Texas', 10, research);
  assert.equal(calls, 1);
  assert.equal(result.data.stores.length, 0);
});
test('manual override skips gas research', async () => {
  const p = providers();
  p.gas = async () => {
    throw new Error('Should not call gas');
  };
  const result = await liveSearch({ ...options(), gas_override: 4 }, p);
  assert.equal(result.gas.price, 4);
  assert.equal(result.stores[0].total, 19.12);
});
