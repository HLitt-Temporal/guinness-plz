/*
  Opens a store's cited price page for the verifier. A blocked or broken page
  comes back as a status. A browser that will not launch throws and is retried.
*/

import { openPricePage } from '../../price-page.ts';
import type { BeerRunActivities } from '../contracts.ts';
import { toActivityFailure } from './failure.ts';

export const readPricePage: BeerRunActivities['readPricePage'] = async (url) => {
  try {
    return await openPricePage(url);
  } catch (error) {
    throw toActivityFailure(error);
  }
};
