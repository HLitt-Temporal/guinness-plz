/*
  What the Temporal tests share: fake activities, a scripted model for the
  agents, and a real worker on a local Temporal test server.

  The worker uses the real OpenAI Agents plugin and bundler settings, so the
  agent loop, its tools, and the model activity all run the way they do in
  production. Only the model is fake: each agent turn pops the next scripted
  reply. No OpenAI call and no browser.
*/

import { Usage } from '@openai/agents-core';
import type { Model, ModelProvider, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { BeerRunActivities } from '../temporal/contracts.ts';
import { agentsPlugin, bundlerOptions, workflowsPath } from '../temporal/worker.ts';
import type { Offer, SearchOptions } from '../workflow.ts';

export const options: SearchOptions = {
  address: '123 Sample St, Chicago, IL 60601',
  radius: 10,
  mpg: 25,
  gas_override: null,
  demo: false,
};

export const offer: Offer = {
  name: 'Sample',
  address: '1 Branch St, Chicago, IL',
  product: 'Guinness Draught 8-pack',
  pack_count: 8,
  price: 18,
  currency: 'USD',
  source_url: 'https://store.test/product',
  availability: 'unknown',
  branch_price_confirmed: false,
  notes: '',
};

export const PRODUCT_PAGE =
  'Home > Beer\nGuinness Draught Stout 8pk 14.9oz Cans\n$18.00\nAdd to cart';

export function fakeActivities(calls: string[]): BeerRunActivities {
  return {
    async locateAddress(address) {
      calls.push('locate');
      return {
        point: { lat: 41.88, lng: -87.63 },
        address: address + ', USA',
        locality: 'Chicago, IL 60601',
      };
    },
    async researchStores() {
      calls.push('stores');
      return {
        stores: [offer, { ...offer, pack_count: 0 }],
        notes: '',
        sources: ['https://store.test/product'],
      };
    },
    async researchGas() {
      calls.push('gas');
      return {
        gas: {
          price: 3.5,
          source_url: 'https://gas.test',
          location: 'Chicago',
          observed_date: new Date().toISOString().slice(0, 10),
          notes: '',
        },
        sources: ['https://gas.test'],
      };
    },
    async confirmStore(input) {
      calls.push('confirm');
      return {
        store: {
          ...input.offer,
          price: input.offer.price!,
          id: input.id,
          radius_miles: 1,
          round_trip_miles: 7,
          round_trip_minutes: 18,
          route_source_urls: [],
          fuel_cost: null,
          total: null,
        },
        warning: null,
        locatedAddress: input.offer.address,
      };
    },
    async researchOffer() {
      calls.push('offer');
      return { offer: null, notes: 'Nothing found.', sources: [] };
    },
    async readPricePage(url) {
      calls.push('page');
      return { status: 'failed', text: '', url, note: 'Test page did not load.' };
    },
    async rememberedPages() {
      calls.push('recall');
      return [];
    },
    async rememberPages() {
      calls.push('remember');
    },
  };
}

// One scripted agent turn: call a tool, or answer with text. The verifier's
// answer is its JSON verdict as text, the way the model returns it.
export type Turn = { tool: string; args: Record<string, unknown> } | { text: string };

export interface Script {
  recovery?: Turn[];
  verifier?: Turn[];
}

export function verdict(fields: Partial<Record<string, unknown>>): Turn {
  return {
    text: JSON.stringify({
      found: true,
      page_price: 18,
      price_quote: '$18.00',
      pack_quote: 'Guinness Draught Stout 8pk 14.9oz Cans',
      notes: '',
      ...fields,
    }),
  };
}

function reply(turn: Turn, callId: string): ModelResponse {
  if ('tool' in turn) {
    return {
      usage: new Usage(),
      output: [
        {
          type: 'function_call',
          callId,
          name: turn.tool,
          arguments: JSON.stringify(turn.args),
          status: 'completed',
        },
      ],
    };
  }
  return {
    usage: new Usage(),
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: turn.text }],
      },
    ],
  };
}

// The agent is told apart by its instructions. An empty queue answers the way
// a model with nothing to do would: the recovery agent gives up, and the
// verifier reports no price on the page.
export function scriptedModels(script: Script = {}) {
  const queues = { recovery: [...(script.recovery ?? [])], verifier: [...(script.verifier ?? [])] };
  const turns: string[] = [];
  let calls = 0;
  const model: Model = {
    async getResponse(request: ModelRequest) {
      const agent = request.systemInstructions?.includes('recover one store')
        ? 'recovery'
        : 'verifier';
      turns.push(agent);
      calls += 1;
      const fallback: Turn =
        agent === 'recovery' ? { text: 'Gave up.' } : verdict({ found: false, page_price: null });
      return reply(queues[agent].shift() ?? fallback, `call-${calls}`);
    },
    getStreamedResponse() {
      throw new Error('The tests do not stream.');
    },
  };
  const provider: ModelProvider = { getModel: () => model };
  return { provider, turns };
}

// A worker and a client on a fresh local test server, for one test.
export async function withWorker<T>(
  activities: BeerRunActivities,
  provider: ModelProvider,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const env = await TestWorkflowEnvironment.createLocal();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test',
      workflowsPath,
      activities,
      plugins: [agentsPlugin(provider)],
      bundlerOptions,
    });
    return await worker.runUntil(run(env.client));
  } finally {
    await env.teardown();
  }
}

export function testId() {
  return `test-${Math.random().toString(36).slice(2)}`;
}

export function runWorkflow<T>(
  workflow: string,
  args: unknown[],
  activities: BeerRunActivities,
  provider: ModelProvider = scriptedModels().provider,
): Promise<T> {
  return withWorker(activities, provider, (client) =>
    client.workflow.execute(workflow, { taskQueue: 'test', workflowId: testId(), args }),
  );
}
