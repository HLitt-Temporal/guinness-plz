/*
  The recovery agent, the price verifier, and the live feed, inside a real
  beerRun on a local Temporal test server. The model is scripted, so these
  tests check what the workflow does with each answer, not what a real model
  would say.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import { PROGRESS_TOPIC } from '../temporal/progress.ts';
import type { BeerRunActivities } from '../temporal/contracts.ts';
import type { ProgressEvent } from '../temporal/progress.ts';
import type { Result } from '../workflow.ts';
import {
  PRODUCT_PAGE,
  fakeActivities,
  offer,
  options,
  runWorkflow,
  scriptedModels,
  testId,
  verdict,
  withWorker,
} from './temporal-harness.ts';

// One store whose first price came back empty, so the recovery agent runs.
function droppedStore(calls: string[]) {
  const activities = fakeActivities(calls);
  activities.researchStores = async () => {
    calls.push('stores');
    return {
      stores: [{ ...offer, price: null }],
      notes: '',
      sources: ['https://store.test/product'],
    };
  };
  activities.researchOffer = async (input) => {
    calls.push(`offer:${input.approach}`);
    return {
      offer: { ...offer, source_url: 'https://store.test/8-pack' },
      notes: '',
      sources: ['https://store.test/8-pack'],
    };
  };
  activities.readPricePage = async (url) => {
    calls.push('page');
    return { status: 'ok', text: PRODUCT_PAGE, url, note: '' };
  };
  return activities;
}

const recovers = [
  { tool: 'search_price', args: { approach: 'the retailer product page' } },
  { tool: 'confirm_branch', args: { address_source: 'search_result' } },
  { text: 'Found the 8-pack on the retailer site.' },
];

test('the recovery agent finds a dropped store, and the verifier confirms its price', async () => {
  const calls: string[] = [];
  const models = scriptedModels({ recovery: recovers, verifier: [verdict({})] });
  const result = await runWorkflow<Result>(
    'beerRun',
    [options],
    droppedStore(calls),
    models.provider,
  );

  assert.ok(calls.includes('offer:the retailer product page'));
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].recovered, true);
  assert.equal(result.stores[0].source_url, 'https://store.test/8-pack');
  assert.equal(result.stores[0].price_check?.status, 'verified');
  assert.deepEqual(models.turns, ['recovery', 'recovery', 'recovery', 'verifier']);
});

test('a page showing a different price removes the store and says why', async () => {
  const calls: string[] = [];
  const activities = droppedStore(calls);
  activities.readPricePage = async (url) => ({
    status: 'ok',
    text: 'Guinness Draught Stout 8pk 14.9oz Cans\n$21.99',
    url,
    note: '',
  });
  const models = scriptedModels({
    recovery: recovers,
    verifier: [verdict({ page_price: 21.99, price_quote: '$21.99' })],
  });
  const result = await runWorkflow<Result>('beerRun', [options], activities, models.provider);
  assert.equal(result.stores.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('shows $21.99, not $18.00')));
});

test('the recovery agent cannot search past its budget or confirm without a price', async () => {
  const calls: string[] = [];
  const activities = droppedStore(calls);
  activities.researchOffer = async (input) => {
    calls.push(`offer:${input.approach}`);
    return { offer: null, notes: 'No 8-pack listed.', sources: [] };
  };
  const models = scriptedModels({
    recovery: [
      { tool: 'confirm_branch', args: { address_source: 'listing' } },
      { tool: 'search_price', args: { approach: 'one' } },
      { tool: 'search_price', args: { approach: 'two' } },
      { tool: 'search_price', args: { approach: 'three' } },
      { text: 'No public 8-pack price.' },
    ],
  });
  const result = await runWorkflow<Result>('beerRun', [options], activities, models.provider);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('offer:')),
    ['offer:one', 'offer:two'],
  );
  assert.ok(!calls.includes('confirm'));
  assert.equal(result.stores.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('Could not recover Sample')));
});

test('a page an earlier search used is read again and kept, and saved for next time', async () => {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const activities = fakeActivities(calls);
  const page = {
    name: 'Corner Shop',
    address: '5 Corner Ave, Chicago, IL',
    product: 'Guinness Draught 8-pack',
    source_url: 'https://corner.test/guinness',
  };
  activities.rememberedPages = async () => [page];
  activities.rememberPages = async (_area, pages) => {
    saved.push(...pages);
  };
  activities.researchStores = async () => ({ stores: [], notes: '', sources: [] });
  activities.readPricePage = async (url) => {
    calls.push(`page:${url}`);
    return { status: 'ok', text: PRODUCT_PAGE, url, note: '' };
  };
  const models = scriptedModels({ verifier: [verdict({})] });
  const result = await runWorkflow<Result>('beerRun', [options], activities, models.provider);

  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].name, 'Corner Shop');
  assert.equal(result.stores[0].price, 18);
  assert.equal(result.stores[0].price_check?.status, 'verified');
  // Read once to get the price. The price check reuses that read.
  assert.deepEqual(
    calls.filter((call) => call.startsWith('page:')),
    ['page:https://corner.test/guinness'],
  );
  assert.deepEqual(models.turns, ['verifier']);
  assert.equal(saved.length, 1);
});

test('a remembered page that no longer shows the 8-pack is dropped from memory', async () => {
  const calls: string[] = [];
  const saved: unknown[] = [];
  const activities = fakeActivities(calls);
  activities.rememberedPages = async () => [
    {
      name: 'Corner Shop',
      address: '5 Corner Ave, Chicago, IL',
      product: 'Guinness Draught 8-pack',
      source_url: 'https://corner.test/guinness',
    },
  ];
  activities.rememberPages = async (_area, pages) => {
    saved.push(...pages);
  };
  activities.researchStores = async () => ({ stores: [], notes: '', sources: [] });
  activities.readPricePage = async (url) => ({
    status: 'ok',
    text: 'Guinness Draught Stout 4pk Cans\n$9.99',
    url,
    note: '',
  });
  const result = await runWorkflow<Result>('beerRun', [options], activities);
  assert.equal(result.stores.length, 0);
  assert.equal(saved.length, 0);
});

// Real activities take seconds, so the page's poll is always parked when the
// next event arrives. Instant fakes would let the run finish between polls.
function slow(activities: BeerRunActivities): BeerRunActivities {
  const delayed = { ...activities };
  for (const name of Object.keys(delayed) as (keyof BeerRunActivities)[]) {
    const run = activities[name] as (...args: unknown[]) => Promise<unknown>;
    (delayed as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return run(...args);
    };
  }
  return delayed;
}

test('the live feed reports each step while the run is going', async () => {
  const calls: string[] = [];
  const models = scriptedModels({ recovery: recovers, verifier: [verdict({})] });
  const messages = await withWorker(slow(droppedStore(calls)), models.provider, async (client) => {
    const workflowId = testId();
    const handle = await client.workflow.start('beerRun', {
      taskQueue: 'test',
      workflowId,
      args: [options],
    });
    const seen: string[] = [];
    const feed = WorkflowStreamClient.create(client, workflowId)
      .topic<ProgressEvent>(PROGRESS_TOPIC)
      .subscribe(0, { pollCooldown: '50ms' });
    for await (const event of feed) {
      seen.push(event.data.message);
      if (event.data.message.startsWith('Ranking')) break;
    }
    await handle.result();
    return seen;
  });
  assert.match(messages[0], /Locating your address/);
  assert.ok(messages.some((message) => message.startsWith('Recovery agent: searching Sample')));
  assert.ok(messages.some((message) => message.includes("Sample's price is on the cited page")));
  assert.match(messages.at(-1)!, /^Ranking/);
});
