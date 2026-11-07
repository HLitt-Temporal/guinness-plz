/*
  A local regular-gas price. The workflow treats a failure here as a missing
  price, not a failed beer run.
*/

import { researchClients } from '../../research.ts';
import type { BeerRunActivities } from '../contracts.ts';
import { toActivityFailure } from './failure.ts';

export const researchGas: BeerRunActivities['researchGas'] = async (area) => {
  try {
    const found = await researchClients().gas(area);
    return { gas: found.data, sources: [...found.sources] };
  } catch (error) {
    throw toActivityFailure(error);
  }
};
