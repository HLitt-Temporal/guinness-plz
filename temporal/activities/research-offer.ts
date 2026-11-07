/*
  One fresh price search for one store, on behalf of the recovery agent. The
  workflow decides which store. The agent only suggests how to search.
*/

import { researchClients } from '../../research.ts';
import type { BeerRunActivities } from '../contracts.ts';
import { toActivityFailure } from './failure.ts';

export const researchOffer: BeerRunActivities['researchOffer'] = async (input) => {
  try {
    const found = await researchClients().offer(
      input.area,
      input.radius,
      input.store,
      input.approach,
    );
    return {
      offer: found.data.found ? found.data.offer : null,
      notes: found.data.notes,
      sources: [...found.sources],
    };
  } catch (error) {
    throw toActivityFailure(error);
  }
};
