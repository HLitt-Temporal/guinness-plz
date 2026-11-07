/*
  What the workflow is allowed to ask an activity to do.

  The workflow file imports these as types only. It must not import the
  activity implementations, because those open a browser and call OpenAI.
  Activity results are plain JSON. A Set or a browser handle cannot cross
  this boundary, so source URLs are string arrays.
*/

import type { PricePage } from '../price-check.ts';
import type { Gas, Offer, Point, Store } from '../workflow.ts';

export interface LocatedAddress {
  point: Point;
  address: string;
  locality?: string;
}

export interface StoreResearch {
  stores: Offer[];
  notes: string;
  sources: string[];
}

export interface GasResearch {
  gas: Gas;
  sources: string[];
}

export interface ConfirmStoreInput {
  offer: Offer;
  origin: Point;
  radius: number;
  seenAddresses: string[];
  sources: string[];
  id: string;
}

export interface ConfirmStoreResult {
  store: Store | null;
  warning: string | null;
  locatedAddress: string | null;
}

// The recovery agent's search. store is fixed by the workflow. approach is the
// agent's suggestion for how this search should differ from the failed one.
export interface OfferSearchInput {
  area: string;
  radius: number;
  store: { name: string; address: string };
  approach: string;
}

// offer is null when the search found no exact 8-pack price.
export interface OfferSearch {
  offer: Offer | null;
  notes: string;
  sources: string[];
}

// A price page an earlier search for this area used, and whose price the
// verifier found on it. The next search reads it again before searching.
export interface RememberedPage {
  name: string;
  address: string;
  product: string;
  source_url: string;
}

export interface BeerRunActivities {
  locateAddress(address: string): Promise<LocatedAddress>;
  researchStores(area: string, radius: number): Promise<StoreResearch>;
  researchGas(area: string): Promise<GasResearch>;
  confirmStore(input: ConfirmStoreInput): Promise<ConfirmStoreResult>;
  researchOffer(input: OfferSearchInput): Promise<OfferSearch>;
  readPricePage(url: string): Promise<PricePage>;
  rememberedPages(area: string): Promise<RememberedPage[]>;
  rememberPages(area: string, pages: RememberedPage[]): Promise<void>;
}
