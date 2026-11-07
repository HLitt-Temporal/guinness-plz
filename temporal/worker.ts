/*
  Polls the guinness-plz task queue and runs beer-run workflows and activities.

  server.ts starts this in the same process. `npm run worker` starts it alone,
  which is how a second process can keep going while the HTTP server restarts.
  A live search that was already running is picked up again. Completed activities
  are not repeated.

  The OpenAI Agents plugin registers the activity that runs agent model calls,
  and the polyfills the Agents SDK needs inside the workflow sandbox.
*/

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelProvider } from '@openai/agents-core';
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { BundleOptions } from '@temporalio/worker';
import * as activities from './activities/index.ts';
import { agentsCore, agentsOpenAI } from './agents-sdk.ts';
import { connectionOptions, temporalConfig } from './config.ts';
import { AGENT_MODEL } from './progress.ts';
import { agentTracing, startTelemetry, stopTelemetry, telemetryPlugins } from './telemetry.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Agent spans carry tool inputs, including store addresses. They stay off
// unless startTelemetry turns them on, and then they go only to Grafana: no
// exporter to OpenAI's trace dashboard is registered.
agentsCore.setTracingDisabled(true);

export const workflowsPath = fileURLToPath(new URL('./workflows.ts', import.meta.url));

// Agents ask for AGENT_MODEL. The key and the real model name are read here,
// at call time, after server.ts has loaded .env.
function researchModels(): ModelProvider {
  const openai = new agentsOpenAI.OpenAIProvider();
  return {
    getModel(name) {
      return openai.getModel(name === AGENT_MODEL ? process.env.OPENAI_MODEL || 'gpt-5.4' : name);
    },
  };
}

// Tests pass a scripted model provider here, so no agent turn reaches OpenAI.
export function agentsPlugin(modelProvider: ModelProvider = researchModels()) {
  return new OpenAIAgentsPlugin({ modelProvider, interceptorOptions: agentTracing() });
}

// The Agents SDK loads one module lazily with import(). This package is ESM, so
// webpack would split that module into a separate chunk, and the workflow
// sandbox cannot load chunks. Eager mode keeps the whole bundle in one file.
export const bundlerOptions: Pick<BundleOptions, 'webpackConfigHook'> = {
  webpackConfigHook(config) {
    return {
      ...config,
      module: {
        ...config.module,
        parser: {
          ...config.module?.parser,
          javascript: { ...config.module?.parser?.javascript, dynamicImportMode: 'eager' },
        },
      },
    };
  },
};

export async function createWorker(connection: NativeConnection) {
  const { namespace, taskQueue } = temporalConfig();
  // Under `node --watch`, worker threads inherit this and post `{ 'watch:require' }`
  // messages to their parent. Temporal reads any message without a requestId as a
  // patch-activation request and crashes with "Invalid atomic access index".
  delete process.env.WATCH_REPORT_DEPENDENCIES;
  return Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    activities,
    plugins: [agentsPlugin(), ...telemetryPlugins()],
    bundlerOptions,
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startTelemetry('worker');
  const { address, namespace, taskQueue } = temporalConfig();
  const connection = await NativeConnection.connect(connectionOptions());
  try {
    const worker = await createWorker(connection);
    console.log(`Temporal worker is polling ${taskQueue} in ${namespace} at ${address}`);
    await worker.run();
  } finally {
    await connection.close();
    await stopTelemetry();
  }
}
