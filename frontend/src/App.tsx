/*
  The page. It never calls OpenAI and never opens a map.

  Submitting the form POSTs the goal (address, radius, mpg, optional gas price,
  demo or live) to this app's server. The server answers immediately with a job
  id, because the agent work takes minutes. This component then polls that job
  once a second. Each poll includes a step number, which is the stepper:
  locate, research, map checks, price checks, rank. A live search also opens
  the job's event stream, which is the running list of what the agents are doing.

  The price-watch panel starts a watch on the same form values and lists the
  watches Temporal is running.

  Demo mode runs the same page with fictional stores, so you can see the shape
  of a result before you have an API key. A failed live search stays failed.
  The previous result, if you had one, stays on screen and is labeled as previous.
*/

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  Step,
  StepLabel,
  Stepper,
  Switch,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import type { PriceCheck } from '../../price-check.ts';
import { DONE_STEP } from '../../temporal/progress.ts';
import type { ProgressEvent, WatchView } from '../../temporal/progress.ts';
import { WATCH_DAYS, WATCH_INTERVAL_HOURS } from '../../workflow.ts';
import type { Gas, Result, Store } from '../../workflow.ts';

// Labels for workflow steps 0–4. Step 5 means the job is finished; the stepper
// treats that as every step complete.
const SEARCH_STEPS = [
  'Locate address',
  'Research stores & gas',
  'Check stores on the map',
  'Check prices on cited pages',
  'Rank pickup costs',
];

// What each step is, for people who have not seen Temporal. Same order as
// SEARCH_STEPS.
const STAGE_NOTES = [
  'One activity: a headless browser finds your address on OpenStreetMap. Temporal retries it up to three times.',
  'Three activities at once: AI store search, AI gas search, and rereading price pages from earlier searches.',
  'One activity per store, one at a time. A dropped store goes to the recovery agent, which searches again.',
  'The verifier agent reads each store’s cited page. Every model turn is saved, so a crash never pays for it twice.',
  'Plain math in the workflow: shelf price plus round-trip fuel. No AI picks the winner.',
];

const PANEL_WIDTH = 400;
const PANEL_STORAGE_KEY = 'guinness-plz.behind-the-scenes';

// How often to ask the server "is the agent done yet?"
const POLL_INTERVAL_MS = 1000;
// The live feed shows the latest few steps, not the whole history.
const FEED_LINES = 8;
// Watches change every few hours. A slow refresh is enough.
const WATCH_POLL_MS = 15_000;

const WATCH_INTERVAL_LABELS: Record<number, string> = {
  6: 'Every 6 hours',
  12: 'Every 12 hours',
  24: 'Once a day',
  72: 'Every 3 days',
};

const smallLabel = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 2,
  color: 'text.secondary',
};

const pageColumns = {
  display: 'grid',
  gridTemplateColumns: { xs: '1fr', md: '340px minmax(0, 1fr)' },
  gap: 4,
  alignItems: 'start',
};

type SortBy = 'total' | 'price' | 'distance';

// What the form is collecting. This becomes the JSON body of POST /api/search.
// gasOverride is a string because an empty box means "look it up," not zero.
interface BeerRunForm {
  address: string;
  radius: number;
  mpg: string;
  gasOverride: string;
  demo: boolean;
}

// The poll response. While status is "running", step advances. "done" carries
// the Result from workflow.ts. "error" carries a message and no silent fallback.
interface JobStatus {
  status: 'running' | 'done' | 'error';
  step: number;
  result?: Result;
  // Stores the workflow has already placed. Present while status is running.
  stores?: Store[];
  error?: string;
}

interface TraceEvent extends ProgressEvent {
  at: number;
}

// Everything the side panel knows about the latest search. stageStarts[i] is
// when step i was first seen; the entry at DONE_STEP is when the run finished.
// Times are when this page saw them, not when the workflow ran them.
interface RunTrace {
  id: string | null;
  demo: boolean;
  startedAt: number;
  stageStarts: (number | null)[];
  events: TraceEvent[];
  error: string | null;
  failedAt: number | null;
}

function newTrace(demo: boolean): RunTrace {
  const now = Date.now();
  return {
    id: null,
    demo,
    startedAt: now,
    stageStarts: [now, ...Array<null>(DONE_STEP).fill(null)],
    events: [],
    error: null,
    failedAt: null,
  };
}

// Steps only move forward. A jump marks every skipped step as started now.
function advanceTrace(trace: RunTrace, step: number): RunTrace {
  const last = Math.min(step, DONE_STEP);
  if (trace.stageStarts[last] != null) return trace;
  const now = Date.now();
  return {
    ...trace,
    stageStarts: trace.stageStarts.map((at, index) => (index <= last ? (at ?? now) : at)),
  };
}

function currentStage(trace: RunTrace) {
  return trace.stageStarts.findLastIndex((at) => at != null);
}

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isAgentLine(message: string) {
  return message.startsWith('Recovery agent') || message.startsWith('Verifier');
}

function temporalRunUrl(namespace: string, workflowId: string) {
  return `https://cloud.temporal.io/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

function formatMoney(amount: number | null) {
  if (amount == null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatMiles(miles: number | null) {
  if (miles == null) return 'Unavailable';
  return `${miles.toFixed(1)} mi`;
}

function formatDriveTime(minutes: number | null) {
  if (minutes == null) return 'Driving time unavailable';
  return `~${minutes} min driving`;
}

function formatCheckedAt(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The feed is extra. If it drops, the stepper and the poll still finish the
// search. EventSource reconnects by itself and resumes from the last event id.
function followFeed(jobId: string, onEvent: (event: ProgressEvent) => void) {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as ProgressEvent);
    } catch {
      // A malformed event is skipped. The next one still arrives.
    }
  };
  source.addEventListener('end', () => source.close());
  return source;
}

function priceCheckLine(check: PriceCheck) {
  if (check.status === 'verified') return '✓ Price found on the cited page';
  return `Price not checked on the page: ${check.note}`;
}

function pickupCost(store: Store) {
  return store.total ?? store.price;
}

function pickupCostCaption(store: Store) {
  return store.total == null ? 'Shelf price · fuel unknown' : 'Product + round-trip fuel';
}

function confirmationLine(store: Store) {
  const price = store.branch_price_confirmed ? 'Branch price reported' : 'Branch price unconfirmed';
  const stock =
    store.availability === 'in_stock' ? 'Stock reported by source' : 'Stock unconfirmed';
  return store.notes ? `${price} · ${stock} · ${store.notes}` : `${price} · ${stock}`;
}

function directionsUrl(address: string) {
  const destination = encodeURIComponent(address);
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;
}

function routeSourceLabel(index: number) {
  return index === 0 ? 'Outbound route source ↗' : 'Return route source ↗';
}

// The chip above the results. "Live research" means an agent run produced this
// list. "Fictional demo data" means the workflow never called the model.
function shortlistStatus(searching: boolean, result: Result | null) {
  if (searching) return 'Researching';
  if (!result) return 'Ready when you are';
  if (result.demo) return 'Fictional demo data';
  return 'Live research';
}

// Unknown pickup costs sort last. Known costs sort cheapest first.
function compareStores(sortBy: SortBy, a: Store, b: Store) {
  if (sortBy === 'price') return a.price - b.price;
  if (sortBy === 'distance') return a.radius_miles - b.radius_miles;
  const unknownCost = Number(a.total == null) - Number(b.total == null);
  return unknownCost || pickupCost(a) - pickupCost(b);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(url)) return null;
  return (
    <Link href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}

function StoreCard({ store, best, demo }: { store: Store; best: boolean; demo: boolean }) {
  const stats = [
    ['Price', formatMoney(store.price)],
    ['Fuel', formatMoney(store.fuel_cost)],
    ['Round trip', formatMiles(store.round_trip_miles)],
  ] as const;

  return (
    <Card variant="outlined" sx={{ borderColor: best ? 'primary.main' : 'divider' }}>
      <CardContent>
        {best && (
          <Chip
            color="primary"
            size="small"
            label={demo ? 'Lowest demo pickup cost' : 'Lowest estimated pickup cost'}
            sx={{ mb: 1.5 }}
          />
        )}
        <Stack direction="row" sx={{ justifyContent: 'space-between', gap: 2 }}>
          <Box>
            <Typography variant="h3" sx={{ fontSize: 22 }}>
              {store.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {store.address}
            </Typography>
          </Box>
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Typography color="primary" sx={{ fontSize: 28, lineHeight: 1.2 }}>
              {formatMoney(pickupCost(store))}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {pickupCostCaption(store)}
            </Typography>
          </Box>
        </Stack>
        <Divider sx={{ my: 2 }} />
        <Stack direction="row" sx={{ gap: { xs: 2, sm: 4 } }}>
          {stats.map(([label, value]) => (
            <Box key={label}>
              <Typography sx={{ fontSize: 14 }}>{value}</Typography>
              <Typography variant="caption" color="text.secondary">
                {label}
              </Typography>
            </Box>
          ))}
        </Stack>
        <Divider sx={{ my: 2 }} />
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          sx={{ justifyContent: 'space-between', gap: 1, fontSize: 12 }}
        >
          <Typography variant="caption" color="text.secondary">
            {store.radius_miles.toFixed(1)} mi away · {formatDriveTime(store.round_trip_minutes)}
          </Typography>
          {demo ? (
            <Typography variant="caption">Fictional demo data</Typography>
          ) : (
            // The page the agent cited. The app checked that the URL came back
            // from search. A verified price check means the price was also
            // quoted from that page when this search ran.
            <ExternalLink url={store.source_url}>View price source ↗</ExternalLink>
          )}
        </Stack>
        <Typography color="text.secondary" sx={{ fontSize: 12, mt: 1 }}>
          {store.product}
        </Typography>
        <Typography color="text.secondary" sx={{ fontSize: 11, mt: 1 }}>
          {confirmationLine(store)}
        </Typography>
        {store.price_check && (
          <Typography
            color={store.price_check.status === 'verified' ? 'success.main' : 'text.secondary'}
            sx={{ fontSize: 11, mt: 1 }}
          >
            {priceCheckLine(store.price_check)}
          </Typography>
        )}
        {store.recovered && (
          <Typography color="text.secondary" sx={{ fontSize: 11, mt: 1 }}>
            The first search dropped this store. The recovery agent found it on a second search.
          </Typography>
        )}
        {store.route_source_urls?.map((url, index) => (
          <Box key={url} sx={{ fontSize: 12, mt: 1 }}>
            <ExternalLink url={url}>{routeSourceLabel(index)}</ExternalLink>
          </Box>
        ))}
        {!demo && (
          <Box sx={{ mt: 1, fontSize: 12 }}>
            <ExternalLink url={directionsUrl(store.address)}>Get directions ↗</ExternalLink>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function SiteHeader({
  panelOpen,
  onTogglePanel,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{ borderBottom: 1, borderColor: 'divider' }}
    >
      <Toolbar sx={{ px: { xs: 3, md: 8 }, minHeight: { sm: 85 } }}>
        <Typography sx={{ fontWeight: 750, fontSize: 23, flexGrow: 1 }}>
          guinness-plz<span style={{ color: '#a78343' }}>.</span>
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: { xs: 'none', sm: 'block' } }}
        >
          A little research. A better beer run.
        </Typography>
        <Button
          size="small"
          variant={panelOpen ? 'contained' : 'outlined'}
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          aria-controls="behind-the-scenes"
          sx={{ ml: 3 }}
        >
          Behind the scenes
        </Button>
      </Toolbar>
    </AppBar>
  );
}

function Hero() {
  return (
    <Box sx={{ mb: 5 }}>
      <Typography sx={smallLabel}>THE COST OF GETTING THERE COUNTS.</Typography>
      <Typography
        component="h1"
        variant="h1"
        sx={{ fontSize: { xs: 44, sm: 58 }, letterSpacing: -2, lineHeight: 1.1, my: 2 }}
      >
        Your next Guinness.
        <br />
        <Box component="em" color="primary.main">
          For a little less.
        </Box>
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 500 }}>
        Find Guinness nearby. Let the agents check the shelf price, the gas price, and what the trip
        will actually cost.
      </Typography>
      <Chip variant="outlined" label="Any Guinness · any size" sx={{ mt: 2 }} />
    </Box>
  );
}

// The form is the goal you give the workflow. Nothing here talks to the model.
// searching disables the fields so you cannot start a second run while the
// first job is still being polled.
function SearchPanel({
  form,
  searching,
  onChange,
  onSubmit,
}: {
  form: BeerRunForm;
  searching: boolean;
  onChange: (patch: Partial<BeerRunForm>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography sx={smallLabel}>01 / YOUR BEER RUN</Typography>
      <Typography variant="h2" sx={{ fontSize: 25, mt: 1, mb: 2.5 }}>
        Where are we starting?
      </Typography>
      <Divider sx={{ mb: 3 }} />
      <Box component="form" onSubmit={onSubmit}>
        <Stack sx={{ gap: 3 }}>
          <TextField
            label="Pickup starting address"
            value={form.address}
            onChange={(event) => onChange({ address: event.target.value })}
            placeholder="Street, city, state, ZIP"
            autoComplete="street-address"
            required
            disabled={searching}
            slotProps={{ htmlInput: { minLength: 5, maxLength: 250 } }}
            helperText="US addresses · miles · USD"
          />
          <Box>
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography id="radius-label" sx={{ fontSize: 13 }}>
                Search radius
              </Typography>
              <Typography color="primary" sx={{ fontSize: 13, fontWeight: 700 }}>
                {form.radius} miles
              </Typography>
            </Stack>
            <Slider
              aria-labelledby="radius-label"
              value={form.radius}
              onChange={(_, value) => onChange({ radius: value as number })}
              min={1}
              max={50}
              valueLabelDisplay="auto"
              disabled={searching}
            />
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                1 mi
              </Typography>
              <Typography variant="caption" color="text.secondary">
                50 mi
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Straight-line radius from your address.
            </Typography>
          </Box>
          <Stack direction="row" sx={{ gap: 2 }}>
            <TextField
              label="Your car’s MPG"
              type="number"
              value={form.mpg}
              onChange={(event) => onChange({ mpg: event.target.value })}
              required
              disabled={searching}
              slotProps={{ htmlInput: { min: 5, max: 150, step: 0.1 } }}
            />
            <TextField
              label="Gas override"
              type="number"
              value={form.gasOverride}
              onChange={(event) => onChange({ gasOverride: event.target.value })}
              placeholder="$/gallon"
              disabled={searching}
              slotProps={{ htmlInput: { min: 0.1, max: 20, step: 0.001 } }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
            Leave gas blank to look up regular prices at stations near you.
          </Typography>
          <Box sx={{ bgcolor: '#efefe7', borderRadius: 1, px: 1.5, py: 1 }}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={form.demo}
                  onChange={(event) => onChange({ demo: event.target.checked })}
                  disabled={searching}
                />
              }
              label={<Typography sx={{ fontSize: 13 }}>Try with demo data</Typography>}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {form.demo
                ? 'Fictional stores and prices. No API keys needed.'
                : 'Live research uses OpenAI and headless browser lookups.'}
            </Typography>
          </Box>
          <Button variant="contained" type="submit" fullWidth disabled={searching} size="large">
            {searching ? 'Researching your beer run…' : 'Find my best beer run ↗'}
          </Button>
          <Typography color="text.secondary" sx={{ fontSize: 10 }}>
            Live mode searches your address on OpenStreetMap, reads driving routes on Google Maps,
            and sends your city / ZIP area to OpenAI for research. This app doesn’t save your
            address to disk.
          </Typography>
        </Stack>
      </Box>
    </Paper>
  );
}

// Shown in place of the results while the job status is "running". feed is
// the live list of what the workflow and its agents are doing, newest last.
function SearchProgress({ step, demo, feed }: { step: number; demo: boolean; feed: string[] }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, mt: 3 }} aria-live="polite">
      <Stepper activeStep={step} orientation="vertical">
        {SEARCH_STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      {feed.length > 0 && (
        <Box component="ol" sx={{ mt: 2, mb: 0, pl: 2.5 }}>
          {feed.map((line, index) => (
            <Typography
              component="li"
              key={`${index}-${line}`}
              color={index === feed.length - 1 ? 'text.primary' : 'text.secondary'}
              sx={{ fontSize: 12, mb: 0.5 }}
            >
              {line}
            </Typography>
          ))}
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        {demo
          ? 'Calculating with fictional demo data.'
          : 'Researching public sources. Live searches can take a few minutes.'}
      </Typography>
    </Paper>
  );
}

type WatchSummary = WatchView & { id: string };

function watchStatusLabel(status: WatchView['status']) {
  if (status === 'checking') return 'Checking now';
  if (status === 'waiting') return 'Watching';
  if (status === 'met') return 'Target hit';
  if (status === 'stopped') return 'Stopped';
  return 'Ended';
}

function lastCheckLine(watch: WatchSummary) {
  const last = watch.recent[0];
  if (!last) return 'First check is running.';
  const found = last.error
    ? last.error
    : last.best == null
      ? 'no Guinness price found'
      : `${formatMoney(last.best)} at ${last.store}`;
  return `Last check ${formatWhen(last.at)}: ${found}`;
}

function WatchCard({ watch, onStop }: { watch: WatchSummary; onStop: (id: string) => void }) {
  const running = watch.status === 'checking' || watch.status === 'waiting';
  return (
    <Card variant="outlined">
      <CardContent>
        {watch.status === 'met' && watch.met && (
          <Alert severity="success" sx={{ mb: 1.5 }}>
            Target hit: {watch.met.store} at {formatMoney(watch.met.best)}, checked{' '}
            {formatWhen(watch.met.at)}.
          </Alert>
        )}
        <Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: 15 }}>
              At or under {formatMoney(watch.target_price)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {watch.address} · {watch.radius} mi{watch.demo ? ' · demo data' : ''}
            </Typography>
          </Box>
          <Chip size="small" variant="outlined" label={watchStatusLabel(watch.status)} />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {watch.checks_done} of {watch.max_checks} checks ·{' '}
          {WATCH_INTERVAL_LABELS[watch.interval_hours]?.toLowerCase() ??
            `every ${watch.interval_hours} h`}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {lastCheckLine(watch)}
        </Typography>
        {watch.next_check_at && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Next check {formatWhen(watch.next_check_at)}
          </Typography>
        )}
        {running && (
          <Button size="small" sx={{ mt: 1, px: 0 }} onClick={() => onStop(watch.id)}>
            Stop watching
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// A watch re-runs the search above on a schedule. It uses the form as it is
// now, including demo mode, so the address and settings are not typed twice.
function PriceWatchPanel({ form, ready }: { form: BeerRunForm; ready: boolean }) {
  const [target, setTarget] = useState('');
  const [intervalHours, setIntervalHours] = useState(24);
  const [watches, setWatches] = useState<WatchSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const checks = Math.ceil((WATCH_DAYS * 24) / intervalHours);

  async function refresh(signal?: AbortSignal) {
    const data = await request<{ watches: WatchSummary[] }>('/api/watches', { signal });
    setWatches(data.watches);
  }

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const load = () => {
      refresh(controller.signal).catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load price watches.'));
      });
    };
    load();
    const timer = window.setInterval(load, WATCH_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [ready]);

  async function startWatch() {
    setBusy(true);
    setError('');
    try {
      await request<{ id: string }>('/api/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: form.address,
          radius: form.radius,
          mpg: Number(form.mpg),
          gas_override: form.gasOverride === '' ? null : Number(form.gasOverride),
          demo: form.demo,
          target_price: Number(target),
          interval_hours: intervalHours,
        }),
      });
      await refresh();
    } catch (err) {
      setError(errorText(err, 'The price watch could not start.'));
    } finally {
      setBusy(false);
    }
  }

  async function stopWatch(id: string) {
    setError('');
    try {
      await request(`/api/watches/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(errorText(err, 'Could not stop the price watch.'));
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography sx={smallLabel}>03 / PRICE WATCH</Typography>
      <Typography variant="h2" sx={{ fontSize: 25, mt: 1, mb: 1 }}>
        Tell me when it drops.
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2.5 }}>
        Re-runs the beer run above on a schedule, and stops once the cheapest pickup cost is at or
        under your target.
      </Typography>
      <Stack sx={{ gap: 2 }}>
        <Stack direction="row" sx={{ gap: 2 }}>
          <TextField
            label="Target cost"
            type="number"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="$"
            disabled={!ready || busy}
            slotProps={{ htmlInput: { min: 1, max: 200, step: 0.01 } }}
          />
          <FormControl sx={{ minWidth: 140 }} disabled={!ready || busy}>
            <InputLabel id="watch-interval-label">Check</InputLabel>
            <Select
              labelId="watch-interval-label"
              label="Check"
              value={intervalHours}
              onChange={(event) => setIntervalHours(Number(event.target.value))}
            >
              {WATCH_INTERVAL_HOURS.map((hours) => (
                <MenuItem key={hours} value={hours}>
                  {WATCH_INTERVAL_LABELS[hours] ?? `Every ${hours} hours`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
          Up to {checks} checks over {WATCH_DAYS} days.{' '}
          {form.demo
            ? 'Demo data: prices never change.'
            : 'Each check is a full live search and uses OpenAI credits.'}
        </Typography>
        <Button
          variant="outlined"
          onClick={startWatch}
          disabled={!ready || busy || form.address.trim().length < 5 || target === ''}
        >
          {busy ? 'Starting…' : 'Watch this beer run'}
        </Button>
        {!ready && (
          <Typography variant="caption" color="text.secondary">
            Price watches run on Temporal Cloud. Set the TEMPORAL_* values in .env to turn them on.
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {watches.map((watch) => (
          <WatchCard key={watch.id} watch={watch} onStop={stopWatch} />
        ))}
      </Stack>
    </Paper>
  );
}

function GasPrice({ gas }: { gas: Gas }) {
  return (
    <Paper sx={{ p: 2, bgcolor: '#e7ebe1' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        sx={{ justifyContent: 'space-between', gap: 1 }}
      >
        <Box>
          <Typography color="primary" sx={{ fontWeight: 700 }}>
            {formatMoney(gas.price)}
            {gas.price == null ? '' : ' / gal'}
          </Typography>
          <Typography variant="caption">{gas.location}</Typography>
        </Box>
        <Box sx={{ fontSize: 12 }}>
          {gas.source_url ? (
            <ExternalLink url={gas.source_url}>Gas price source ↗</ExternalLink>
          ) : (
            <Typography variant="caption">{gas.notes}</Typography>
          )}
          {gas.observed_date && (
            <Typography variant="caption" sx={{ display: 'block' }}>
              Observed {gas.observed_date}
            </Typography>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

function Results({
  result,
  sortBy,
  showingPreviousResult,
  partial,
  onSortByChange,
}: {
  result: Result;
  sortBy: SortBy;
  showingPreviousResult: boolean;
  partial: boolean;
  onSortByChange: (sortBy: SortBy) => void;
}) {
  const stores = [...result.stores].sort((a, b) => compareStores(sortBy, a, b));
  // The workflow already ranked by pickup cost. That badge stays on the same
  // store when you re-sort the list by shelf price or distance.
  const bestStoreId = result.stores[0]?.total != null ? result.stores[0].id : null;

  return (
    <Box aria-live="polite">
      {showingPreviousResult && (
        <Alert severity="info" sx={{ mt: 2 }}>
          Showing the previous search. The latest search failed.
        </Alert>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', my: 2 }}>
        {partial
          ? 'Placed so far. The rest of the list is still being checked.'
          : `${result.location} · Checked at ${formatCheckedAt(result.checked_at)}`}
      </Typography>
      {!partial && <GasPrice gas={result.gas} />}
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'center', my: 2, gap: 2 }}
      >
        <Typography variant="caption" color="text.secondary">
          {stores.length} offers within radius
        </Typography>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel id="sort-label">Sort by</InputLabel>
          <Select
            labelId="sort-label"
            label="Sort by"
            value={sortBy}
            onChange={(event) => onSortByChange(event.target.value as SortBy)}
          >
            <MenuItem value="total">Pickup cost</MenuItem>
            <MenuItem value="price">Shelf price</MenuItem>
            <MenuItem value="distance">Distance</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <Stack sx={{ gap: 2 }}>
        {stores.map((store) => (
          <StoreCard
            key={store.id}
            store={store}
            best={store.id === bestStoreId}
            demo={result.demo}
          />
        ))}
        {!stores.length && (
          <Alert severity="info">
            No Guinness prices found in this radius. Try a wider search.
          </Alert>
        )}
        {result.warnings.map((warning, index) => (
          <Alert severity="warning" key={index}>
            {warning}
          </Alert>
        ))}
      </Stack>
      <Typography color="text.secondary" sx={{ fontSize: 11, mt: 2 }}>
        Estimated product + fuel cost. Excludes sales tax, deposits, tolls, parking, vehicle wear,
        and your time. Stock and branch pricing may need confirmation.
      </Typography>
    </Box>
  );
}

function EmptyState() {
  return (
    <Box sx={{ textAlign: 'center', py: 7 }}>
      <Box
        sx={{
          width: 94,
          height: 170,
          bgcolor: '#19271d',
          color: '#ede5cb',
          borderRadius: '10px 10px 16px 16px',
          borderTop: '7px solid #b5b9ab',
          borderBottom: '6px solid #b5b9ab',
          transform: 'rotate(-7deg)',
          mx: 'auto',
          mb: 4,
          boxShadow: '9px 14px 20px #252a2520',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
        }}
        aria-hidden="true"
      >
        <Typography color="secondary" sx={{ fontSize: 30 }}>
          ♧
        </Typography>
        <Typography sx={{ fontFamily: 'Georgia', fontSize: 14 }}>GUINNESS</Typography>
        <Typography sx={{ fontSize: 7, letterSpacing: 3 }}>DRAUGHT</Typography>
        <Divider sx={{ width: 45, borderColor: '#a78343', my: 1.5 }} />
        <Typography sx={{ fontSize: 6, letterSpacing: 1 }}>
          GOOD THINGS
          <br />
          ARE WORTH FINDING.
        </Typography>
      </Box>
      <Typography variant="h3" sx={{ fontSize: 28 }}>
        Less guessing. More Guinness.
      </Typography>
      <Typography color="text.secondary" sx={{ fontSize: 14, my: 2 }}>
        Enter your address to compare Guinness prices
        <br />
        with the cost of the round trip included.
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Shelf price + round-trip fuel = your pickup cost
      </Typography>
    </Box>
  );
}

// Ticks once a second while active, so running timers move between events.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

type StageState = 'pending' | 'running' | 'done' | 'failed';

function StageMarker({ state }: { state: StageState }) {
  const box = {
    width: 22,
    height: 22,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
  };
  if (state === 'running') {
    return (
      <Box sx={box}>
        <CircularProgress size={18} thickness={5} aria-label="Running" />
      </Box>
    );
  }
  if (state === 'done') {
    return (
      <Box sx={{ ...box, bgcolor: 'success.main', color: 'common.white' }} aria-label="Done">
        ✓
      </Box>
    );
  }
  if (state === 'failed') {
    return (
      <Box sx={{ ...box, bgcolor: 'error.main', color: 'common.white' }} aria-label="Failed">
        !
      </Box>
    );
  }
  return <Box sx={{ ...box, border: 2, borderColor: 'divider' }} aria-label="Waiting" />;
}

// A running account of the latest search, grouped by workflow step, for
// showing people what Temporal does while it happens.
function BehindTheScenes({
  trace,
  running,
  namespace,
}: {
  trace: RunTrace | null;
  running: boolean;
  namespace: string | null;
}) {
  const now = useNow(running);
  const scroller = useRef<HTMLDivElement>(null);
  const eventCount = trace?.events.length ?? 0;

  useEffect(() => {
    const element = scroller.current;
    if (element && running) element.scrollTop = element.scrollHeight;
  }, [eventCount, running]);

  const stage = trace ? currentStage(trace) : -1;
  const finishedAt = trace?.failedAt ?? trace?.stageStarts[DONE_STEP] ?? null;
  const elapsed = trace ? (finishedAt ?? now) - trace.startedAt : 0;

  function stageState(index: number): StageState {
    if (!trace || trace.stageStarts[index] == null) return 'pending';
    if (index < stage) return 'done';
    if (trace.error) return 'failed';
    return 'running';
  }

  function stageDuration(index: number) {
    const start = trace?.stageStarts[index];
    if (!trace || start == null) return null;
    const end = trace.stageStarts[index + 1] ?? (index === stage ? (trace.failedAt ?? now) : null);
    return end == null ? null : formatElapsed(end - start);
  }

  return (
    <Box
      ref={scroller}
      id="behind-the-scenes"
      component="aside"
      aria-label="Behind the scenes"
      sx={{
        width: { xs: '100%', lg: PANEL_WIDTH },
        flexShrink: 0,
        position: { lg: 'sticky' },
        top: 0,
        height: { lg: '100vh' },
        overflowY: { lg: 'auto' },
        borderLeft: { lg: 1 },
        borderTop: { xs: 1, lg: 0 },
        borderColor: 'divider',
        bgcolor: 'background.paper',
        px: 3,
        py: 4,
      }}
    >
      <Typography sx={smallLabel}>BEHIND THE SCENES</Typography>
      <Typography variant="h2" sx={{ fontSize: 22, mt: 1, mb: 1 }}>
        What the workflow is doing
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        A live search runs as a Temporal workflow. Temporal saves each step as it finishes, so if
        the server crashes, the search picks up where it stopped instead of starting over.
      </Typography>

      {!trace && (
        <Typography color="text.secondary" sx={{ fontSize: 14, mt: 4 }}>
          Start a search to watch each step here.
        </Typography>
      )}

      {trace && (
        <>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 3 }}>
            <Chip
              size="small"
              color={trace.demo ? 'default' : 'primary'}
              label={trace.demo ? 'Demo · runs in this server' : 'Live · Temporal workflow'}
            />
            <Typography variant="caption" color="text.secondary">
              {formatElapsed(elapsed)} elapsed
            </Typography>
          </Stack>
          {trace.demo && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Demo mode skips Temporal and finishes instantly. Turn off demo data to watch a real
              workflow.
            </Typography>
          )}
          {!trace.demo && trace.id && (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Workflow id
              </Typography>
              <Typography
                sx={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', mb: 0.5 }}
              >
                {trace.id}
              </Typography>
              {namespace && (
                <Box sx={{ fontSize: 13 }}>
                  <ExternalLink url={temporalRunUrl(namespace, trace.id)}>
                    Open this run in Temporal Cloud ↗
                  </ExternalLink>
                </Box>
              )}
            </Box>
          )}

          <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0, mt: 3 }}>
            {SEARCH_STEPS.map((label, index) => {
              const state = stageState(index);
              const duration = stageDuration(index);
              const events = trace.events.filter((event) => event.step === index);
              return (
                <Box
                  component="li"
                  key={label}
                  sx={{
                    display: 'flex',
                    gap: 1.5,
                    pb: 2.5,
                    opacity: state === 'pending' ? 0.55 : 1,
                  }}
                >
                  <StageMarker state={state} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Stack direction="row" sx={{ justifyContent: 'space-between', gap: 1 }}>
                      <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{label}</Typography>
                      {duration && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace' }}
                        >
                          {duration}
                        </Typography>
                      )}
                    </Stack>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mb: events.length ? 1 : 0 }}
                    >
                      {STAGE_NOTES[index]}
                    </Typography>
                    {events.map((event, eventIndex) => (
                      <Stack
                        key={`${event.at}-${eventIndex}`}
                        direction="row"
                        sx={{ gap: 1, alignItems: 'baseline', mb: 0.5 }}
                      >
                        <Typography
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace', fontSize: 10, flexShrink: 0 }}
                        >
                          +{formatElapsed(event.at - trace.startedAt)}
                        </Typography>
                        <Typography sx={{ fontSize: 12, minWidth: 0 }}>
                          {isAgentLine(event.message) && (
                            <Chip
                              label="AI agent"
                              size="small"
                              color="secondary"
                              sx={{ height: 16, fontSize: 9, mr: 0.75, verticalAlign: 'middle' }}
                            />
                          )}
                          {event.message}
                        </Typography>
                      </Stack>
                    ))}
                  </Box>
                </Box>
              );
            })}
          </Box>

          {trace.error && <Alert severity="error">{trace.error}</Alert>}
          {!trace.error && trace.stageStarts[DONE_STEP] != null && (
            <Alert severity="success">
              Finished in {formatElapsed(elapsed)}
              {trace.demo ? '.' : '. The full history stays in Temporal Cloud.'}
            </Alert>
          )}
        </>
      )}
    </Box>
  );
}

function SiteFooter() {
  return (
    <>
      <Divider sx={{ mt: 5, mb: 2 }} />
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        sx={{ justifyContent: 'space-between', gap: 1 }}
      >
        <Typography variant="caption" color="text.secondary">
          Built for the small decisions that add up.
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Map address data © OpenStreetMap contributors · Not affiliated with Guinness.
        </Typography>
      </Stack>
    </>
  );
}

export default function App() {
  const [form, setForm] = useState<BeerRunForm>({
    address: '',
    radius: 10,
    mpg: '25',
    gasOverride: '',
    demo: true,
  });
  const [result, setResult] = useState<Result | null>(null);
  const [liveStores, setLiveStores] = useState<Store[]>([]);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [step, setStep] = useState(0);
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [panelOpen, setPanelOpen] = useState(
    () => window.localStorage.getItem(PANEL_STORAGE_KEY) !== 'closed',
  );
  const [namespace, setNamespace] = useState<string | null>(null);
  const [watchReady, setWatchReady] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('total');
  const [showingPreviousResult, setShowingPreviousResult] = useState(false);
  const isMounted = useRef(true);
  // The poll loop is async. This blocks a second submit before React re-renders
  // searching=true, which is the gap where a double-click could start two jobs.
  const searchInFlight = useRef(false);

  function updateForm(patch: Partial<BeerRunForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  function togglePanel() {
    setPanelOpen((open) => {
      window.localStorage.setItem(PANEL_STORAGE_KEY, open ? 'closed' : 'open');
      return !open;
    });
  }

  useEffect(() => {
    isMounted.current = true;
    const controller = new AbortController();

    // Ask whether live search can run. If not, leave the demo switch on so the
    // first click does not start a live search that cannot run.
    request<{ live_ready: boolean; watch_ready: boolean; temporal_namespace: string | null }>(
      '/api/config',
      { signal: controller.signal },
    )
      .then((config) => {
        if (!isMounted.current) return;
        updateForm({ demo: !config.live_ready });
        setWatchReady(config.watch_ready);
        setNamespace(config.temporal_namespace ?? null);
      })
      .catch((err) => {
        if (controller.signal.aborted || !isMounted.current) return;
        setError(errorText(err, 'Could not connect to the server.'));
      });

    // A refresh forgets the job id. The last finished live search is still in
    // Temporal, so the shortlist can come back without running it again.
    // The server may be restarting, so a failed load is tried again.
    void (async () => {
      for (let attempt = 0; attempt < 5 && isMounted.current; attempt += 1) {
        try {
          const latest = await request<{ result: Result | null }>('/api/latest', {
            signal: controller.signal,
          });
          if (!isMounted.current || searchInFlight.current) return;
          if (latest.result) setResult((current) => current ?? latest.result);
          return;
        } catch {
          if (controller.signal.aborted) return;
          await delay(1000);
        }
      }
    })();

    return () => {
      isMounted.current = false;
      controller.abort();
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchInFlight.current) return;

    searchInFlight.current = true;
    setSearching(true);
    setError('');
    setShowingPreviousResult(false);
    setLiveStores([]);
    setStep(0);
    setTrace(newTrace(form.demo));
    let liveFeed: EventSource | null = null;

    try {
      // 202 and a job id. The stores are not in this response.
      const job = await request<{ id: string }>('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: form.address,
          radius: form.radius,
          mpg: Number(form.mpg),
          gas_override: form.gasOverride === '' ? null : Number(form.gasOverride),
          demo: form.demo,
        }),
      });
      setTrace((current) => current && { ...current, id: job.id });
      if (!form.demo) {
        liveFeed = followFeed(job.id, (event) => {
          if (!isMounted.current) return;
          setTrace(
            (current) =>
              current && {
                ...advanceTrace(current, event.step),
                events: [...current.events, { ...event, at: Date.now() }],
              },
          );
        });
      }

      // Poll until the workflow finishes, the job errors, or this component
      // unmounts. The delay is between polls so we do not hammer the server
      // while the model is still searching.
      let misses = 0;
      while (isMounted.current) {
        let status: JobStatus;
        try {
          status = await request<JobStatus>(`/api/jobs/${encodeURIComponent(job.id)}`);
          misses = 0;
        } catch (err) {
          // One dropped poll is not a failed search. The workflow keeps going.
          misses += 1;
          if (misses >= 5) throw err;
          await delay(POLL_INTERVAL_MS);
          continue;
        }
        if (!isMounted.current) break;
        if (status.status === 'error') {
          throw new Error(status.error || 'Search could not complete.');
        }

        setStep(status.step);
        setTrace((current) => current && advanceTrace(current, status.step));
        if (status.stores?.length) setLiveStores(status.stores);
        if (status.status === 'done') {
          if (!status.result) throw new Error('Search returned no result.');
          setResult(status.result);
          break;
        }

        await delay(POLL_INTERVAL_MS);
      }
    } catch (err) {
      if (isMounted.current) {
        const message = errorText(err, 'Search failed.');
        setError(message);
        setShowingPreviousResult(true);
        setTrace((current) => current && { ...current, error: message, failedAt: Date.now() });
      }
    } finally {
      liveFeed?.close();
      searchInFlight.current = false;
      if (isMounted.current) setSearching(false);
    }
  }

  // Cards from this search, as soon as a branch is on the map. Until the first
  // one lands, the previous shortlist stays up so the column is not blank.
  const shown: Result | null =
    searching && liveStores.length > 0
      ? {
          stores: liveStores,
          gas: { price: null, source_url: '', location: '', observed_date: '', notes: '' },
          location: '',
          demo: false,
          warnings: [],
          checked_at: new Date().toISOString(),
        }
      : result;

  // The panel shows the whole feed, so the inline list is only for when it is closed.
  const inlineFeed =
    panelOpen || !trace ? [] : trace.events.slice(-FEED_LINES).map((event) => event.message);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', lg: 'row' },
        alignItems: { lg: 'flex-start' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <SiteHeader panelOpen={panelOpen} onTogglePanel={togglePanel} />
        <Container sx={{ py: { xs: 4, md: 6 }, maxWidth: 'lg' }}>
          <Hero />
          <Box sx={pageColumns}>
            <Stack sx={{ gap: 3 }}>
              <SearchPanel
                form={form}
                searching={searching}
                onChange={updateForm}
                onSubmit={onSubmit}
              />
              <PriceWatchPanel form={form} ready={watchReady} />
            </Stack>
            <Box aria-label="Search results" sx={{ minWidth: 0 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                sx={{
                  justifyContent: 'space-between',
                  alignItems: { xs: 'start', sm: 'center' },
                  gap: 2,
                  mb: 2,
                }}
              >
                <Box>
                  <Typography sx={smallLabel}>02 / THE SHORTLIST</Typography>
                  <Typography variant="h2" sx={{ fontSize: 25, mt: 1 }}>
                    A good deal goes the distance.
                  </Typography>
                </Box>
                <Chip size="small" variant="outlined" label={shortlistStatus(searching, result)} />
              </Stack>
              <Divider />
              {error && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {error}
                </Alert>
              )}
              {searching && <SearchProgress step={step} demo={form.demo} feed={inlineFeed} />}
              {shown ? (
                <Results
                  result={shown}
                  sortBy={sortBy}
                  showingPreviousResult={showingPreviousResult && !searching}
                  partial={searching && liveStores.length > 0}
                  onSortByChange={setSortBy}
                />
              ) : (
                !searching && <EmptyState />
              )}
            </Box>
          </Box>
          <SiteFooter />
        </Container>
      </Box>
      {panelOpen && <BehindTheScenes trace={trace} running={searching} namespace={namespace} />}
    </Box>
  );
}
