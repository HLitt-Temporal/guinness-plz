# guinness-plz

A local agentic web app that finds Guinness Draught **8 × 14.9 fl oz cans**, researches local regular-gas prices, and compares estimated pickup costs. US addresses, USD, US gallons, and miles for the initial version.

## Run

Node.js 24 or newer. The frontend uses React, Vite, Material UI, and TypeScript. The backend and workflow tests are also TypeScript.

```sh
cd guinness-plz
npm install
npm run browser:install
npm run dev
```

Open <http://127.0.0.1:8765>. Enter an address and run **demo mode** to try fictional store prices and routes without credentials. Demo results do not represent nearby stores.

Vite runs as middleware on the same local server as the API, so one command starts the app with React hot updates. Node watches only the backend files and `temporal/` for backend restarts; Vite handles frontend and Vite configuration changes. This prevents generated files in `node_modules/.vite-temp` from restarting the server and clearing in-memory searches. Restart manually after changing `.env`. API keys stay in the backend's `.env`; never prefix secrets with `VITE_`. Opening an HTML file directly is not supported.

For the built frontend:

```sh
npm run build
npm start
```

The server serves Vite's `dist/` output in this mode. Frontend sources live in `frontend/src/`; `workflow.ts` contains validation, filtering, and ranking rules; `research.ts` makes the OpenAI calls; `temporal/` holds the Temporal workflow, activities, and worker; and `server.ts` handles API requests and frontend serving.

## Temporal

Live searches run as a [Temporal](https://docs.temporal.io/develop/typescript) workflow (`beerRun` in `temporal/workflows.ts`). Each network step is an activity with its own file in `temporal/activities/`: locate the address (`locate-address.ts`), research stores (`research-stores.ts`), research gas (`research-gas.ts`), and confirm each store's location and route (`confirm-store.ts`). `index.ts` lists them for the worker, and `failure.ts` holds the shared error handling and browser setup. Ranking stays in the workflow as plain arithmetic. Demo mode uses no Temporal connection and schedules no activities.

Live searches run on [Temporal Cloud](https://docs.temporal.io/cloud) with API key authentication. In the Temporal Cloud UI:

1. Create a namespace (for example `guinness-plz.<account-id>`) with API key authentication enabled.
2. Create an API key, preferably for a service account, with write access to that namespace.
3. Copy the namespace's regional gRPC endpoint, for example `us-east-1.aws.api.temporal.io:7233`.

Set `TEMPORAL_ADDRESS` (the endpoint), `TEMPORAL_NAMESPACE`, and `TEMPORAL_API_KEY` in `.env`. `TEMPORAL_TASK_QUEUE` is optional and defaults to `guinness-plz`. There is no local Temporal server option.

`server.ts` connects at startup over TLS and runs a worker in the same process. If a setting is missing or Temporal Cloud is unreachable, the app still starts and demo mode works, but live search stays disabled until you restart the server. `npm run worker` runs a standalone worker with the same settings. The workflow id is the job id the page polls, so the namespace's Workflows page in the Temporal Cloud UI shows each live search's activity history. API keys expire; after replacing the key in `.env`, restart the server and any standalone worker.

Map activities retry up to three attempts, and research activities up to two. A missing OpenAI key is not retried. Each map activity opens and closes its own headless browser.

## Agents

Two agents run inside the `beerRun` workflow through Temporal's [OpenAI Agents SDK integration](https://docs.temporal.io/develop/typescript/integrations/openai-agents) (`@temporalio/openai-agents`, experimental). The agent loop is workflow code, and each model turn is an activity registered by `OpenAIAgentsPlugin` on the worker. A worker restart resumes an agent at the turn it was on, without paying for earlier turns again. Both agents are in `temporal/agents.ts`. They ask for the model name `guinness-research`, which the worker maps to `OPENAI_MODEL`.

- **Recovery agent.** When the first pass drops a store (no usable price, an unsupported source, or a branch the map could not place), the agent gets the store and the reason. It has two tools: `search_price` runs a fresh one-store web search with an approach the agent chooses (activity `researchOffer`), and `confirm_branch` runs the usual map check (activity `confirmStore`). It gets two searches, two map checks, and six turns. The workflow fixes the store, so the agent cannot switch retailers. Tool results go through the same `offerProblem` and source checks as the first pass, and only a branch a tool confirmed is kept. Up to three stores per search are recovered. Out-of-stock offers are not retried.
- **Price verifier.** Every kept store's cited page is opened in headless Chromium (`price-page.ts`, activity `readPricePage`). The verifier agent reads an excerpt of the page text and copies out the price and the pack size. `price-check.ts` then accepts those quotes only if they really appear in the page text, and accepts the price only if it appears inside the quote. A page showing a different price removes the store, with the page's price in a warning. A page that is blocked, does not load, or has no quotable price keeps the store, with the reason shown. A price that was just read from a remembered page (see below) is not read a second time.

Agent tracing is turned off, so tool inputs are not sent to OpenAI's trace dashboard.

The Agents SDK lazy-loads one module with `import()`. Because this package is ESM, webpack would split it into a chunk that the workflow sandbox cannot load. `temporal/worker.ts` sets webpack's `dynamicImportMode` to `eager` so the workflow bundle stays in one file. The bundle is about 15 MB, mostly the Agents SDK and zod.

## Live progress

`beerRun` hosts a [`WorkflowStream`](https://www.npmjs.com/package/@temporalio/workflow-streams) and publishes one event per step to its `progress` topic: each store being placed, each recovery search, and each page check. `GET /api/jobs/:id/events` subscribes to that topic and relays it to the page as server-sent events, and the page shows the latest few lines under the stepper. The event id is the stream offset, so a reconnecting browser resumes where it left off. The step query and the one-second poll still drive the stepper and deliver the result, so a dropped feed only hides detail. Model output is not streamed token by token: the agents answer in JSON, which is not useful to watch being typed.

## Price watches

A price watch reruns a search on a schedule and ends when the cheapest pickup cost (the full trip when fuel is known, otherwise the shelf price) is at or under your target. It is a `priceWatch` workflow (`temporal/watch.ts`). Each check is a child `beerRun`, and between checks the watch waits on a durable timer. Checks run every 6, 12, or 24 hours, or every 3 days, and a watch stops after 14 days. A failed check is recorded and the watch keeps going. The watch continues as new every 10 checks to keep its history small.

The **Price watch** panel starts a watch with the form's current values, demo mode included, and lists up to 10 watches from Temporal's visibility list. No database is involved. Up to three watches can run at once. Each live check is a full live search and costs OpenAI usage. While a check is running, a manual live search is refused, the same way as two manual searches at once. Watches need a Temporal connection, but a demo watch needs no OpenAI key. The page shows a watch that hit its target; nothing is sent outside the page.

## Telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in `.env` to send traces, logs, and metrics to Grafana over OTLP. Copy both from the OpenTelemetry (OTLP) page of your Grafana Cloud stack. With no endpoint, nothing is exported and agent tracing stays off. `temporal/telemetry.ts` sets everything up.

- **Traces (Tempo).** One trace per API request, containing the Temporal client, workflow, and activity spans. Each research model call has its own span, with one event per web search showing the query and the pages it returned. Each agent run ("Store recovery" or "Price verifier") is a separate trace with spans for turns, tool calls, and model calls. These spans carry the prompt, tool arguments and results, model output, and token counts. All spans for one search share `temporalWorkflowId`, so `{ span.temporalWorkflowId = "<job id>" }` in TraceQL finds them all.
- **Logs (Loki).** Worker, workflow, and activity logs, including every live-feed message, plus one record per model call and tool call holding the full payload. Span attributes are cut at 8,000 characters, and the log record keeps the full text. Records carry the trace id, so Grafana links them to their spans.
- **Metrics (Mimir).** Temporal's worker metrics (`temporal_*`), plus `guinness_*` counters for dropped offers, recoveries, kept stores, price-check results, watch checks, agent runs, turns, and tool calls, plus model calls, tokens by type, web searches, and model-call latency.

These records include addresses, store names, and page text, the same data the app already sends to OpenAI. Nothing goes to OpenAI's own trace dashboard.

## Enable live research

Copy `.env.example` to `.env`, set `OPENAI_API_KEY` and the Temporal Cloud settings described above, then restart the server. No Google Maps API key or Google Cloud project is needed. Choose an OpenAI model with Responses API web search and structured outputs support using `OPENAI_MODEL`; the starter defaults to `gpt-5.4`. OpenAI calls incur provider charges. Keep the key in `.env`, not in chat or frontend source.

`npm run browser:install` installs Playwright Chromium on this machine. The backend opens a fresh headless browser for a live search and closes it in a `finally` block. It uses public OpenStreetMap address searches and Google Maps directions URLs, reads a matching address result’s coordinates and a single driving-route card, and retains route source links in the results. It does not attach to your personal browser or use its signed-in session.

Store research uses two localized OpenAI web searches. The first looks up liquor stores, beer stores, and grocery stores named in local listings. The second looks up the exact 8-pack only at stores that listing search returned. Retailers often round the 14.9 fl oz can to 14 oz, 15 oz, or 440 ml, so the price searches and the verifier accept those labels for a Guinness Draught can 8-pack. No retailer names are built into the app. Gas research uses the same localized web search and looks up “gas prices near me” at neighborhood stations. Headless browsing replaces location and driving-distance API calls.

## Remembered price pages

Two web searches from the same address can cite different stores. To keep results steady, a page whose 8-pack price the verifier found is saved for that area (by ZIP code) in `data/price-pages.json`, up to eight pages (activities `rememberedPages` and `rememberPages` in `temporal/activities/remembered-pages.ts`). The next search for that area reads those pages again while store and gas research run. A page whose price the verifier finds again becomes an offer and goes through the same map and radius checks as a web-search offer; a web-search offer for the same branch is then dropped. A page that loads but no longer shows the 8-pack is forgotten. A page that fails to load is kept for the next search. Delete the file to start fresh. It holds store names, addresses, and URLs, not your address.

## Workflow

1. Validate the address, radius (1–50 miles), MPG (5–150), and optional gas override.
2. Locate the starting street address in headless OpenStreetMap search. Require one matching US street address and valid coordinates from that result; never substitute map camera coordinates. Only its city/state/postal area goes to the research agents.
3. Run store research, gas research, and the reread of remembered price pages concurrently. Store and gas research go through the OpenAI Responses API web search and require structured results and source URLs. Store research first searches local listings for liquor stores, beer stores, and grocery stores near the city, then searches only those named stores for an exact 8-pack, a branch address, availability, and price caveats. A store the local listings did not name is dropped, unless a remembered page priced it. Gas is a “gas prices near me” lookup for the entered city: regular prices at neighborhood stations, dated today when the listing is current, and no older than seven days.
4. Exclude offers without a searched source URL, USD price, exact pack count, or eligible stock status. Locate branches with the headless browser and filter by **straight-line radius**. Exclude branches that cannot be located. Read outbound and return driving routes separately from their route cards. If either route is unavailable, keep the shelf price visible but leave fuel and total unavailable.
5. Rank estimated totals: `shelf price + (round_trip_driving_miles / mpg × gas_price_per_gallon)`. Round currency only after calculation. If gas or driving-distance research fails, show product prices with fuel/total unavailable. A manual gas override resolves missing gas, but never missing routes. Fully calculated totals rank ahead of shelf-only results.

After step 4, the recovery agent retries dropped stores and the verifier checks each kept store's cited page (see Agents). The browser polls actual workflow stages through a Temporal query. Errors are explicit, with no silent fallback from live to demo. Demo searches are held in process memory (up to 50 jobs, old completed jobs removed on new searches after 30 minutes). Live searches are stored in Temporal Cloud workflow history, including the address in the workflow input and the results, for the namespace's retention period. Keys are not logged or written to disk by this app. OpenStreetMap receives the street address through browser search, and Google Maps receives the route coordinates; OpenAI receives the locality and product request. Provider retention policies still apply. The app uses `store: false` for Responses calls.

## Limits

This is a first local version, not a complete inventory feed. Public search may miss retailers, stale pages may remain indexed, and a listed price may not apply to the chosen branch. Source linkage confirms a URL came from the search. The price check confirms the price was on that page when the search ran, but only for pages a headless browser can read, and many retailer sites block it. Read linked sources and confirm stock and branch price before traveling. Offers with unconfirmed branch pricing/stock remain visible with caveats. No qualifying publicly indexed 8-pack listings produces an empty result, never invented offers.

Browser lookups can fail when public map sites change their UI, requires consent or human verification, or does not expose a precise address/route. These failures remain explicit; there is no CAPTCHA bypass or straight-line driving-distance estimate. Shelf-only results are not labeled the cheapest pickup option. Full live research still needs a separate check with your OpenAI key.

Prices exclude tax, deposits, tolls, parking, vehicle wear, and time. Routing requests avoid tolls and ferries, but those avoidance preferences are not guaranteed. Fuel cost uses regular gasoline and the MPG you enter. This app binds to loopback and is intended for one local user; do not expose it to the internet without authentication, abuse controls, and a production server. No purchases or reservations are made.

## Tests

```sh
npm test
npm run typecheck
npm run build
```

Tests cover validation, cost ranking, unavailable fuel prices, radius filtering, source eligibility, routing failures, and live provider orchestration through mocks. `tests/temporal.test.ts` runs the `beerRun` workflow on a local Temporal test server with fake activities; its first run downloads that test server. `tests/agents.test.ts` and `tests/watch.test.ts` run the agents, the live feed, and price watches the same way, with the real Agents plugin and a scripted model (`tests/temporal-harness.ts`). `tests/price-check.test.ts` covers the quote checks. Tests also cover location-pin validation, route parsing, incomplete routes, and shelf-only ranking. Full live research requires an OpenAI key and must be checked separately.

## Provider documentation

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Google Maps URLs (no API key)](https://developers.google.com/maps/documentation/urls/get-started)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
- [Playwright browsers](https://playwright.dev/docs/browsers)

Independent project, not affiliated with Guinness.
