/*
  The two-step store search: local listings, then 8-pack prices at only those
  stores. Source URLs come back as an array because a Set cannot be stored in
  workflow history.
*/

import { researchClients } from '../../research.ts';
import type { BeerRunActivities } from '../contracts.ts';
import { toActivityFailure } from './failure.ts';

export const researchStores: BeerRunActivities['researchStores'] = async (area, radius) => {
  try {
    const found = await researchClients().stores(area, radius);
    return { stores: found.data.stores, notes: found.data.notes, sources: [...found.sources] };
  } catch (error) {
    throw toActivityFailure(error);
  }
};
