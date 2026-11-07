/*
  The durable beer run.

  The steps are the same ones liveSearch runs in process. Here, each step that
  touches the network is an activity. Replay reads the activity result from
  history instead of searching again. Ranking stays in this function because
  it is ordinary arithmetic: shelf price plus fuel. The model does not pick
  a winner, and neither does an activity.

  Two agents run here too (temporal/agents.ts). A store the first pass drops
  gets a recovery agent, which searches again its own way. Every kept store
  gets a price check against its cited page. A page that shows a different
  price removes the store.

  Every step is reported on a WorkflowStream topic, which the server relays to
  the page as a live feed. Those events live in workflow memory and are
  rebuilt on replay. They are not activities and cost no history of their own.

  Demo mode is the same fictional ranking as the in-process path. It schedules
  no activities, so it does not need a key or a browser.
*/

import {
  allHandlersFinished,
  CancellationScope,
  condition,
  defineQuery,
  log,
  metricMeter,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import { WorkflowStream } from '@temporalio/workflow-streams/workflow';
import {
  areaLabel,
  assembleBeerRun,
  demoSearch,
  gasFromResearch,
  mergeOffers,
  offerProblem,
  offersToCheck,
  worthRecovering,
} from '../workflow.ts';
import type { Offer, SearchOptions, Store } from '../workflow.ts';
import type { PriceCheck } from '../price-check.ts';
import { recoverStore, rereadRememberedPage, verifyStorePrice } from './agents.ts';
import type { Report } from './agents.ts';
import type { BeerRunActivities, ConfirmStoreResult, RememberedPage } from './contracts.ts';
import { BEER_RUN_PROGRESS, PROGRESS_TOPIC } from './progress.ts';
import type { BeerRunView, ProgressEvent } from './progress.ts';

export { priceWatch } from './watch.ts';

export const beerRunProgress = defineQuery<BeerRunView>(BEER_RUN_PROGRESS);

// Every activity gets three attempts: two retries cover a page that did not
// finish drawing or a model call that timed out.
const maps = proxyActivities<Pick<BeerRunActivities, 'locateAddress' | 'confirmStore'>>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 3 },
});
const research = proxyActivities<Pick<BeerRunActivities, 'researchStores' | 'researchGas'>>({
  startToCloseTimeout: '4 minutes',
  retry: { maximumAttempts: 3 },
});
const memory = proxyActivities<Pick<BeerRunActivities, 'rememberedPages' | 'rememberPages'>>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

// Recovery costs up to two more searches per store. Three stores is the cap.
const MAX_RECOVERIES = 3;

// A counter in Grafana. Temporal adds the namespace, task queue, and workflow
// type, and skips the count while a workflow replays.
function count(name: string, tags: Record<string, string> = {}) {
  metricMeter.createCounter(`guinness_${name}`).add(1, tags);
}

function priceCheckMessage(store: Store, check: PriceCheck) {
  if (check.status === 'verified') return `Verifier: ${store.name}'s price is on the cited page.`;
  if (check.status === 'mismatch') return `Verifier: ${store.name} excluded. ${check.note}`;
  return `Verifier: ${store.name} kept unchecked. ${check.note}`;
}

export async function beerRun(options: SearchOptions): Promise<ReturnType<typeof demoSearch>> {
  // The page polls this. 0 locate, 1 research, 2 map checks, 3 price checks,
  // 4 rank. The HTTP handler reports DONE_STEP once the workflow has returned.
  let step = 0;
  let foundStores: Store[] = [];
  setHandler(beerRunProgress, (): BeerRunView => ({ step, stores: foundStores }));
  const stream = new WorkflowStream();
  const feed = stream.topic<ProgressEvent>(PROGRESS_TOPIC);
  const report: Report = (message) => {
    log.info(message, { step });
    feed.publish({ step, message });
  };

  if (options.demo) return demoSearch(options);

  try {
    return await search(
      options,
      report,
      (next) => {
        step = next;
      },
      (stores) => {
        foundStores = stores;
      },
    );
  } finally {
    // Release the page's open poll so the run can close without abandoning it.
    stream.detachPollers();
    await CancellationScope.nonCancellable(() => condition(allHandlersFinished));
  }
}

async function search(
  options: SearchOptions,
  report: Report,
  setStep: (step: number) => void,
  setStores: (stores: Store[]) => void,
) {
  report('Locating your address on the map.');
  const origin = await maps.locateAddress(options.address);
  const area = areaLabel(origin);
  setStep(1);
  const remembered = await memory.rememberedPages(area).catch(() => [] as RememberedPage[]);
  report(
    remembered.length
      ? `Researching stores and gas near ${area}, and rereading ${remembered.length} price page${remembered.length === 1 ? '' : 's'} from earlier searches.`
      : `Researching stores and gas near ${area}.`,
  );

  // Stores, gas, and the remembered pages do not depend on each other. A gas
  // failure is a null price, and a remembered page that fails is skipped.
  // Neither fails the beer run. A store-research failure does. Each rejection
  // handler is attached before the activities are awaited, so one error cannot
  // escape as an unhandled rejection while another activity is still running.
  const storePromise = research.researchStores(area, options.radius);
  const gasPromise =
    options.gas_override == null
      ? research.researchGas(area).then(
          (found) => found,
          () => null,
        )
      : Promise.resolve(null);
  const rereadPromise = rereadPages(remembered, report);
  const [storeLookup, gasLookup, reread] = await Promise.all([
    storePromise,
    gasPromise,
    rereadPromise,
  ]);

  setStep(2);
  const offers = offersToCheck(mergeOffers(reread.offers, storeLookup.stores));
  report(
    offers.length
      ? `Checking ${offers.length} candidate offer${offers.length === 1 ? '' : 's'}.`
      : 'No candidate offers.',
  );
  const seen: string[] = [];
  const stores: Store[] = [];
  const warnings: string[] = [];
  const sources = new Set([
    ...storeLookup.sources,
    ...reread.offers.map((offer) => offer.source_url),
  ]);
  let recoveries = 0;

  // One store at a time. Each confirmation opens map pages, and a burst of
  // them looks like automated traffic.
  for (const offer of offers) {
    let placed: ConfirmStoreResult | null = null;
    let failure = offerProblem(offer, sources);
    if (!failure) {
      report(`Placing ${offer.name} on the map.`);
      placed = await maps.confirmStore({
        offer,
        origin: origin.point,
        radius: options.radius,
        seenAddresses: seen,
        sources: [...sources],
        id: String(stores.length),
      });
      // No store and no warning means outside the radius or a duplicate. That
      // is an answer, not a failure, and is not worth another search.
      if (!placed.store && placed.warning) failure = placed.warning;
    }
    if (failure) count('offers_dropped', { stage: placed ? 'map' : 'research' });

    if (failure && recoveries < MAX_RECOVERIES && worthRecovering(offer)) {
      recoveries += 1;
      report(`${offer.name} was dropped: ${failure} Sending the recovery agent.`);
      const recovered = await recoverStore(
        {
          target: offer,
          problem: failure,
          area,
          radius: options.radius,
          origin: origin.point,
          seenAddresses: seen,
          id: String(stores.length),
        },
        report,
      );
      if (recovered.summary) report(`Recovery agent: ${recovered.summary}`);
      count('recoveries', { outcome: recovered.store ? 'recovered' : 'failed' });
      placed = recovered;
    }

    if (!placed) continue;
    if (placed.locatedAddress) seen.push(placed.locatedAddress);
    if (placed.warning) warnings.push(placed.warning);
    if (placed.store) {
      stores.push(placed.store);
      setStores([...stores]);
      count('stores_kept', { recovered: String(Boolean(placed.store.recovered)) });
      report(`Kept ${placed.store.name}, ${placed.store.radius_miles} mi away.`);
    }
  }

  setStep(3);
  const checked = await checkPrices(stores, warnings, report, reread.checks);
  setStores(checked);
  // A failed save only means the next search starts from scratch.
  await memory.rememberPages(area, pagesToRemember(checked, reread.unreadable)).catch(() => {});

  setStep(4);
  report('Ranking by shelf price plus round-trip fuel.');
  return assembleBeerRun({
    options,
    location: origin.address,
    stores: checked,
    gas: gasFromResearch(
      gasLookup == null ? null : { data: gasLookup.gas, sources: gasLookup.sources },
      area,
      options.gas_override,
    ),
    notes: storeLookup.notes,
    warnings,
  });
}

// Remembered pages are read one at a time, like the map checks, while store
// and gas research run. A page that did not load this time is kept for next
// time. A page that loaded but no longer shows the 8-pack is let go.
async function rereadPages(pages: RememberedPage[], report: Report) {
  const offers: Offer[] = [];
  const checks = new Map<string, PriceCheck>();
  const unreadable: RememberedPage[] = [];
  for (const page of pages) {
    const { offer, check } = await rereadRememberedPage(page, report);
    count('price_checks', { status: check.status, page: 'remembered' });
    if (offer) {
      offers.push(offer);
      checks.set(offer.source_url, check);
      report(`${page.name}: $${offer.price?.toFixed(2)} on the remembered page.`);
    } else {
      if (check.status === 'unreadable') unreadable.push(page);
      report(`${page.name}: the remembered page did not give a price. ${check.note}`);
    }
  }
  return { offers, checks, unreadable };
}

// Pages whose price the verifier found today, plus remembered pages that only
// failed to load. Everything else is dropped from memory.
function pagesToRemember(stores: Store[], unreadable: RememberedPage[]) {
  const pages: RememberedPage[] = stores
    .filter((store) => store.price_check?.status === 'verified')
    .map((store) => ({
      name: store.name,
      address: store.address,
      product: store.product,
      source_url: store.source_url,
    }));
  for (const page of unreadable) {
    if (!pages.some((item) => item.source_url === page.source_url && item.name === page.name)) {
      pages.push(page);
    }
  }
  return pages;
}

// One page at a time, for the same reason as the map checks. A store whose
// page shows a different price is removed, with the page's price in the warning.
// A price just read from a remembered page was already checked, so it is not
// read a second time.
async function checkPrices(
  stores: Store[],
  warnings: string[],
  report: Report,
  alreadyChecked: Map<string, PriceCheck>,
) {
  const kept: Store[] = [];
  for (const store of stores) {
    const earlier = alreadyChecked.get(store.source_url);
    if (earlier && earlier.page_price === store.price) {
      kept.push({ ...store, price_check: earlier });
      continue;
    }
    const check = await verifyStorePrice(store, report);
    count('price_checks', { status: check.status, page: 'cited' });
    report(priceCheckMessage(store, check));
    if (check.status === 'mismatch') {
      warnings.push(`${store.name} was excluded. ${check.note}`);
      continue;
    }
    kept.push({ ...store, price_check: check });
  }
  return kept;
}
