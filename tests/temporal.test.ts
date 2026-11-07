/*
  The Temporal workflow, run by a real worker against a local test server,
  with the activities swapped for fakes. No OpenAI call and no browser.

  These tests prove the workflow bundles, schedules the steps in order, keeps
  a gas failure from failing the run, and passes a store failure's sentence
  through to the page. The first run downloads Temporal's test server, so it
  needs network access once.
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationFailure } from '@temporalio/common';
import { failureText } from '../temporal/failure.ts';
import type { Result, SearchOptions } from '../workflow.ts';
import type { BeerRunActivities } from '../temporal/contracts.ts';
import { fakeActivities, options, runWorkflow } from './temporal-harness.ts';

function runBeerRun(activities: BeerRunActivities, input: SearchOptions) {
  return runWorkflow<Result>('beerRun', [input], activities);
}

test('workflow locates, researches, confirms only valid offers, and ranks', async () => {
  const calls: string[] = [];
  const result = await runBeerRun(fakeActivities(calls), options);
  assert.deepEqual(calls.slice(0, 2), ['locate', 'recall']);
  assert.deepEqual(calls.slice(2, 4).sort(), ['gas', 'stores']);
  // The offer with no pack count goes to the recovery agent, which gives up without a tool call.
  // The kept store's page is then read for the price check, and the run ends
  // by saving the pages that worked.
  assert.deepEqual(calls.slice(4), ['confirm', 'page', 'remember']);
  assert.equal(result.stores.length, 1);
  assert.equal(result.stores[0].total, 18.98);
  assert.equal(result.stores[0].price_check?.status, 'unreadable');
  assert.equal(result.gas.price, 3.5);
  assert.ok(result.warnings.some((warning) => warning.includes('Could not recover Sample')));
});

test('gas failure keeps shelf prices; store failure text reaches the page', async () => {
  const calls: string[] = [];
  const activities = fakeActivities(calls);
  activities.researchGas = async () => {
    throw ApplicationFailure.nonRetryable('Gas lookup failed');
  };
  const shelfOnly = await runBeerRun(activities, options);
  assert.equal(shelfOnly.gas.price, null);
  assert.equal(shelfOnly.stores[0].total, null);

  activities.researchStores = async () => {
    throw ApplicationFailure.nonRetryable('Research did not complete.');
  };
  await assert.rejects(runBeerRun(activities, options), (error) => {
    assert.equal(failureText(error), 'Research did not complete.');
    return true;
  });
});

test('demo and gas override schedule no research they do not need', async () => {
  const calls: string[] = [];
  const demo = await runBeerRun(fakeActivities(calls), { ...options, demo: true });
  assert.equal(demo.demo, true);
  assert.deepEqual(calls, []);

  const overrideCalls: string[] = [];
  const override = await runBeerRun(fakeActivities(overrideCalls), {
    ...options,
    gas_override: 4,
  });
  assert.equal(override.gas.price, 4);
  assert.ok(!overrideCalls.includes('gas'));
});
