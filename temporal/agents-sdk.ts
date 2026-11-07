/*
  The Agents SDK, loaded the way the OpenAI Agents plugin loads it.

  The plugin is CommonJS, so it gets the SDK's CommonJS build. An ESM import
  here would load the ESM build as a second copy. The two copies share one
  global trace provider, which tells a trace from a span with instanceof, so
  a trace made by one copy and handed to the other is treated as missing and
  the span under it is dropped. That loses the model-call spans. Host code
  imports the SDK from here. Workflow code is bundled on its own and imports
  it normally.
*/

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const agentsCore = require('@openai/agents-core') as typeof import('@openai/agents-core');
export const agentsOpenAI =
  require('@openai/agents-openai') as typeof import('@openai/agents-openai');
