/*
  Finds the starting street address in a headless browser. Only the city and
  state from this result go on to the research activities.
*/

import type { BeerRunActivities } from '../contracts.ts';
import { withMaps } from './failure.ts';

export const locateAddress: BeerRunActivities['locateAddress'] = (address) =>
  withMaps(async (maps) => {
    const origin = await maps.geocode(address);
    return { point: origin.point, address: origin.address, locality: origin.locality };
  });
