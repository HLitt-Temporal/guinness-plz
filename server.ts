/*
  The local server in front of the workflow.

  A live search can take a few minutes: the model searches the web more than
  once, then a browser reads map pages. A single HTTP request held open that
  long gets cut off. So POST /api/search checks the form, starts a Temporal
  workflow, and returns the workflow id immediately. The page polls
  GET /api/jobs/:id about once a second and reads step, then the result.
  GET /api/jobs/:id/events is the live feed: the workflow's progress topic,
  relayed as server-sent events while the search runs.

  Price watches are Temporal workflows too. /api/watches lists, starts, and
  stops them. The list comes from Temporal, so there is no database here.

  Demo searches stay in this process's memory. Live searches are Temporal
  workflows, so restarting the server does not forget one that is still running.
  The OpenAI key is read from .env here and never sent to the browser.

  This server also serves the page, on 127.0.0.1 only. In dev, Vite is attached
  so the React page hot-reloads. In production, it serves the built files in dist/.
  The Temporal worker runs in this same process.
*/

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { WorkflowStreamClient } from '@temporalio/workflow-streams/client';
import type { ViteDevServer } from 'vite';
import { connectionOptions, temporalConfig } from './temporal/config.ts';
import { createWorker } from './temporal/worker.ts';
import { failureText } from './temporal/failure.ts';
import {
  clientTelemetry,
  startTelemetry,
  stopTelemetry,
  traceRequest,
} from './temporal/telemetry.ts';
import {
  BEER_RUN_PROGRESS,
  DONE_STEP,
  PRICE_WATCH_VIEW,
  PROGRESS_TOPIC,
  STOP_PRICE_WATCH,
} from './temporal/progress.ts';
import type { BeerRunView, ProgressEvent, WatchView } from './temporal/progress.ts';
import type { beerRun, priceWatch } from './temporal/workflows.ts';
import { WorkflowError, demoSearch, validate, validateWatch } from './workflow.ts';
import type { Result, SearchOptions } from './workflow.ts';

const root = new URL('./', import.meta.url);
const dist = fileURLToPath(new URL('dist/', root));
const port = Number(process.env.PORT || 8765);
// npm run dev passes --dev. npm start does not, and serves the built page instead.
const development = process.argv.includes('--dev');

// The search form is small. A bigger body is rejected before we parse it.
const MAX_BODY_BYTES = 4096;
// Finished jobs are deleted once they are this old. A running job is kept,
// because deleting it would hide a search the page is still polling.
const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_JOBS = 50;
// Applies to ordinary requests. The agent work is not inside this timer,
// because it continues after /api/search has already responded.
const REQUEST_TIMEOUT_MS = 15_000;
// Each live watch check is a full search. A few watches is plenty for one person.
const MAX_WATCHES = 3;
const LISTED_WATCHES = 10;
const WATCH_ID = /^watch-[A-Za-z0-9_-]+$/;

const LOCAL_HOSTS = [`127.0.0.1:${port}`, `localhost:${port}`];

const FILE_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// One in-flight or finished search. step is the workflow stage the page shows.
// result appears when status becomes done. error appears when it becomes error.
interface Job {
  status: 'running' | 'done' | 'error';
  step: number;
  created: number;
  result?: Result;
  error?: string;
}

// Insertion order is the age order. dropOldestJobIfFull relies on that.
// Only demo searches live here. A live search is a Temporal workflow whose id
// is the job id the page polls.
const jobs = new Map<string, Job>();
let vite: ViteDevServer | undefined;
let temporal: TemporalApp | undefined;

interface TemporalApp {
  client: Client;
  shutdown(): Promise<void>;
}

// Loads OPENAI_API_KEY and OPENAI_MODEL if you created a .env file.
// Missing file is fine: demo mode does not need a key.
const envPath = new URL('.env', root);
if (existsSync(envPath)) process.loadEnvFile(fileURLToPath(envPath));
startTelemetry('server');

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function requestPath(req: IncomingMessage) {
  return new URL(req.url || '/', `http://127.0.0.1:${port}`).pathname;
}

function jobIdFromPath(path: string) {
  return path.split('/').at(-1)!;
}

// The agent can spend API money, so a page on another origin cannot start one.
// The browser must be talking to this machine, at this port.
function isLocalRequest(req: IncomingMessage) {
  const host = req.headers.host || '';
  if (!LOCAL_HOSTS.includes(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return LOCAL_HOSTS.some((allowed) => origin === `http://${allowed}`);
}

async function readJsonBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new WorkflowError('Invalid request size.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch {
    throw new WorkflowError('Invalid JSON request.');
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof WorkflowError ? error.message : fallback;
}

// Finished searches stay available long enough for the page to poll them once
// more. A search that is still running is left alone.
function forgetOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.status !== 'running';
    if (finished && now - job.created > JOB_TTL_MS) jobs.delete(id);
  }
}

// One live search opens a browser and several model calls. A second one at the
// same time would pile those on top of each other, so it is refused. Demo jobs
// are in memory. Live jobs are running workflows on the task queue, including
// a price watch's check while it runs.
async function searchInProgress() {
  if ([...jobs.values()].some((job) => job.status === 'running')) return true;
  if (!temporal) return false;
  const running = temporal.client.workflow.list({
    query: 'ExecutionStatus = "Running" AND WorkflowType = "beerRun"',
  });
  for await (const execution of running) {
    void execution;
    return true;
  }
  return false;
}

function dropOldestJobIfFull() {
  if (jobs.size < MAX_JOBS) return;
  const oldestId = jobs.keys().next().value;
  if (oldestId !== undefined) jobs.delete(oldestId);
}

// The id is unguessable so a job URL is not something you can iterate through.
function createJob() {
  const id = randomBytes(24).toString('base64url');
  const job: Job = { status: 'running', step: 0, created: Date.now() };
  jobs.set(id, job);
  return { id, job };
}

// Demo skips the model and the browser. Live mode is a Temporal workflow,
// started below, so this function only finishes a demo job.
function runSearch(job: Job, options: SearchOptions) {
  void (async () => {
    try {
      job.result = demoSearch(options);
      job.step = DONE_STEP;
      job.status = 'done';
    } catch (error) {
      job.status = 'error';
      job.error = errorMessage(
        error,
        'The provider response could not be processed. Please retry.',
      );
    }
  })();
}

function executionStatus(status: unknown) {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && 'name' in status && typeof status.name === 'string') {
    return status.name;
  }
  return '';
}

// A running workflow answers the progress query. A finished one has a result.
// A failed one carries the activity's sentence, unwrapped from Temporal's
// failure chain. An unknown id is a 404, same as a forgotten in-memory job.
async function sendJob(res: ServerResponse, id: string) {
  const memory = jobs.get(id);
  if (memory) {
    sendJson(res, 200, memory);
    return;
  }
  if (!temporal) {
    sendJson(res, 404, { error: 'Search expired or was not found.' });
    return;
  }

  const handle = temporal.client.workflow.getHandle(id);
  try {
    const description = await handle.describe();
    const status = executionStatus(description.status);
    if (status === 'RUNNING') {
      const progress = await handle.query<BeerRunView>(BEER_RUN_PROGRESS);
      sendJson(res, 200, {
        status: 'running',
        step: progress.step,
        stores: progress.stores ?? [],
      });
      return;
    }
    if (status === 'COMPLETED') {
      const result = (await handle.result()) as Result;
      sendJson(res, 200, { status: 'done', step: DONE_STEP, result });
      return;
    }
    try {
      await handle.result();
      sendJson(res, 200, { status: 'error', step: 0, error: 'Search failed.' });
    } catch (error) {
      sendJson(res, 200, { status: 'error', step: 0, error: failureText(error) });
    }
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      sendJson(res, 404, { error: 'Search expired or was not found.' });
      return;
    }
    sendJson(res, 200, { status: 'error', step: 0, error: failureText(error) });
  }
}

// Server-sent events from the workflow's progress topic. Each event id is the
// next stream offset, so a reconnecting EventSource resumes where it stopped.
// The subscription ends on its own when the workflow closes. Demo jobs and
// unknown ids get an end event straight away.
async function streamJob(req: IncomingMessage, res: ServerResponse, id: string) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    res.end('event: end\ndata: {}\n\n');
  };
  if (jobs.has(id) || !temporal) {
    finish();
    return;
  }

  const resumeAt = Number(req.headers['last-event-id']);
  const from = Number.isSafeInteger(resumeAt) && resumeAt > 0 ? resumeAt : 0;
  const events = WorkflowStreamClient.create(temporal.client, id)
    .topic<ProgressEvent>(PROGRESS_TOPIC)
    .subscribe(from, { pollCooldown: '250ms' });
  req.on('close', () => {
    closed = true;
    void events.return(undefined);
  });
  try {
    for await (const event of events) {
      if (closed) break;
      res.write(`id: ${event.offset + 1}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
  } catch {
    // The workflow closed between polls, or the id was never a workflow.
  }
  finish();
}

type WatchSummary = WatchView & { id: string };

// Newest first, from Temporal's list of priceWatch runs. A watch that continued
// as new appears once, as its latest run. A failed or terminated watch has no
// view to show and is left out.
async function listWatches(app: TemporalApp): Promise<WatchSummary[]> {
  const watches: WatchSummary[] = [];
  const executions = app.client.workflow.list({
    query: 'WorkflowType = "priceWatch" AND ExecutionStatus != "ContinuedAsNew"',
  });
  for await (const execution of executions) {
    if (watches.length >= LISTED_WATCHES) break;
    const handle = app.client.workflow.getHandle(execution.workflowId);
    const status = executionStatus(execution.status);
    try {
      if (status === 'RUNNING') {
        watches.push({
          id: execution.workflowId,
          ...(await handle.query<WatchView>(PRICE_WATCH_VIEW)),
        });
      } else if (status === 'COMPLETED') {
        watches.push({ id: execution.workflowId, ...((await handle.result()) as WatchView) });
      }
    } catch {
      // A watch that cannot answer right now is left out of this response.
    }
  }
  return watches;
}

async function runningWatchCount(app: TemporalApp) {
  let count = 0;
  const running = app.client.workflow.list({
    query: 'WorkflowType = "priceWatch" AND ExecutionStatus = "Running"',
  });
  for await (const execution of running) {
    void execution;
    count += 1;
  }
  return count;
}

// Same rules as a search, plus a target and an interval. A live watch needs
// the OpenAI key, because every check is a live search.
async function handleStartWatch(req: IncomingMessage, res: ServerResponse, app: TemporalApp) {
  try {
    const watch = validateWatch(await readJsonBody(req));
    if (!watch.search.demo && !process.env.OPENAI_API_KEY) {
      sendJson(res, 400, { error: 'A live price watch needs OPENAI_API_KEY in .env.' });
      return;
    }
    if ((await runningWatchCount(app)) >= MAX_WATCHES) {
      sendJson(res, 409, { error: `Up to ${MAX_WATCHES} price watches can run. Stop one first.` });
      return;
    }
    const id = `watch-${randomBytes(18).toString('base64url')}`;
    await app.client.workflow.start<typeof priceWatch>('priceWatch', {
      taskQueue: temporalConfig().taskQueue,
      workflowId: id,
      args: [watch],
    });
    sendJson(res, 202, { id });
  } catch (error) {
    if (error instanceof WorkflowError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 503, {
      error: 'The price watch could not start. Check the Temporal connection.',
    });
  }
}

async function handleStopWatch(res: ServerResponse, app: TemporalApp, id: string) {
  if (!WATCH_ID.test(id)) {
    sendJson(res, 404, { error: 'Price watch not found.' });
    return;
  }
  try {
    await app.client.workflow.getHandle(id).signal(STOP_PRICE_WATCH);
    sendJson(res, 202, { id });
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      sendJson(res, 404, { error: 'Price watch not found or already finished.' });
      return;
    }
    sendJson(res, 503, { error: 'Could not reach the price watch. Please retry.' });
  }
}

// GET, POST, and stop all return addresses, or spend money, so all of them
// require the local origin.
async function handleWatches(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: 'Use the local app URL.' });
    return;
  }
  if (!temporal) {
    sendJson(res, 503, {
      error: 'Price watches need Temporal Cloud. Set the TEMPORAL_* values in .env.',
    });
    return;
  }
  const stop = path.match(/^\/api\/watches\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stop) {
    await handleStopWatch(res, temporal, stop[1]);
    return;
  }
  if (req.method === 'POST' && path === '/api/watches') {
    await handleStartWatch(req, res, temporal);
    return;
  }
  if (req.method === 'GET' && path === '/api/watches') {
    try {
      sendJson(res, 200, { watches: await listWatches(temporal) });
    } catch {
      sendJson(res, 503, { error: 'Could not list price watches. Please retry.' });
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function sendStaticFile(res: ServerResponse, path: string) {
  const filename = path === '/' ? '/index.html' : path;
  const file = resolve(dist, `.${filename}`);
  const missing = !file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile();
  if (missing) {
    sendJson(res, 404, {
      error: 'Frontend not found. Run npm run build, or npm run dev for development.',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': FILE_TYPES[extname(file)] || 'application/octet-stream',
    ...SECURITY_HEADERS,
  });
  res.end(readFileSync(file));
}

// The page has no memory of its own. After a refresh, the shortlist comes back
// from the newest finished live search. A running search is left alone; the
// page is already polling that one.
async function sendLatest(res: ServerResponse) {
  if (!temporal) {
    sendJson(res, 200, { result: null });
    return;
  }
  try {
    const executions = temporal.client.workflow.list({
      query: 'WorkflowType = "beerRun" AND ExecutionStatus = "Completed"',
    });
    for await (const execution of executions) {
      const result = (await temporal.client.workflow
        .getHandle(execution.workflowId, execution.runId)
        .result()) as Result;
      sendJson(res, 200, { result });
      return;
    }
    sendJson(res, 200, { result: null });
  } catch {
    sendJson(res, 200, { result: null });
  }
}

// /api/config tells the page whether a live search can run, without sending the key.
// That requires the OpenAI key and a connected Temporal worker. Watches need
// only Temporal, because a demo watch runs no research. /api/jobs/:id is the
// poll, and /api/jobs/:id/events its live feed. Anything else is the React page.
async function handleGet(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/api/latest') {
    await sendLatest(res);
    return;
  }

  if (path === '/api/config') {
    sendJson(res, 200, {
      live_ready: Boolean(process.env.OPENAI_API_KEY) && temporal != null,
      watch_ready: temporal != null,
      // The page links each live search to its history in the Temporal Cloud UI.
      temporal_namespace: temporal ? process.env.TEMPORAL_NAMESPACE || null : null,
    });
    return;
  }

  const feed = path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (feed) {
    await streamJob(req, res, feed[1]);
    return;
  }

  if (path.startsWith('/api/jobs/')) {
    await sendJob(res, jobIdFromPath(path));
    return;
  }

  if (path.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (vite) {
    vite.middlewares(req, res);
    return;
  }

  sendStaticFile(res, path);
}

// Accept a search, or explain why not, before any agent work starts.
// 202 means "started," not "here are your stores."
async function handleSearch(req: IncomingMessage, res: ServerResponse) {
  if (!isLocalRequest(req)) {
    sendJson(res, 403, { error: 'Use the local app URL. Cross-origin searches are blocked.' });
    return;
  }

  try {
    const options = validate(await readJsonBody(req));
    forgetOldJobs();
    try {
      if (await searchInProgress()) {
        sendJson(res, 409, {
          error: 'A search or price-watch check is already running. Wait for it to finish.',
        });
        return;
      }
    } catch {
      sendJson(res, 503, {
        error: 'Could not check whether a search is already running. Please retry.',
      });
      return;
    }

    if (options.demo) {
      dropOldestJobIfFull();
      const { id, job } = createJob();
      sendJson(res, 202, { id });
      runSearch(job, options);
      return;
    }

    if (!temporal) {
      sendJson(res, 503, {
        error:
          'Live search needs Temporal Cloud. Set TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, and TEMPORAL_API_KEY in .env and restart. Demo mode works without it.',
      });
      return;
    }

    const id = randomBytes(24).toString('base64url');
    try {
      await temporal.client.workflow.start<typeof beerRun>('beerRun', {
        taskQueue: temporalConfig().taskQueue,
        workflowId: id,
        args: [options],
      });
    } catch {
      sendJson(res, 503, {
        error:
          'Live search could not start. Check that Temporal Cloud is reachable and the API key is valid.',
      });
      return;
    }
    sendJson(res, 202, { id });
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error, 'Invalid request.') });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const path = requestPath(req);
  if (path === '/api/watches' || path.startsWith('/api/watches/')) {
    await handleWatches(req, res, path);
    return;
  }
  if (req.method === 'GET') {
    await handleGet(req, res, path);
    return;
  }
  if (req.method === 'POST' && path === '/api/search') {
    await handleSearch(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

// In dev, Vite serves the React source and hot-reloads it on this same port.
// The API stays in this file. The page and the API are one origin, which is
// what isLocalRequest checks for.
async function attachVite(server: ReturnType<typeof createServer>) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
}

// The span name for an API request, with ids replaced. The page and its
// assets get no span.
function apiRoute(path: string) {
  if (!path.startsWith('/api/')) return null;
  return path
    .replace(/^\/api\/jobs\/[^/]+/, '/api/jobs/:id')
    .replace(/^\/api\/watches\/[^/]+\/stop$/, '/api/watches/:id/stop');
}

const server = createServer((req, res) => {
  void traceRequest(req, res, apiRoute(requestPath(req)), () => handleRequest(req, res));
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.on('error', (error) => {
  console.error(`Could not start local server: ${error.message}`);
  process.exitCode = 1;
});

// Connect before listen so the first poll can see the worker. A refused
// connection does not stop the HTTP server: demo mode still runs.
async function connectTemporal() {
  const { address, namespace, taskQueue } = temporalConfig();
  const connection = await Connection.connect({ ...connectionOptions(), connectTimeout: '10s' });
  let workerConnection: NativeConnection | undefined;
  try {
    workerConnection = await NativeConnection.connect(connectionOptions());
    const worker = await createWorker(workerConnection);
    const running = worker.run();
    void running.catch((error: unknown) => {
      console.error(
        `Temporal worker stopped: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
    temporal = {
      client: new Client({ connection, namespace, ...clientTelemetry() }),
      async shutdown() {
        await worker.shutdown();
        await running.catch(() => {});
        await connection.close();
        await workerConnection?.close();
      },
    };
    console.log(`Temporal worker is polling ${taskQueue} in ${namespace} at ${address}`);
  } catch (error) {
    await connection.close().catch(() => {});
    await workerConnection?.close().catch(() => {});
    throw error;
  }
}

let shuttingDown = false;
async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  await temporal?.shutdown().catch(() => {});
  await stopTelemetry();
  await vite?.close().catch(() => {});
  server.close(() => process.exit(code));
  // An open page holds keep-alive and live-feed connections, and close() waits
  // for every one of them. The page reconnects to the restarted server.
  server.closeAllConnections();
}

process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => {
  void shutdown(0);
});

if (development) await attachVite(server);
try {
  await connectTemporal();
} catch (error) {
  console.error(
    `Temporal Cloud is unavailable. Check the TEMPORAL_* settings in .env. Demo mode still works. ${
      error instanceof Error ? error.message : ''
    }`,
  );
}
server.listen(port, '127.0.0.1', () => {
  console.log(`guinness-plz is running at http://127.0.0.1:${port}`);
});
