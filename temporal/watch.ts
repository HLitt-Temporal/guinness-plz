/*
  A price watch: "tell me when an 8-pack near me drops under $12."

  The watch runs a full beer run on a schedule, as a child workflow, and keeps
  the cheapest pickup cost each one found. It ends when a check hits the
  target, when you stop it, or after WATCH_DAYS. Between checks it waits on a
  durable timer. No process has to stay awake, and a restarted worker resumes
  the wait where it was.

  Each check is its own beerRun with its own history, so a watch's history
  stays small. Every CHECKS_PER_RUN checks the watch continues as new and
  carries its recent checks forward.
*/

import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  isCancellation,
  log,
  metricMeter,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import { cheapestPickup } from '../workflow.ts';
import type { WatchOptions } from '../workflow.ts';
import { failureText } from './failure.ts';
import { PRICE_WATCH_VIEW, STOP_PRICE_WATCH } from './progress.ts';
import type { WatchCheck, WatchView } from './progress.ts';
import type { beerRun } from './workflows.ts';

export const priceWatchView = defineQuery<WatchView>(PRICE_WATCH_VIEW);
export const stopPriceWatch = defineSignal(STOP_PRICE_WATCH);

const CHECKS_PER_RUN = 10;
const RECENT_CHECKS = 10;
const HOUR_MS = 3_600_000;

export interface PriceWatchInput extends WatchOptions {
  // Carried across continue-as-new.
  checks_done?: number;
  recent?: WatchCheck[];
}

export async function priceWatch(input: PriceWatchInput): Promise<WatchView> {
  const view: WatchView = {
    status: 'checking',
    address: input.search.address,
    radius: input.search.radius,
    demo: input.search.demo,
    target_price: input.target_price,
    interval_hours: input.interval_hours,
    checks_done: input.checks_done ?? 0,
    max_checks: input.max_checks,
    next_check_at: null,
    recent: input.recent ?? [],
    met: null,
  };
  let stopped = false;
  setHandler(priceWatchView, () => view);
  setHandler(stopPriceWatch, () => {
    stopped = true;
  });

  let checksThisRun = 0;
  while (!stopped && view.checks_done < input.max_checks) {
    if (checksThisRun === CHECKS_PER_RUN) {
      await continueAsNew<typeof priceWatch>({
        ...input,
        checks_done: view.checks_done,
        recent: view.recent,
      });
    }
    view.status = 'checking';
    view.next_check_at = null;
    const check = await runCheck(input, view.checks_done + 1);
    view.checks_done += 1;
    checksThisRun += 1;
    view.recent = [check, ...view.recent].slice(0, RECENT_CHECKS);
    const met = check.best != null && check.best <= input.target_price;
    log.info('Price watch check finished.', { ...check, target_price: input.target_price });
    metricMeter
      .createCounter('guinness_watch_checks')
      .add(1, { outcome: check.error ? 'error' : met ? 'met' : 'above_target' });
    if (met) {
      view.status = 'met';
      view.met = check;
      return view;
    }
    if (view.checks_done >= input.max_checks) break;

    const wait = input.interval_hours * HOUR_MS;
    view.status = 'waiting';
    view.next_check_at = new Date(Date.now() + wait).toISOString();
    await condition(() => stopped, wait);
  }

  view.status = stopped ? 'stopped' : 'finished';
  view.next_check_at = null;
  return view;
}

// A failed check is recorded and the watch keeps going. A provider outage on
// Tuesday should not end a two-week watch.
async function runCheck(input: PriceWatchInput, number: number): Promise<WatchCheck> {
  const at = new Date().toISOString();
  try {
    const result = await executeChild<typeof beerRun>('beerRun', {
      args: [input.search],
      workflowId: `${workflowInfo().workflowId}-check-${number}`,
    });
    const best = cheapestPickup(result);
    return { at, best: best?.cost ?? null, store: best?.name ?? null, error: null };
  } catch (error) {
    if (isCancellation(error)) throw error;
    return { at, best: null, store: null, error: failureText(error) };
  }
}
