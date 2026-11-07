/*
  This file is the beer-run rules.

  A normal function does the same steps every time you call it. An agent is a
  language model with a goal and tools. It can search, read what came back, and
  search again until it can answer. This file does not let the model run the
  whole beer run. It gives the model one narrow job at a time, then checks the
  answer before anything is shown.

  The Temporal workflow in temporal/workflows.ts runs these same steps as
  durable activities. This file is bundled into that workflow, so it must stay
  free of network calls, process.env, and the headless browser. Those live in
  research.ts and headless-maps.ts, and activities call them.

  One live search does this:

  1. Check the form. A bad address never reaches the model.
  2. Look up the street address in a headless browser. The model only hears
     the city and state, not the street.
  3. Start two research tasks together. One finds stores and prices. One finds
     a local gas price, unless you typed one in.
  4. Drop any price the search did not actually cite, and any store that
     cannot be placed inside the radius. Any Guinness product and size counts.
  5. Read a real driving route there and back. Guessing the miles is not allowed.
  6. Rank by shelf price plus fuel. That math is ordinary code. The model does
     not pick a winner.

  The model call is one HTTP request to OpenAI's Responses API. OpenAI runs the
  inner loop for us: the model asks for a web search, OpenAI runs it, the model
  reads the pages, and it may search again until it can fill in the JSON we
  required, or until it hits the search limit. We do not write that loop.
*/

import type { PriceCheck } from './price-check.ts';

// Thrown when a step cannot be trusted. The server shows this text. It does not
// quietly switch a failed live search over to demo data.
export class WorkflowError extends Error {}

// What the form is allowed to ask for, after validation. demo true means
// "do not call the model." The other fields are the goal we hand to the workflow.
export interface SearchOptions {
  address: string;
  radius: number;
  mpg: number;
  gas_override: number | null;
  demo: boolean;
}

export interface Point {
  lat: number;
  lng: number;
}

// One store the research step claims to have found. price can be null because
// the model is told to leave a number blank instead of inventing one. Our code
// still throws the offer away unless the price, pack, and source all check out.
export interface Offer {
  name: string;
  address: string;
  product: string;
  pack_count: number;
  price: number | null;
  currency: string;
  source_url: string;
  availability: 'in_stock' | 'unknown' | 'out_of_stock';
  branch_price_confirmed: boolean;
  notes: string;
}

// An offer that survived the checks and has a map location. Driving miles stay
// null when the route lookup fails. The shelf price can still be shown. The
// fuel total cannot, because a missing route is not a free trip.
export interface Store extends Omit<Offer, 'price'> {
  price: number;
  id: string;
  radius_miles: number;
  round_trip_miles: number | null;
  round_trip_minutes: number | null;
  route_source_urls?: string[];
  fuel_cost: number | null;
  total: number | null;
  // What the verifier found on the cited page. Missing on demo stores.
  price_check?: PriceCheck;
  // True when the first search dropped this store and the recovery agent found it.
  recovered?: boolean;
}

export interface Gas {
  price: number | null;
  source_url: string;
  location: string;
  observed_date: string;
  notes: string;
}

// The finished answer the page renders. warnings are the places the agent was
// unsure or a lookup failed. They are shown. They are not hidden.
export interface Result {
  stores: Store[];
  gas: Gas;
  location: string;
  demo: boolean;
  warnings: string[];
  checked_at: string;
}

// The page's progress stepper. 0 locate, 1 research, 2 routes, 3 rank.
export type Progress = (step: number) => void;

// data is what the model filled in. sources is the list of URLs the web-search
// tool actually opened or cited. A price is only kept when its source_url is in
// this set. A model can type any URL. This set is how we notice.
export interface ResearchResult<T> {
  data: T;
  sources: Set<string>;
}

// The tools this workflow is allowed to use. geocode and route are ordinary
// programs (a headless browser). stores and gas are the model-plus-web-search
// steps. Tests pass fakes here so they never call OpenAI or open a browser.
// close shuts that browser when a live search finishes.
export interface Providers {
  geocode(address: string): Promise<{ point: Point; address: string; locality?: string }>;
  route(a: Point, b: Point): Promise<{ miles: number; minutes: number; source_url?: string }>;
  stores(area: string, radius: number): Promise<ResearchResult<{ stores: Offer[]; notes: string }>>;
  gas(area: string): Promise<ResearchResult<Gas>>;
  close?(): Promise<void>;
}

const EARTH_RADIUS_MILES = 3958.7613;
const DAY_MS = 86_400_000;
// The model may name many stores. We only spend map lookups on the first few.
const MAX_OFFERS = 8;
// A cited gas price older than this is treated as missing, not as today's price.
const GAS_MAX_AGE_DAYS = 7;
// A real drive cannot be meaningfully shorter than the straight-line distance.
const SHORTEST_BELIEVABLE_ROUTE = 0.95;

const DEMO_STORES = [
  // Fictional on purpose. Demo mode is a dry run of the ranking, not a cached agent result.
  { name: 'Sample neighborhood market', price: 17.99, miles: 1.2 },
  { name: 'Sample bottle shop', price: 16.49, miles: 4.8 },
  { name: 'Sample supermarket', price: 18.49, miles: 2.6 },
  { name: 'Sample warehouse store', price: 15.99, miles: 9.3 },
];

type GeocodedPlace = { point: Point; address: string; locality?: string };
type PricedOffer = Offer & { price: number };
// JSON Schema, written as plain objects. The Responses API uses it as a form
// the model must fill in. strict mode rejects an answer that does not match.
export type Schema = Record<string, unknown>;

// Agents return JSON that can still contain strings, blanks, or absurd numbers.
// Every number we keep has to parse and sit inside a range a person could mean.
export function number(value: unknown, low: number, high: number, label: string): number {
  const notANumber = (typeof value !== 'number' && typeof value !== 'string') || value === '';
  if (notANumber) throw new WorkflowError(`${label} must be a number.`);

  const parsed = Number(value);
  const outOfRange = !Number.isFinite(parsed) || parsed < low || parsed > high;
  if (outOfRange) throw new WorkflowError(`${label} must be between ${low} and ${high}.`);
  return parsed;
}

function requireAddress(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 5 || value.length > 250) {
    throw new WorkflowError('Enter a full US address, including city and state.');
  }
  return value.trim();
}

function optionalGasPrice(value: unknown) {
  if (value == null || value === '') return null;
  return number(value, 0.1, 20, 'Gas price');
}

// First step of the workflow, and it is not a model call. The form is checked
// here so a live search is never started for a radius of 10,000 miles.
// demo defaults to true: a request that forgets the flag stays on fictional data.
export function validate(input: unknown): SearchOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowError('Expected a search object.');
  }

  const data = input as Record<string, unknown>;
  if (data.demo !== undefined && typeof data.demo !== 'boolean') {
    throw new WorkflowError('Demo must be true or false.');
  }

  return {
    address: requireAddress(data.address),
    radius: number(data.radius, 1, 50, 'Radius'),
    mpg: number(data.mpg, 5, 150, 'MPG'),
    gas_override: optionalGasPrice(data.gas_override),
    demo: data.demo !== false,
  };
}

// How often a price watch may run a full search, in hours. Each live check
// spends several web searches, so there is no "every few minutes."
export const WATCH_INTERVAL_HOURS = [6, 12, 24, 72];
export const WATCH_DAYS = 14;

export interface WatchOptions {
  search: SearchOptions;
  target_price: number;
  interval_hours: number;
  max_checks: number;
}

// A watch is a search plus a target. It stops after WATCH_DAYS even if the
// target is never hit, so a forgotten watch does not spend searches forever.
export function validateWatch(input: unknown): WatchOptions {
  const search = validate(input);
  const data = input as Record<string, unknown>;
  const interval = number(data.interval_hours, 1, 168, 'Check interval');
  if (!WATCH_INTERVAL_HOURS.includes(interval)) {
    throw new WorkflowError(
      `Check interval must be one of ${WATCH_INTERVAL_HOURS.join(', ')} hours.`,
    );
  }
  return {
    search,
    target_price: number(data.target_price, 1, 200, 'Target price'),
    interval_hours: interval,
    max_checks: Math.ceil((WATCH_DAYS * 24) / interval),
  };
}

// Two URLs can point at the same page with a trailing slash or different host
// spelling. This key is how "did the search actually open this page?" is decided.
function sourceKey(url: string) {
  const parsed = new URL(url);
  return parsed.hostname + parsed.pathname.replace(/\/$/, '') + parsed.search;
}

// A price is supported only when the model copied a URL from its own search
// results. A made-up link, or a link to a page the tool never returned, fails.
export function supported(url: string, sources: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const wanted = sourceKey(url);
    return [...sources].some((source) => sourceKey(source) === wanted);
  } catch {
    return false;
  }
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

// Straight-line miles between two coordinates. Used as the search radius and as
// a sanity check on driving routes. This is geometry, not something we ask the model.
export function radiusMiles(a: Point, b: Point): number {
  const latitude = toRadians(b.lat - a.lat);
  const longitude = toRadians(b.lng - a.lng);
  const haversine =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(longitude / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

function roundToHundredths(amount: number) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function fuelForTrip(miles: number | null, gasPrice: number | null, mpg: number) {
  if (gasPrice == null || miles == null) return null;
  return (miles / mpg) * gasPrice;
}

function byPickupCost(a: Store, b: Store) {
  const unknownTotal = Number(a.total == null) - Number(b.total == null);
  const cost = (a.total ?? a.price) - (b.total ?? b.price);
  const distance = (a.round_trip_miles ?? Infinity) - (b.round_trip_miles ?? Infinity);
  return unknownTotal || cost || distance;
}

// Pickup cost is shelf price plus the gas for the round trip. Stores with a
// full total sort first. A store whose route failed stays in the list, sorted
// by shelf price, and is never labeled the cheapest trip.
export function rank(stores: Store[], gasPrice: number | null, mpg: number): Store[] {
  return stores
    .map((store) => {
      const fuel = fuelForTrip(store.round_trip_miles, gasPrice, mpg);
      return {
        ...store,
        fuel_cost: fuel == null ? null : roundToHundredths(fuel),
        total: fuel == null ? null : roundToHundredths(store.price + fuel),
      };
    })
    .sort(byPickupCost);
}

function demoStore(sample: (typeof DEMO_STORES)[number], index: number): Store {
  return {
    name: sample.name,
    price: sample.price,
    address: 'Fictional demo location',
    product: 'Guinness Draught · 8 × 14.9 fl oz cans',
    pack_count: 8,
    currency: 'USD',
    source_url: '',
    availability: 'unknown',
    branch_price_confirmed: false,
    notes: 'Synthetic price and distance; this store is not a real search result.',
    radius_miles: sample.miles,
    round_trip_miles: roundToHundredths(sample.miles * 2.5),
    round_trip_minutes: Math.round(sample.miles * 6 + 4),
    id: String(index),
    fuel_cost: null,
    total: null,
  };
}

// The same ranking math as a live search, with made-up stores. Demo mode is how
// you can click through the app before you have an API key. It never pretends
// these stores were found by an agent.
export function demoSearch(options: SearchOptions): Result {
  const gasPrice = options.gas_override ?? 3.49;
  const stores = DEMO_STORES.filter((store) => store.miles <= options.radius).map(demoStore);
  return {
    stores: rank(stores, gasPrice, options.mpg),
    gas: {
      price: gasPrice,
      source_url: '',
      location: 'Demo regular gasoline',
      observed_date: '',
      notes: options.gas_override == null ? 'Synthetic demo gas price' : 'User override',
    },
    location: 'Demo around your entered address',
    demo: true,
    warnings: ['All demo prices, stores, and distances are fictional.'],
    checked_at: new Date().toISOString(),
  };
}

// The city/state string the research steps see. The street address stays with
// the map lookup. The model does not need it, and we do not send it.
export function areaLabel(origin: GeocodedPlace) {
  return origin.locality ?? origin.address.split(',').slice(1).join(',').trim();
}

// You typed a gas price, so this search skips the gas agent entirely.
function manualGas(price: number): ResearchResult<Gas> {
  return {
    data: {
      price,
      source_url: '',
      location: 'Your gas price override',
      observed_date: new Date().toISOString().slice(0, 10),
      notes: 'Manually supplied',
    },
    sources: new Set<string>(),
  };
}

// Gas research can fail without failing the beer run. A null price means
// "show shelf prices only," which prepareGas turns a bad lookup into.
function failedGas(area: string): Gas {
  return {
    price: null,
    source_url: '',
    location: area,
    observed_date: '',
    notes: 'Local gas lookup failed.',
  };
}

function gasAgeDays(observedDate: string) {
  const today = new Date().toISOString().slice(0, 10);
  const observed = Date.parse(`${observedDate}T00:00:00Z`);
  const current = Date.parse(`${today}T00:00:00Z`);
  return (current - observed) / DAY_MS;
}

function listedPage(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  return parsed.hostname + parsed.pathname.replace(/\/$/, '');
}

function listedPageMatches(url: string, sources: Set<string>) {
  try {
    const wanted = listedPage(url);
    if (!wanted) return false;
    return [...sources].some((source) => {
      try {
        return listedPage(source) === wanted;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// The model is asked for a date. We still check it. A price with no date, a
// future date, or a date older than a week loses its number.
function keepRecentSourcedPrice(gas: Gas, sources: Set<string>) {
  const age = gasAgeDays(gas.observed_date);
  const fresh = Number.isFinite(age) && age >= 0 && age <= GAS_MAX_AGE_DAYS;
  if (!fresh || !listedPageMatches(gas.source_url, sources)) gas.price = null;
}

function clampGasPrice(gas: Gas) {
  if (gas.price == null) return;
  try {
    gas.price = number(gas.price, 0.1, 20, 'Sourced gas price');
  } catch {
    gas.price = null;
  }
}

// Gas and stores are started together. allSettled waits for both even if one
// throws, so a gas failure cannot skip the store result or become an unhandled
// rejection. A store failure is fatal. A gas failure becomes a null price.
function prepareGas(
  lookup: PromiseSettledResult<ResearchResult<Gas>>,
  area: string,
  gasOverride: number | null,
) {
  if (lookup.status === 'rejected') return failedGas(area);

  const gas = { ...lookup.value.data };
  if (gasOverride == null) keepRecentSourcedPrice(gas, lookup.value.sources);
  clampGasPrice(gas);
  return gas;
}

// The filter between "the model said so" and "we will drive there." Any
// Guinness product and size, US dollars, not marked out of stock, a real price,
// and a URL that showed up in the search. The sentence is what the recovery
// agent is told, so it can try a different search instead of repeating the one
// that failed.
export function offerProblem(item: Offer, sources: Set<string>): string | null {
  if (!Number.isInteger(item.pack_count) || item.pack_count < 1) {
    return 'The page did not say how many units the product comes in.';
  }
  if (item.currency !== 'USD') return 'The price was not in US dollars.';
  if (item.availability === 'out_of_stock') return 'The page said the product is out of stock.';
  if (item.price == null) return 'No public price was found for the product.';
  if (!supported(item.source_url, sources)) {
    return 'The cited price page was not one the web search returned.';
  }
  return null;
}

// Anything that fails offerProblem is skipped with no guess filled in.
export function isPricedEightPack(item: Offer, sources: Set<string>): item is PricedOffer {
  return offerProblem(item, sources) === null;
}

// A store the page says is out of stock is not worth another search.
export function worthRecovering(item: Offer) {
  return item.availability !== 'out_of_stock';
}

// What a watch compares against its target: the full trip when fuel is known,
// otherwise the shelf price. Same number the page sorts by.
export function cheapestPickup(result: Result): { name: string; cost: number } | null {
  let best: { name: string; cost: number } | null = null;
  for (const store of result.stores) {
    const cost = store.total ?? store.price;
    if (!best || cost < best.cost) best = { name: store.name, cost };
  }
  return best;
}

function believableRoute(leg: { miles: number; minutes: number }) {
  return (
    Number.isFinite(leg.miles) && leg.miles >= 0 && Number.isFinite(leg.minutes) && leg.minutes >= 0
  );
}

// The model may name many stores. Map lookups only run for the first few.
export function offersToCheck<T>(stores: readonly T[]): T[] {
  return stores.slice(0, MAX_OFFERS);
}

// A gas activity can fail without failing the beer run. null means the lookup
// failed. An override skips the lookup and uses the typed-in price.
export function gasFromResearch(
  found: { data: Gas; sources: string[] } | null,
  area: string,
  gasOverride: number | null,
): Gas {
  if (gasOverride != null) return manualGas(gasOverride).data;
  if (found == null) return failedGas(area);
  return prepareGas(
    { status: 'fulfilled', value: { data: found.data, sources: new Set(found.sources) } },
    area,
    null,
  );
}

// Shelf price plus fuel, after the activities have finished. notes and a missing
// gas price are warnings the page shows. They are not hidden.
export function assembleBeerRun(input: {
  options: SearchOptions;
  location: string;
  stores: Store[];
  gas: Gas;
  notes: string;
  warnings: string[];
}): Result {
  const warnings = [...input.warnings];
  if (input.notes) warnings.push(input.notes);
  if (input.gas.price == null) {
    warnings.push(
      'No recent sourced local gas price. Results show product prices only. Enter a gas price override and search again.',
    );
  }
  return {
    stores: rank(input.stores, input.gas.price, input.options.mpg),
    gas: input.gas,
    location: input.location,
    demo: false,
    warnings,
    checked_at: new Date().toISOString(),
  };
}

// Driving distance is a tool our code calls, twice: there, and back. A route
// that is shorter than a straight line is rejected. If either leg fails, the
// store stays, with fuel left blank. The returned sentence is that blank, not a guess.
async function addDrivingDistance(
  store: Store,
  origin: Point,
  branch: Point,
  providers: Pick<Providers, 'route'>,
  storeName: string,
): Promise<string | null> {
  try {
    const [outbound, inbound] = await Promise.all([
      providers.route(origin, branch),
      providers.route(branch, origin),
    ]);
    if (![outbound, inbound].every(believableRoute)) {
      throw new WorkflowError('Invalid driving route.');
    }

    const straightLine = radiusMiles(origin, branch);
    const shorterThanStraightLine =
      outbound.miles < straightLine * SHORTEST_BELIEVABLE_ROUTE ||
      inbound.miles < straightLine * SHORTEST_BELIEVABLE_ROUTE;
    if (shorterThanStraightLine) {
      throw new WorkflowError('Route is shorter than the straight-line distance.');
    }

    store.round_trip_miles = roundToHundredths(outbound.miles + inbound.miles);
    store.round_trip_minutes = Math.round(outbound.minutes + inbound.minutes);
    store.route_source_urls = [outbound.source_url, inbound.source_url].filter(
      (url): url is string => Boolean(url),
    );
    return null;
  } catch {
    return `Driving distance unavailable for ${storeName}; showing shelf price without a fuel estimate.`;
  }
}

// One candidate store. Geocoding confirms it is a real address inside the
// radius and not a duplicate of a store we already kept. A bad price or a
// failed geocode removes the store. A failed drive does not.
// seenAddresses is updated when a branch is kept, including a branch whose
// drive failed, so a later offer for the same building is still a duplicate.
export async function evaluateOffer(
  item: Offer,
  origin: Point,
  radius: number,
  providers: Pick<Providers, 'geocode' | 'route'>,
  seenAddresses: Set<string>,
  id: string,
): Promise<{ store: Store | null; warning: string | null; locatedAddress: string | null }> {
  try {
    const price = number(item.price, 0.01, 200, 'Store price');
    const branch = await providers.geocode(item.address);
    const distance = radiusMiles(origin, branch.point);
    if (distance > radius || seenAddresses.has(branch.address)) {
      return { store: null, warning: null, locatedAddress: null };
    }

    seenAddresses.add(branch.address);
    const store: Store = {
      ...item,
      price,
      address: branch.address,
      radius_miles: roundToHundredths(distance),
      round_trip_miles: null,
      round_trip_minutes: null,
      id,
      fuel_cost: null,
      total: null,
      route_source_urls: [],
    };
    const warning = await addDrivingDistance(store, origin, branch.point, providers, item.name);
    return { store, warning, locatedAddress: branch.address };
  } catch {
    return {
      store: null,
      warning: `Could not confirm a location or driving route for ${item.name}; excluded it.`,
      locatedAddress: null,
    };
  }
}

// Walk the model's store list one at a time. Routes open a browser page each,
// so doing them all at once would look like a burst of automated traffic.
async function collectStores(
  found: ResearchResult<{ stores: Offer[]; notes: string }>,
  origin: Point,
  options: SearchOptions,
  providers: Providers,
  warnings: string[],
) {
  const stores: Store[] = [];
  const seenAddresses = new Set<string>();
  for (const item of offersToCheck(found.data.stores)) {
    if (!isPricedEightPack(item, found.sources)) continue;
    const placed = await evaluateOffer(
      item,
      origin,
      options.radius,
      providers,
      seenAddresses,
      String(stores.length),
    );
    if (placed.warning) warnings.push(placed.warning);
    if (placed.store) stores.push(placed.store);
  }
  return stores;
}

// The in-process runner tests call with fake providers. A live search from the
// page does not use this function. temporal/workflows.ts runs the same steps
// as Temporal activities, plus the recovery and price-check agents, which
// only exist there. progress here is 0 locate, 1 research, 2 routes, 3 rank.
export async function liveSearch(
  options: SearchOptions,
  providers: Providers,
  progress: Progress = () => {},
): Promise<Result> {
  progress(0);
  const origin = await providers.geocode(options.address);
  const area = areaLabel(origin);
  progress(1);

  // Stores and gas do not depend on each other, so they run at the same time.
  // allSettled is used instead of Promise.all so a gas failure still lets us
  // read the store result. The .then-free handlers are attached by awaiting
  // here, before either rejection can escape as an unhandled promise.
  const [storeLookup, gasLookup] = await Promise.allSettled([
    providers.stores(area, options.radius),
    options.gas_override == null
      ? providers.gas(area)
      : Promise.resolve(manualGas(options.gas_override)),
  ]);
  if (storeLookup.status === 'rejected') throw storeLookup.reason;

  const gas = gasFromResearch(
    gasLookup.status === 'fulfilled'
      ? { data: gasLookup.value.data, sources: [...gasLookup.value.sources] }
      : null,
    area,
    options.gas_override,
  );
  progress(2);
  const warnings: string[] = [];
  const stores = await collectStores(storeLookup.value, origin.point, options, providers, warnings);
  progress(3);
  return assembleBeerRun({
    options,
    location: origin.address,
    stores,
    gas,
    notes: storeLookup.value.data.notes,
    warnings,
  });
}

// Every model call below asks for JSON that matches one of these schemas.
// additionalProperties: false and required: every field means the model cannot
// add a surprise field or leave a required one out. Unknown numbers are null,
// which is why price is ["number", "null"] instead of just "number".
function objectSchema(fields: Record<string, Schema>): Schema {
  return {
    type: 'object',
    properties: fields,
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

const text = { type: 'string' };
const nullableNumber = { type: ['number', 'null'] };

// First research step: names and addresses only. No beer prices yet. Asking for
// both at once makes the model reach for chains it already "knows."
const nearbySchema = objectSchema({
  places: {
    type: 'array',
    items: objectSchema({
      name: text,
      address: text,
      category: { type: 'string', enum: ['liquor_store', 'beer_store', 'grocery', 'other'] },
    }),
  },
  notes: text,
});

// Second research step: a price for a Guinness product, plus the page it came from.
const offerFields = objectSchema({
  name: text,
  address: text,
  product: text,
  pack_count: { type: 'integer' },
  price: nullableNumber,
  currency: text,
  source_url: text,
  availability: { type: 'string', enum: ['in_stock', 'unknown', 'out_of_stock'] },
  branch_price_confirmed: { type: 'boolean' },
  notes: text,
});

const storeSchema = objectSchema({
  stores: { type: 'array', items: offerFields },
  notes: text,
});

// The recovery agent's search: one store, one offer. found false means the
// search came back empty, and offer is a placeholder with a null price.
export const offerSchema = objectSchema({
  found: { type: 'boolean' },
  offer: offerFields,
  notes: text,
});

// Gas is its own small research task, with the same "null if you do not know" rule.
export const gasSchema = objectSchema({
  price: nullableNumber,
  source_url: text,
  location: text,
  observed_date: text,
  notes: text,
});

// Words that show up in almost every liquor-store name. Matching on these
// alone would treat "Joe's Liquor" and "Main Street Liquor" as the same store.
const GENERIC_STORE_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'of',
  'inc',
  'llc',
  'co',
  'company',
  'store',
  'stores',
  'shop',
  'shops',
  'liquor',
  'beer',
  'wine',
  'wines',
  'spirit',
  'spirits',
  'bottle',
  'bottles',
  'market',
  'markets',
  'grocery',
  'groceries',
  'supermarket',
  'supercenter',
  'warehouse',
  'club',
  'package',
  'beverages',
  'beverage',
  'foods',
  'food',
  'finer',
]);
// How many listing results we will spend a pricing search on. Local shops
// come first. Grocery is capped lower because the first search is told to
// list liquor and beer stores ahead of them.
const LOCAL_STORE_LIMIT = 8;
const GROCERY_STORE_LIMIT = 4;

export interface NearbyPlace {
  name: string;
  address: string;
  category: 'liquor_store' | 'beer_store' | 'grocery' | 'other';
}

// The function findLocalStores calls for each model turn. Tests pass a fake
// so they can check the two-step store search without a network call.
type WebResearch = <T>(
  prompt: string,
  schema: Schema,
  name: string,
  maxToolCalls?: number,
) => Promise<ResearchResult<T>>;

// Lowercase, drop punctuation, and glue spaced initials ("J P" -> "jp") so two
// spellings of one store name can be compared after the model paraphrases them.
function storeTokens(value: string) {
  let normalized = value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let collapsed = normalized.replace(/\b([a-z])\s+(?=[a-z]\b)/g, '$1');
  while (collapsed !== normalized) {
    normalized = collapsed;
    collapsed = normalized.replace(/\b([a-z])\s+(?=[a-z]\b)/g, '$1');
  }
  return collapsed.split(/\s+/).filter(Boolean);
}

function distinctiveTokens(name: string) {
  const tokens = storeTokens(name);
  const distinctive = tokens.filter((token) => !GENERIC_STORE_WORDS.has(token));
  return distinctive.length ? distinctive : tokens;
}

// "Binny's Beverage Depot" and "Binnys Beverages" should count as the same
// retailer when we drop duplicates. Generic words are ignored first, then
// every distinctive word in the shorter name has to appear in the longer one.
export function sameStoreName(left: string, right: string) {
  const a = distinctiveTokens(left);
  const b = distinctiveTokens(right);
  if (!a.length || !b.length) return false;
  const [smaller, larger] = a.length <= b.length ? [a, b] : [b, a];
  const rest = new Set(larger);
  return smaller.every((token) => rest.has(token));
}

function streetNumber(address: string) {
  return address.match(/\d+/)?.[0] ?? '';
}

// Two offers are the same branch when the retailer matches and the street
// number matches. The model often shortens an address between the listing
// search and the price search, so a full-string compare would keep duplicates.
function sameBranch(left: Offer, right: Offer) {
  if (!sameStoreName(left.name, right.name)) return false;
  const a = streetNumber(left.address);
  const b = streetNumber(right.address);
  if (a && b) return a === b;
  return storeTokens(left.address).join(' ') === storeTokens(right.address).join(' ');
}

// Offers from first win. An offer in rest for a branch first already has is dropped.
export function mergeOffers(first: Offer[], rest: Offer[]) {
  return [...first, ...rest.filter((offer) => !first.some((item) => sameBranch(item, offer)))];
}

// Any Guinness counts. Without this, the model skips a store that only lists a
// size or variant other than the one it guessed the shopper wanted.
const PRODUCT_NOTE =
  'Any Guinness beer product counts: any variant (Draught, Extra Stout, Foreign Extra, 0.0, Nitro Cold Brew, and so on), any container (cans or bottles), any can or bottle size, and any pack size, including singles. Return one offer per store, the lowest-priced Guinness product that store lists. Put the full product name with its pack size and container size in product, and the number of cans or bottles in pack_count (1 for a single).';

// Small shops rarely publish prices, and chain sites like Safeway hide the price
// until a store is picked. Instacart and delivery apps show a store's price per
// ZIP code, so they are allowed, with the branch price left unconfirmed.
const SOURCE_NOTE =
  "Search the retailer's own site first. If it shows no price, a public listing for that same store on any delivery, shopping, or price-listing site counts, such as Instacart, DoorDash, Uber Eats, Postmates, BringMeThat, Google Shopping, or a weekly-ad site. This list is examples, not a limit. Search for example \"<store name> Guinness instacart\". For a price from one of those sites, set branch_price_confirmed to false and say in notes which site it came from and that app prices can be higher than in store.";

// Dedupe the listing search and cap how many stores the next step will price.
function selectPlaces(places: NearbyPlace[]) {
  const seen = new Set<string>();
  const local: NearbyPlace[] = [];
  const grocery: NearbyPlace[] = [];
  for (const place of places) {
    const name = place.name.trim();
    const address = place.address.trim();
    if (!name || !address) continue;
    const key = `${storeTokens(name).join(' ')}|${storeTokens(address).join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const listed = { ...place, name, address };
    if (place.category === 'grocery') grocery.push(listed);
    else local.push(listed);
  }
  return [...local.slice(0, LOCAL_STORE_LIMIT), ...grocery.slice(0, GROCERY_STORE_LIMIT)];
}

// A priced offer is kept only when its name matches a store the listing search
// already named. If the price page omitted the street, we copy the address
// from that listing. A retailer the model added from memory returns null.
export function listedOffer(offer: Offer, places: NearbyPlace[]) {
  const place = places.find((item) => sameStoreName(item.name, offer.name));
  if (!place) return null;
  if (streetNumber(offer.address)) return offer;
  return { ...offer, address: place.address };
}

// The task for the first model call. It names the kinds of stores to search
// for, and it tells the model not to search for Guinness yet. The date is in
// the prompt because "current" is otherwise whatever the model last learned.
function nearbyPrompt(area: string, radius: number) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. The shopper is near ${area}. Find physical retail stores within roughly ${radius} miles using local web listings. Do not search for a beer brand yet. Run separate web searches, with the city and state in each query, for liquor stores near ${area}, beer stores near ${area}, bottle shops near ${area}, package stores near ${area}, and grocery stores near ${area}. Return only businesses named in those search results for this area. If a retailer appears in the results, include it even when the name is already familiar. Do not add retailers from memory that the results did not name, and do not prefer a national product page over a store the local results listed. Include the name and street address shown in the listing. Classify each as liquor_store, beer_store, grocery, or other. Include different retailers, and up to three branches of one retailer when they are inside the radius. List liquor and beer stores before grocery stores.`;
}

// The task for the second model call. The store list is pasted in, and the
// model is told to price only those stores, for any Guinness product.
function pricePrompt(area: string, radius: number, places: NearbyPlace[]) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = places.map((place) => `- ${place.name} — ${place.address}`).join('\n');
  return `Today is ${today}. A local listing search near ${area} named the stores below, within roughly ${radius} miles. Price only these stores. Do not add a retailer that is not on this list. For each store, search the web using that store's name for Guinness. ${PRODUCT_NOTE} ${SOURCE_NOTE} USD prices only. A price on that retailer's website may be used for a listed branch; set branch_price_confirmed to false unless the page confirms that branch's price. Use the listed street address when the price page does not show one. Skip a store when no public Guinness price is found. Do not invent prices, pack sizes, or addresses. Exclude bars, restaurants, delivery-only businesses that are not on the list, prices from a different store, and mixed bundles with other brands.\n\nStores:\n${lines}`;
}

// The recovery agent's one-store search. approach is the agent's idea for how
// this search should differ from the one that failed. The store is fixed by
// the workflow, so the agent cannot point the search at a different retailer.
export function offerPrompt(
  area: string,
  radius: number,
  store: { name: string; address: string },
  approach: string,
) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. A local listing near ${area} named this store, within roughly ${radius} miles: ${store.name} — ${store.address}. An earlier search could not use its price. Search the web for this retailer's price for Guinness. ${PRODUCT_NOTE} Approach for this search: ${approach}. ${SOURCE_NOTE} USD prices only. Use the listed street address when the price page does not show one. Set branch_price_confirmed to false unless the page confirms that branch's price. If no public Guinness price is found, set found to false and price to null. Do not invent prices, pack sizes, or addresses. Exclude bars, restaurants, delivery-only businesses, prices from a different store, and mixed bundles with other brands.`;
}

// Store research is two agent calls, on purpose.
// Call 1: "which physical stores are near this city?"
// Call 2: "what does Guinness cost at those stores?"
// Liquor stores and grocery stores are priced in parallel, each with its own
// search budget, so one long grocery search cannot use up the liquor budget.
export async function findLocalStores(
  area: string,
  radius: number,
  research: WebResearch,
): Promise<ResearchResult<{ stores: Offer[]; notes: string }>> {
  const nearby = await research<{ places: NearbyPlace[]; notes: string }>(
    nearbyPrompt(area, radius),
    nearbySchema,
    'nearby_stores',
    8,
  );
  const places = selectPlaces(nearby.data.places);
  if (!places.length) {
    return {
      data: {
        stores: [],
        notes:
          nearby.data.notes || 'No liquor, beer, or grocery stores were named in local listings.',
      },
      sources: nearby.sources,
    };
  }

  const groups = [
    places.filter((place) => place.category !== 'grocery'),
    places.filter((place) => place.category === 'grocery'),
  ].filter((group) => group.length);
  const priced = await Promise.all(
    groups.map((group) =>
      research<{ stores: Offer[]; notes: string }>(
        pricePrompt(area, radius, group),
        storeSchema,
        'stores',
        Math.min(16, Math.max(4, group.length * 2)),
      ),
    ),
  );

  const sources = new Set(nearby.sources);
  const notes = [nearby.data.notes];
  const stores: Offer[] = [];
  for (const result of priced) {
    for (const source of result.sources) sources.add(source);
    if (result.data.notes) notes.push(result.data.notes);
    for (const offer of result.data.stores) {
      const listed = listedOffer(offer, places);
      if (!listed || stores.some((item) => sameBranch(item, listed))) continue;
      stores.push(listed);
    }
  }
  return { data: { stores, notes: notes.filter(Boolean).join(' ') }, sources };
}

// Full state names, so "il" and "illinois" both become the region we hand to
// the web-search tool's location bias.
const US_STATES: Record<string, string> = {
  al: 'Alabama',
  ak: 'Alaska',
  az: 'Arizona',
  ar: 'Arkansas',
  ca: 'California',
  co: 'Colorado',
  ct: 'Connecticut',
  de: 'Delaware',
  dc: 'District of Columbia',
  fl: 'Florida',
  ga: 'Georgia',
  hi: 'Hawaii',
  id: 'Idaho',
  il: 'Illinois',
  in: 'Indiana',
  ia: 'Iowa',
  ks: 'Kansas',
  ky: 'Kentucky',
  la: 'Louisiana',
  me: 'Maine',
  md: 'Maryland',
  ma: 'Massachusetts',
  mi: 'Michigan',
  mn: 'Minnesota',
  ms: 'Mississippi',
  mo: 'Missouri',
  mt: 'Montana',
  ne: 'Nebraska',
  nv: 'Nevada',
  nh: 'New Hampshire',
  nj: 'New Jersey',
  nm: 'New Mexico',
  ny: 'New York',
  nc: 'North Carolina',
  nd: 'North Dakota',
  oh: 'Ohio',
  ok: 'Oklahoma',
  or: 'Oregon',
  pa: 'Pennsylvania',
  ri: 'Rhode Island',
  sc: 'South Carolina',
  sd: 'South Dakota',
  tn: 'Tennessee',
  tx: 'Texas',
  ut: 'Utah',
  vt: 'Vermont',
  va: 'Virginia',
  wa: 'Washington',
  wv: 'West Virginia',
  wi: 'Wisconsin',
  wy: 'Wyoming',
};

const STATE_BY_NAME: Record<string, string> = {};
for (const [abbreviation, name] of Object.entries(US_STATES)) {
  STATE_BY_NAME[abbreviation] = name;
  STATE_BY_NAME[name.toLowerCase()] = name;
}

// Web search can be biased toward a city. This pulls "Chicago" and "Illinois"
// out of a geocoded area string so the tool's user_location can be set.
// A bare "near me" with no location often searches wherever the API defaults.
export function gasSearchLocation(area: string): { city: string; region: string } {
  const parts = area
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const city = (parts[0] ?? '').replace(/\b\d{5}(?:-\d{4})?\b/g, '').trim();
  const tokens = parts
    .slice(1)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let region = '';
  for (let length = Math.min(3, tokens.length); length > 0 && !region; length -= 1) {
    for (let index = 0; index + length <= tokens.length; index += 1) {
      const name = STATE_BY_NAME[tokens.slice(index, index + length).join(' ')];
      if (name) {
        region = name;
        break;
      }
    }
  }
  return { city, region };
}

// The gas task. It asks for station prices, not a national average, and it
// tells the model when it is allowed to leave price null.
export function gasPrompt(area: string) {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. The user is in ${area}. Search the web for "gas prices near me". Read regular unleaded prices in USD per gallon at the stations that search lists nearby. Stations a few miles away still count; do not reject them for being outside the exact ZIP code. If at least one regular station price is listed, return the median of up to five nearby prices and do not return null. Do not substitute a national or statewide average when a station price is listed. Set location to "${area} nearby stations". Set source_url to a page from the search that lists those station prices. If that page does not show an older date, set observed_date to ${today}. Ignore a price only when the page says it is older than 7 days.`;
}

// The web_search tool, with an approximate US city attached. search_context_size
// is how much page text the tool hands back. Store listing uses "high" because
// names and addresses are easy to miss in a short snippet. Gas uses the default.
export function localWebSearch(area: string, searchContextSize?: 'low' | 'medium' | 'high') {
  const place = gasSearchLocation(area);
  const user_location: Record<string, string> = { type: 'approximate', country: 'US' };
  if (place.city) user_location.city = place.city;
  if (place.region) user_location.region = place.region;
  const tool: Record<string, unknown> = { type: 'web_search', user_location };
  if (searchContextSize) tool.search_context_size = searchContextSize;
  return tool;
}
