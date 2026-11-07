/*
  Where the Temporal Cloud namespace is and how to sign in to it. Read at call
  time, after server.ts has loaded .env. A constant at import time would run
  before that file is loaded.
*/

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to .env.`);
  return value;
}

export function temporalConfig() {
  return {
    address: required('TEMPORAL_ADDRESS'),
    namespace: required('TEMPORAL_NAMESPACE'),
    apiKey: required('TEMPORAL_API_KEY'),
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'guinness-plz',
  };
}

// The regional API key endpoint serves many namespaces, so each call names its own.
export function connectionOptions() {
  const { address, namespace, apiKey } = temporalConfig();
  return { address, tls: true, apiKey, metadata: { 'temporal-namespace': namespace } };
}
