/*
  Names and shapes shared by the workflows, the worker, and the HTTP server.

  The workflow answers the progress query and publishes the live feed. The
  server asks the query, relays the feed to the page, and reads price watches.
  Keeping these free of the workflow SDK means the server and the page can
  import them without loading workflow code.
*/

import type { Store } from '../workflow.ts';

export const BEER_RUN_PROGRESS = 'beerRunProgress';

// 0 locate, 1 research, 2 map checks and recovery, 3 price checks, 4 rank.
// The HTTP handler reports DONE_STEP once the workflow has returned.
export const DONE_STEP = 5;

export interface BeerRunView {
  step: number;
  // Stores already placed on the map. The page shows these while later
  // branches are still being checked, instead of waiting for the whole run.
  stores: Store[];
}

// The live feed topic on the beer run's WorkflowStream. One event per thing
// the run is doing, in words the page shows as they happen.
export const PROGRESS_TOPIC = 'progress';

export interface ProgressEvent {
  step: number;
  message: string;
}

// The model name agents ask for. The worker maps it to OPENAI_MODEL, because
// workflow code cannot read the environment.
export const AGENT_MODEL = 'guinness-research';

export const PRICE_WATCH_VIEW = 'priceWatchView';
export const STOP_PRICE_WATCH = 'stopPriceWatch';

// One scheduled search. best is the cheapest pickup cost it found, or null
// when it found no store or failed. error is the failure's sentence.
export interface WatchCheck {
  at: string;
  best: number | null;
  store: string | null;
  error: string | null;
}

export interface WatchView {
  status: 'checking' | 'waiting' | 'met' | 'stopped' | 'finished';
  address: string;
  radius: number;
  demo: boolean;
  target_price: number;
  interval_hours: number;
  checks_done: number;
  max_checks: number;
  next_check_at: string | null;
  // Newest first.
  recent: WatchCheck[];
  met: WatchCheck | null;
}
