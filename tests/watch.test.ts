/*
  Price watches on a local Temporal test server. Demo searches keep these
  fast: each check is a real child beerRun, but it schedules no activities.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_WATCH_VIEW, STOP_PRICE_WATCH } from '../temporal/progress.ts';
import type { WatchView } from '../temporal/progress.ts';
import { validateWatch } from '../workflow.ts';
import { fakeActivities, options, scriptedModels, testId, withWorker } from './temporal-harness.ts';

const demoSearch = { ...options, demo: true };

test('a watch ends as soon as a check is at or under the target', async () => {
  const watch = validateWatch({ ...demoSearch, target_price: 100, interval_hours: 24 });
  const view = await withWorker(fakeActivities([]), scriptedModels().provider, async (client) => {
    const result = await client.workflow.execute('priceWatch', {
      taskQueue: 'test',
      workflowId: testId(),
      args: [watch],
    });
    return result as WatchView;
  });
  assert.equal(view.status, 'met');
  assert.equal(view.checks_done, 1);
  assert.ok(view.met && view.met.best != null && view.met.best <= 100);
  assert.ok(view.met?.store);
});

test('a watch that misses its target waits, and stops when asked', async () => {
  const watch = validateWatch({ ...demoSearch, target_price: 1, interval_hours: 6 });
  const view = await withWorker(fakeActivities([]), scriptedModels().provider, async (client) => {
    const handle = await client.workflow.start('priceWatch', {
      taskQueue: 'test',
      workflowId: testId(),
      args: [watch],
    });
    let current = await handle.query<WatchView>(PRICE_WATCH_VIEW);
    for (let tries = 0; current.status !== 'waiting' && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await handle.query<WatchView>(PRICE_WATCH_VIEW);
    }
    assert.equal(current.status, 'waiting');
    assert.ok(current.next_check_at);
    await handle.signal(STOP_PRICE_WATCH);
    return (await handle.result()) as WatchView;
  });
  assert.equal(view.status, 'stopped');
  assert.equal(view.checks_done, 1);
  assert.equal(view.recent[0].error, null);
  assert.ok(view.recent[0].best != null && view.recent[0].best > 1);
});
