/*
  One store: geocode, radius, then the drive there and back. Business failures
  (unknown address, no route) come back as a warning so the other stores still
  rank. A browser that fails to launch throws, and Temporal retries the activity.
*/

import { evaluateOffer, isPricedEightPack } from '../../workflow.ts';
import type { BeerRunActivities } from '../contracts.ts';
import { withMaps } from './failure.ts';

export const confirmStore: BeerRunActivities['confirmStore'] = async (input) => {
  if (!isPricedEightPack(input.offer, new Set(input.sources))) {
    return { store: null, warning: null, locatedAddress: null };
  }
  return withMaps((maps) =>
    evaluateOffer(
      input.offer,
      input.origin,
      input.radius,
      maps,
      new Set(input.seenAddresses),
      input.id,
    ),
  );
};
