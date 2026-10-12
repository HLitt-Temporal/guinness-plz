/*
  The local server in front of the workflow.

  A live search can take a few minutes: the model searches the web more than
  once, then a browser reads map pages. A single HTTP request held open that
  long gets cut off. So POST /api/search checks the form, stores a job, returns
  the job id immediately, and does the research after the response is sent.
  The page polls GET /api/jobs/:id about once a second and reads step, then the
  result.

  Jobs live in this process's memory. Restarting the server forgets them.
  Nothing about your address is written to disk. The OpenAI key is read from
  .env here and never sent to the browser.

  This server also serves the page, on 127.0.0.1 only. In dev, Vite is attached
  so the React page hot-reloads. In production, it serves the built files in dist/.
*/

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { WorkflowError, demoSearch, liveProviders, liveSearch, validate } from './workflow.ts';
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
const jobs = new Map<string, Job>();
let vite: ViteDevServer | undefined;

// Loads OPENAI_API_KEY and OPENAI_MODEL if you created a .env file.
// Missing file is fine: demo mode does not need a key.
const envPath = new URL('.env', root);
if (existsSync(envPath)) process.loadEnvFile(fileURLToPath(envPath));

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
// same time would pile those on top of each other, so it is refused.
function searchInProgress() {
  return [...jobs.values()].some((job) => job.status === 'running');
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

// demo skips the model and the browser. Live mode builds the tools, runs the
// workflow, and always closes the browser, including when a step throws.
async function research(job: Job, options: SearchOptions) {
  if (options.demo) return demoSearch(options);

  const providers = await liveProviders();
  try {
    return await liveSearch(options, providers, (step) => {
      job.step = step;
    });
  } finally {
    await providers.close?.().catch(() => {});
  }
}

// Fire and forget, on purpose. The HTTP handler has already sent the job id.
// void marks that we are not awaiting this promise in the request. Errors land
// on the job as status "error" so the next poll can show them.
function runSearch(job: Job, options: SearchOptions) {
  void (async () => {
    try {
      job.result = await research(job, options);
      job.step = 4;
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

// /api/config tells the page whether a key is loaded, without sending the key.
// /api/jobs/:id is the poll. Anything else is the React page.
function handleGet(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/api/config') {
    sendJson(res, 200, { live_ready: Boolean(process.env.OPENAI_API_KEY) });
    return;
  }

  if (path.startsWith('/api/jobs/')) {
    const job = jobs.get(jobIdFromPath(path));
    sendJson(res, job ? 200 : 404, job || { error: 'Search expired or was not found.' });
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
    if (searchInProgress()) {
      sendJson(res, 409, { error: 'A search is already running. Wait for it to finish.' });
      return;
    }

    dropOldestJobIfFull();
    const { id, job } = createJob();
    sendJson(res, 202, { id });
    runSearch(job, options);
  } catch (error) {
    sendJson(res, 400, { error: errorMessage(error, 'Invalid request.') });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const path = requestPath(req);
  if (req.method === 'GET') {
    handleGet(req, res, path);
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

const server = createServer((req, res) => {
  void handleRequest(req, res);
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.on('error', (error) => {
  console.error(`Could not start local server: ${error.message}`);
  process.exitCode = 1;
});

if (development) await attachVite(server);
server.listen(port, '127.0.0.1', () => {
  console.log(`guinness-plz is running at http://127.0.0.1:${port}`);
});
