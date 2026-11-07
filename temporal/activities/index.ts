/*
  The side effects of one beer run, registered together on the worker.

  locateAddress, confirmStore, and readPricePage open a headless browser.
  researchStores, researchGas, and researchOffer call OpenAI.
  rememberedPages and rememberPages read and save price pages that worked
  for an area. The agents'
  model calls are not here: the OpenAI Agents plugin registers its own model
  activity on the worker. None of that is allowed inside the workflow, which
  has to replay without doing the work a second time. Each activity returns
  JSON the workflow can store in its history.

  Only activities are exported here. The worker registers every export as an
  activity, so a helper exported from this file would become one too.
*/

export { locateAddress } from './locate-address.ts';
export { researchStores } from './research-stores.ts';
export { researchGas } from './research-gas.ts';
export { confirmStore } from './confirm-store.ts';
export { researchOffer } from './research-offer.ts';
export { readPricePage } from './read-price-page.ts';
export { rememberedPages, rememberPages } from './remembered-pages.ts';
