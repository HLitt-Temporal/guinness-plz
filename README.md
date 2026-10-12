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

Vite runs as middleware on the same local server as the API, so one command starts the app with React hot updates. Node watches only `server.ts`, `workflow.ts`, and `headless-maps.ts` for backend restarts; Vite handles frontend and Vite configuration changes. This prevents generated files in `node_modules/.vite-temp` from restarting the server and clearing in-memory searches. Restart manually after changing `.env`. API keys stay in the backend's `.env`; never prefix secrets with `VITE_`. Opening an HTML file directly is not supported.

For the built frontend:

```sh
npm run build
npm start
```

The server serves Vite's `dist/` output in this mode. Frontend sources live in `frontend/src/`; `workflow.ts` contains research and calculation logic, and `server.ts` handles API requests and frontend serving.

## Enable live research

Copy `.env.example` to `.env`, set **only `OPENAI_API_KEY`**, then restart the server. No Google Maps API key or Google Cloud project is needed. Choose an OpenAI model with Responses API web search and structured outputs support using `OPENAI_MODEL`; the starter defaults to `gpt-5.4`. OpenAI calls incur provider charges. Keep the key in `.env`, not in chat or frontend source.

`npm run browser:install` installs Playwright Chromium on this machine. The backend opens a fresh headless browser for a live search and closes it in a `finally` block. It uses public OpenStreetMap address searches and Google Maps directions URLs, reads a matching address result’s coordinates and a single driving-route card, and retains route source links in the results. It does not attach to your personal browser or use its signed-in session.

Store research uses two localized OpenAI web searches. The first looks up liquor stores, beer stores, and grocery stores named in local listings. The second looks up the exact 8-pack only at stores that listing search returned. No retailer names are built into the app. Gas research uses the same localized web search and looks up “gas prices near me” at neighborhood stations. Headless browsing replaces location and driving-distance API calls.

## Workflow

1. Validate the address, radius (1–50 miles), MPG (5–150), and optional gas override.
2. Locate the starting street address in headless OpenStreetMap search. Require one matching US street address and valid coordinates from that result; never substitute map camera coordinates. Only its city/state/postal area goes to the research agents.
3. Run store and gas research concurrently through OpenAI Responses API web search. Require structured results and source URLs. Store research first searches local listings for liquor stores, beer stores, and grocery stores near the city, then searches only those named stores for an exact 8-pack, a branch address, availability, and price caveats. A store the local listings did not name is dropped. Gas is a “gas prices near me” lookup for the entered city: regular prices at neighborhood stations, dated today when the listing is current, and no older than seven days.
4. Exclude offers without a searched source URL, USD price, exact pack count, or eligible stock status. Locate branches with the headless browser and filter by **straight-line radius**. Exclude branches that cannot be located. Read outbound and return driving routes separately from their route cards. If either route is unavailable, keep the shelf price visible but leave fuel and total unavailable.
5. Rank estimated totals: `shelf price + (round_trip_driving_miles / mpg × gas_price_per_gallon)`. Round currency only after calculation. If gas or driving-distance research fails, show product prices with fuel/total unavailable. A manual gas override resolves missing gas, but never missing routes. Fully calculated totals rank ahead of shelf-only results.

The browser polls actual workflow stages. Errors are explicit, with no silent fallback from live to demo. Searches are held in process memory (up to 50 jobs, old completed jobs removed on new searches after 30 minutes). Addresses and keys are not logged or written to disk by this app. OpenStreetMap receives the street address through browser search, and Google Maps receives the route coordinates; OpenAI receives the locality and product request. Provider retention policies still apply. The app uses `store: false` for Responses calls.

## Limits

This is a first local version, not a complete inventory feed. Public search may miss retailers, stale pages may remain indexed, and a listed price may not apply to the chosen branch. Source linkage confirms a URL came from the search, not that the extracted claim is correct. Read linked sources and confirm stock and branch price before traveling. Offers with unconfirmed branch pricing/stock remain visible with caveats. No qualifying publicly indexed 8-pack listings produces an empty result, never invented offers.

Browser lookups can fail when public map sites change their UI, requires consent or human verification, or does not expose a precise address/route. These failures remain explicit; there is no CAPTCHA bypass or straight-line driving-distance estimate. Shelf-only results are not labeled the cheapest pickup option. Full live research still needs a separate check with your OpenAI key.

Prices exclude tax, deposits, tolls, parking, vehicle wear, and time. Routing requests avoid tolls and ferries, but those avoidance preferences are not guaranteed. Fuel cost uses regular gasoline and the MPG you enter. This app binds to loopback and is intended for one local user; do not expose it to the internet without authentication, abuse controls, and a production server. No purchases or reservations are made.

## Tests

```sh
npm test
npm run typecheck
npm run build
```

Tests cover validation, cost ranking, unavailable fuel prices, radius filtering, source eligibility, routing failures, and live provider orchestration through mocks. Tests also cover location-pin validation, route parsing, incomplete routes, and shelf-only ranking. Full live research requires an OpenAI key and must be checked separately.

## Provider documentation

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Google Maps URLs (no API key)](https://developers.google.com/maps/documentation/urls/get-started)
- [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
- [Playwright browsers](https://playwright.dev/docs/browsers)

Independent project, not affiliated with Guinness.
