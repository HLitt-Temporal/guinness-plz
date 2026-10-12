/*
  The page. It never calls OpenAI and never opens a map.

  Submitting the form POSTs the goal (address, radius, mpg, optional gas price,
  demo or live) to this app's server. The server answers immediately with a job
  id, because the agent work takes minutes. This component then polls that job
  once a second. Each poll includes a step number, which is the stepper:
  locate, research, routes, rank. Those numbers are written by liveSearch.

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
import type { Gas, Result, Store } from '../../workflow.ts';

// Labels for workflow steps 0–3. Step 4 means the job is finished; the stepper
// treats that as every step complete.
const SEARCH_STEPS = [
  'Locate address',
  'Research stores & gas',
  'Calculate driving routes',
  'Rank pickup costs',
];

// How often to ask the server "is the agent done yet?"
const POLL_INTERVAL_MS = 1000;

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
  error?: string;
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
    ['8-pack', formatMoney(store.price)],
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
            // The page the agent cited. Open it. The app checked that the URL
            // came back from search, not that the price on it is still right.
            <ExternalLink url={store.source_url}>View price source ↗</ExternalLink>
          )}
        </Stack>
        <Typography color="text.secondary" sx={{ fontSize: 12, mt: 1 }}>
          {store.product}
        </Typography>
        <Typography color="text.secondary" sx={{ fontSize: 11, mt: 1 }}>
          {confirmationLine(store)}
        </Typography>
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

function SiteHeader() {
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
        Your next 8-pack.
        <br />
        <Box component="em" color="primary.main">
          For a little less.
        </Box>
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 500 }}>
        Find Guinness nearby. Let the agents check the shelf price, the gas price, and what the trip
        will actually cost.
      </Typography>
      <Chip variant="outlined" label="Guinness Draught · 8 × 14.9 fl oz cans" sx={{ mt: 2 }} />
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

// Shown in place of the results while the job status is "running".
function SearchProgress({ step, demo }: { step: number; demo: boolean }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, mt: 3 }} aria-live="polite">
      <Stepper activeStep={step} orientation="vertical">
        {SEARCH_STEPS.map((label) => (
          <Step key={label}>
            <StepLabel>{label}</StepLabel>
          </Step>
        ))}
      </Stepper>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        {demo
          ? 'Calculating with fictional demo data.'
          : 'Researching public sources. Live searches can take a few minutes.'}
      </Typography>
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
  onSortByChange,
}: {
  result: Result;
  sortBy: SortBy;
  showingPreviousResult: boolean;
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
        {result.location} · Checked at {formatCheckedAt(result.checked_at)}
      </Typography>
      <GasPrice gas={result.gas} />
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
            No qualifying 8-pack offers found in this radius. Try a wider search.
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
        Enter your address to compare an 8-pack
        <br />
        with the cost of the round trip included.
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Shelf price + round-trip fuel = your pickup cost
      </Typography>
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
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [step, setStep] = useState(0);
  const [sortBy, setSortBy] = useState<SortBy>('total');
  const [showingPreviousResult, setShowingPreviousResult] = useState(false);
  const isMounted = useRef(true);
  // The poll loop is async. This blocks a second submit before React re-renders
  // searching=true, which is the gap where a double-click could start two jobs.
  const searchInFlight = useRef(false);

  function updateForm(patch: Partial<BeerRunForm>) {
    setForm((current) => ({ ...current, ...patch }));
  }

  useEffect(() => {
    isMounted.current = true;
    const controller = new AbortController();

    // Ask whether a key is configured. If not, leave the demo switch on so the
    // first click does not start a live search that cannot run.
    request<{ live_ready: boolean }>('/api/config', { signal: controller.signal })
      .then((config) => {
        if (!isMounted.current) return;
        updateForm({ demo: !config.live_ready });
      })
      .catch((err) => {
        if (controller.signal.aborted || !isMounted.current) return;
        setError(errorText(err, 'Could not connect to the server.'));
      });

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
    setStep(0);

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

      // Poll until the workflow finishes, the job errors, or this component
      // unmounts. The delay is between polls so we do not hammer the server
      // while the model is still searching.
      while (isMounted.current) {
        const status = await request<JobStatus>(`/api/jobs/${encodeURIComponent(job.id)}`);
        if (!isMounted.current) break;
        if (status.status === 'error') {
          throw new Error(status.error || 'Search could not complete.');
        }

        setStep(status.step);
        if (status.status === 'done') {
          if (!status.result) throw new Error('Search returned no result.');
          setResult(status.result);
          break;
        }

        await delay(POLL_INTERVAL_MS);
      }
    } catch (err) {
      if (isMounted.current) {
        setError(errorText(err, 'Search failed.'));
        setShowingPreviousResult(true);
      }
    } finally {
      searchInFlight.current = false;
      if (isMounted.current) setSearching(false);
    }
  }

  return (
    <>
      <SiteHeader />
      <Container sx={{ py: { xs: 4, md: 6 }, maxWidth: 'lg' }}>
        <Hero />
        <Box sx={pageColumns}>
          <SearchPanel
            form={form}
            searching={searching}
            onChange={updateForm}
            onSubmit={onSubmit}
          />
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
            {searching ? (
              <SearchProgress step={step} demo={form.demo} />
            ) : result ? (
              <Results
                result={result}
                sortBy={sortBy}
                showingPreviousResult={showingPreviousResult}
                onSortByChange={setSortBy}
              />
            ) : (
              <EmptyState />
            )}
          </Box>
        </Box>
        <SiteFooter />
      </Container>
    </>
  );
}
