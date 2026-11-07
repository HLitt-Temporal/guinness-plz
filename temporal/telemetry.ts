/*
  Sends traces, logs, and metrics to Grafana over OTLP: traces to Tempo, logs
  to Loki, metrics to Mimir. OTEL_EXPORTER_OTLP_ENDPOINT and
  OTEL_EXPORTER_OTLP_HEADERS come from the stack's OpenTelemetry page in
  Grafana Cloud. Without an endpoint nothing is exported, and agent tracing
  stays off.

  What a beer run produces:
  - Traces. A span per API request, then Temporal's spans for the workflow
    start, the workflow, and each activity, and a span per research model
    call with its web searches as events. Each agent run is a trace of its
    own, with a span per turn, tool call, and model call that carries the
    prompt, the tool arguments and results, the model output, and token
    counts. Agent spans have the same temporalWorkflowId attribute as
    Temporal's spans, so one TraceQL query finds both.
  - Logs. Worker, workflow, and activity logs from the Temporal runtime,
    including every live-feed message, and one record per model call and
    tool call with the whole payload. Long span attributes are cut at
    ATTRIBUTE_CHARS. The log record keeps the rest, linked to its span.
  - Metrics. The Temporal SDK's worker metrics, the workflows' counters,
    and token, request, and latency figures for every model call, all
    through the Temporal runtime's own OTLP exporter.

  startTelemetry has to run before the first Temporal connection, because
  Runtime.install only works before the runtime is first used.
*/

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import type { Attributes, AttributeValue, Span } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { LogAttributes, Logger as OtelLogger } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type {
  BasicTracerProvider,
  ReadableSpan,
  Span as SdkSpan,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { SpanData, Trace, TracingProcessor } from '@openai/agents-core';
import type { ClientOptions } from '@temporalio/client';
import type { MetricCounter, MetricHistogram } from '@temporalio/common';
import { OpenTelemetryPlugin } from '@temporalio/interceptors-opentelemetry';
import { OpenAIAgentsTraceClientInterceptor } from '@temporalio/openai-agents';
import type { OpenAIAgentsPluginInterceptorOptions } from '@temporalio/openai-agents';
import { createTracerProvider } from '@temporalio/openai-agents/otel';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import type { LogEntry, LogLevel, LogMetadata } from '@temporalio/worker';
import { agentsCore } from './agents-sdk.ts';

type AgentSpan = Parameters<TracingProcessor['onSpanEnd']>[0];

const SERVICE = 'guinness-plz';
// The OpenAI Agents plugin starts its spans on this tracer.
const AGENT_TRACER = '@temporalio/openai-agents';
// Long values on spans are cut here. The log record next to the span keeps them.
const ATTRIBUTE_CHARS = 8_000;
// Loki rejects a line over 256 KB.
const LOG_CHARS = 200_000;
// addTemporalSpans puts each model and tool activity inside the agent's trace too.
const AGENT_TRACING: OpenAIAgentsPluginInterceptorOptions = {
  useOtelInstrumentation: true,
  addTemporalSpans: true,
};

const SEVERITY: Record<LogLevel, SeverityNumber> = {
  TRACE: SeverityNumber.TRACE,
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

interface Meters {
  modelCalls: MetricCounter;
  modelTokens: MetricCounter;
  modelDuration: MetricHistogram;
  webSearches: MetricCounter;
  toolCalls: MetricCounter;
  agentTurns: MetricCounter;
  agentRuns: MetricCounter;
}

interface Telemetry {
  plugin: OpenTelemetryPlugin;
  tracerProvider: BasicTracerProvider;
  loggerProvider: LoggerProvider;
  logger: OtelLogger;
  meters: Meters;
}

let active: Telemetry | null = null;

// The parts of a Responses API reply that telemetry reads. Research calls and
// agent model calls both get one back.
export interface ModelResponse {
  id?: string;
  model?: string;
  status?: string;
  instructions?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  output?: {
    type?: string;
    action?: { type?: string; query?: string; url?: string; sources?: { url: string }[] };
    content?: { type: string; text?: string }[];
  }[];
}

export interface ModelRequest {
  model: string;
  instructions?: string;
  input: unknown;
  [key: string]: unknown;
}

// Log metadata can hold anything, such as the worker's options with its
// plugins, so cycles, bigints, and errors all have to come out as text.
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Error) return item.stack ?? item.message;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) ?? ''
  );
}

function clip(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)} [${value.length - limit} more chars]`
    : value;
}

// OpenTelemetry warns on a null or undefined attribute, so those are left out.
function compact(attributes: Record<string, AttributeValue | null | undefined>): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value != null) kept[key] = value;
  }
  return kept;
}

function otlpHeaders() {
  const headers: Record<string, string> = {};
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const split = pair.indexOf('=');
    if (split <= 0) continue;
    headers[decodeURIComponent(pair.slice(0, split).trim())] = decodeURIComponent(
      pair.slice(split + 1).trim(),
    );
  }
  return headers;
}

function appVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function tracer() {
  return trace.getTracer(SERVICE);
}

// role names the process in Grafana: the HTTP server, which also runs a
// worker, or a worker started on its own.
export function startTelemetry(role: 'server' | 'worker') {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '');
  if (active || !endpoint) return;
  const headers = otlpHeaders();
  process.env.OTEL_SERVICE_NAME ||= SERVICE;

  // Export failures, such as a wrong token, show up in the console.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const resource = Resource.default().merge(
    new Resource({
      'service.name': process.env.OTEL_SERVICE_NAME,
      'service.version': appVersion(),
      'service.instance.id': `${hostname()}:${process.pid}`,
      'deployment.environment.name': process.argv.includes('--dev') ? 'development' : 'production',
      'guinness.process': role,
    }),
  );

  const spans = new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    { maxQueueSize: 8192 },
  );
  const openAgentSpans = new OpenAgentSpans();
  const tracerProvider = createTracerProvider({
    resource,
    spanProcessors: [openAgentSpans, spans],
    spanLimits: { attributeValueLengthLimit: ATTRIBUTE_CHARS },
  });
  tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager().enable() });

  const loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }), {
      maxQueueSize: 8192,
    }),
  );
  const logger = loggerProvider.getLogger(SERVICE);

  // DEBUG goes to Loki, which includes the SDK's activity and workflow task
  // records. The console keeps printing INFO and up, as it did before.
  const consoleLogger = new DefaultLogger('INFO');
  const runtime = Runtime.install({
    logger: new DefaultLogger('DEBUG', (entry) => {
      consoleLogger.log(entry.level, entry.message, entry.meta);
      // This runs inside the runtime's log timer. A throw here ends the process.
      try {
        forwardLog(logger, entry);
      } catch (error) {
        diag.warn('A Temporal log record could not be sent.', error);
      }
    }),
    telemetryOptions: {
      logging: { filter: { core: 'WARN', other: 'ERROR' }, forward: {} },
      metrics: {
        otel: { url: `${endpoint}/v1/metrics`, http: true, headers, metricsExportInterval: '15s' },
      },
    },
  });

  const meter = runtime.metricMeter;
  const meters: Meters = {
    modelCalls: meter.createCounter('guinness_model_calls', 'calls', 'OpenAI Responses API calls'),
    modelTokens: meter.createCounter('guinness_model_tokens', 'tokens', 'Tokens by type'),
    modelDuration: meter.createHistogram(
      'guinness_model_call_duration',
      'float',
      'ms',
      'Time for one Responses API call, including its web searches',
    ),
    webSearches: meter.createCounter('guinness_web_searches', 'searches', 'Hosted web searches'),
    toolCalls: meter.createCounter('guinness_agent_tool_calls', 'calls', 'Agent tool calls'),
    agentTurns: meter.createCounter('guinness_agent_turns', 'turns', 'Agent turns'),
    agentRuns: meter.createCounter('guinness_agent_runs', 'runs', 'Agent runs'),
  };

  // The Agents SDK's default processor prints spans to the console. This one
  // replaces it, and the OpenAI Agents plugin adds its own after it when the
  // worker is created, so this one sees each span before the plugin ends it.
  agentsCore.setTracingDisabled(false);
  agentsCore.setTraceProcessors([new AgentDetailProcessor(openAgentSpans, logger, meters)]);

  active = {
    plugin: new OpenTelemetryPlugin({ resource, spanProcessor: spans }),
    tracerProvider,
    loggerProvider,
    logger,
    meters,
  };
  console.log(`Sending traces, logs, and metrics to ${endpoint}`);
}

export async function stopTelemetry() {
  if (!active) return;
  const { tracerProvider, loggerProvider } = active;
  active = null;
  await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
}

export function telemetryPlugins() {
  return active ? [active.plugin] : [];
}

// Workflows read the agent tracing settings from a header the client adds
// when it starts them, so the server's client needs this as well as the worker.
export function clientTelemetry(): Pick<ClientOptions, 'plugins' | 'interceptors'> {
  if (!active) return {};
  return {
    plugins: [active.plugin],
    interceptors: { workflow: [new OpenAIAgentsTraceClientInterceptor(AGENT_TRACING)] },
  };
}

export function agentTracing() {
  return active ? AGENT_TRACING : undefined;
}

function logAttributes(meta: LogMetadata | undefined): LogAttributes {
  const attributes: LogAttributes = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value == null) continue;
    attributes[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : clip(text(value), ATTRIBUTE_CHARS);
  }
  return attributes;
}

// Workflow logs arrive through a sink, outside any span, but Temporal's
// plugin puts the workflow span's ids in their metadata.
function logContext(meta: LogMetadata | undefined) {
  if (typeof meta?.trace_id !== 'string' || typeof meta.span_id !== 'string') return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: meta.trace_id,
    spanId: meta.span_id,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

function forwardLog(logger: OtelLogger, entry: LogEntry) {
  logger.emit({
    context: logContext(entry.meta),
    timestamp: [
      Number(entry.timestampNanos / 1_000_000_000n),
      Number(entry.timestampNanos % 1_000_000_000n),
    ],
    severityNumber: SEVERITY[entry.level],
    severityText: entry.level,
    body: entry.message,
    attributes: logAttributes(entry.meta),
  });
}

// route is the request's path with ids replaced, or null for a request not
// worth a span. The span ends when the response closes, so a live feed's
// span lasts as long as the page listened.
export async function traceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: string | null,
  handle: () => Promise<void>,
) {
  if (!active || !route) return handle();
  const span = tracer().startSpan(`${req.method} ${route}`, {
    kind: SpanKind.SERVER,
    attributes: compact({
      'http.request.method': req.method,
      'http.route': route,
      'url.path': req.url,
      'user_agent.original': req.headers['user-agent'],
    }),
  });
  res.once('close', () => {
    span.setAttribute('http.response.status_code', res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  try {
    await context.with(trace.setSpan(context.active(), span), handle);
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  }
}

function outputText(response: ModelResponse) {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) if (content.text) parts.push(content.text);
  }
  return parts.join('');
}

function responseAttributes(response: ModelResponse): Attributes {
  const usage = response.usage ?? {};
  return compact({
    'gen_ai.response.id': response.id,
    'gen_ai.response.model': response.model,
    'gen_ai.response.finish_reasons': response.status ? [response.status] : undefined,
    'gen_ai.usage.input_tokens': usage.input_tokens,
    'gen_ai.usage.output_tokens': usage.output_tokens,
    'gen_ai.usage.cache_read.input_tokens': usage.input_tokens_details?.cached_tokens,
    'gen_ai.usage.reasoning.output_tokens': usage.output_tokens_details?.reasoning_tokens,
    'gen_ai.system_instructions':
      response.instructions == null ? undefined : text(response.instructions),
    'gen_ai.output.messages': outputText(response) || text(response.output ?? []),
    'openai.web_search.calls': webSearchCalls(response).length,
  });
}

function webSearchCalls(response: ModelResponse) {
  return (response.output ?? []).filter((item) => item.type === 'web_search_call');
}

// One event per hosted web search: what the model searched for or opened,
// and the pages the search returned.
function addWebSearchEvents(span: Span, response: ModelResponse) {
  for (const call of webSearchCalls(response)) {
    span.addEvent(
      'web_search',
      compact({
        'openai.web_search.action': call.action?.type,
        'openai.web_search.query': call.action?.query,
        'openai.web_search.url': call.action?.url,
        'openai.web_search.sources': call.action?.sources?.map((source) => source.url).join('\n'),
      }),
    );
  }
}

function recordModelCall(
  meters: Meters,
  source: 'research' | 'agents',
  model: string,
  response: ModelResponse | null,
  milliseconds: number,
  outcome: string,
) {
  const tags = { source, model };
  meters.modelCalls.add(1, { ...tags, outcome });
  meters.modelDuration.record(milliseconds, tags);
  if (!response) return;
  const usage = response.usage ?? {};
  const tokens: [string, number | undefined][] = [
    ['input', usage.input_tokens],
    ['output', usage.output_tokens],
    ['cached_input', usage.input_tokens_details?.cached_tokens],
    ['reasoning', usage.output_tokens_details?.reasoning_tokens],
  ];
  for (const [type, count] of tokens) {
    if (count) meters.modelTokens.add(count, { ...tags, token_type: type });
  }
  const searches = webSearchCalls(response).length;
  if (searches) meters.webSearches.add(searches, tags);
}

function emitPayload(
  logger: OtelLogger,
  span: Span,
  event: string,
  payload: unknown,
  failed: boolean,
  attributes: Attributes = {},
) {
  logger.emit({
    severityNumber: failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: failed ? 'ERROR' : 'INFO',
    body: clip(text(payload), LOG_CHARS),
    attributes: { 'event.name': event, ...attributes } as LogAttributes,
    context: trace.setSpan(context.active(), span),
  });
}

// A research call to the Responses API, made outside the Agents SDK. The span
// is a child of the activity that made the call.
export async function traceModelCall<T extends ModelResponse>(
  task: string,
  request: ModelRequest,
  call: () => Promise<T>,
): Promise<T> {
  if (!active) return call();
  const { logger, meters } = active;
  const attributes = compact({
    'gen_ai.operation.name': 'chat',
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': request.model,
    'gen_ai.system_instructions': request.instructions,
    'gen_ai.input.messages': text(request.input),
    'guinness.research.task': task,
  });
  return tracer().startActiveSpan(
    `chat ${request.model}`,
    { kind: SpanKind.CLIENT, attributes },
    async (span) => {
      const started = performance.now();
      let response: T | undefined;
      let failure: unknown;
      try {
        response = await call();
        span.setAttributes(responseAttributes(response));
        addWebSearchEvents(span, response);
        if (response.status !== 'completed') span.setStatus({ code: SpanStatusCode.ERROR });
        return response;
      } catch (error) {
        failure = error;
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        const outcome = response?.status ?? 'error';
        recordModelCall(
          meters,
          'research',
          response?.model ?? request.model,
          response ?? null,
          performance.now() - started,
          outcome,
        );
        emitPayload(
          logger,
          span,
          'guinness.research.call',
          { task, request, response, error: failure == null ? undefined : text(failure) },
          outcome !== 'completed',
          { 'guinness.research.task': task },
        );
        span.end();
      }
    },
  );
}

// The plugin turns ids from the Agents SDK into OpenTelemetry ids this way.
// These must match it, or the details land on no span.
function otelTraceId(agentTraceId: string) {
  const hex = agentTraceId.startsWith('trace_')
    ? agentTraceId.slice(6)
    : agentTraceId.replace(/-/g, '');
  return hex.padStart(32, '0').slice(0, 32).toLowerCase();
}

function otelSpanId(agentSpanId: string) {
  const hex = agentSpanId.startsWith('span_')
    ? agentSpanId.slice(5)
    : agentSpanId.replace(/-/g, '');
  return hex.padStart(16, '0').slice(0, 16).toLowerCase();
}

// Agent spans the plugin has started and not yet ended. AgentDetailProcessor
// adds to them before the plugin ends them.
class OpenAgentSpans implements SpanProcessor {
  readonly spans = new Map<string, SdkSpan>();

  onStart(span: SdkSpan) {
    if (span.instrumentationLibrary.name === AGENT_TRACER) {
      this.spans.set(span.spanContext().spanId, span);
    }
  }

  onEnd(span: ReadableSpan) {
    this.spans.delete(span.spanContext().spanId);
  }

  async forceFlush() {}

  async shutdown() {
    this.spans.clear();
  }
}

function traceAttributes(agentTrace: Trace): Attributes {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(agentTrace.metadata ?? {})) metadata[key] = text(value);
  return compact({
    'openai.agents.trace.name': agentTrace.name,
    'openai.agents.trace.group_id': agentTrace.groupId,
    ...metadata,
  });
}

function usageAttributes(
  usage:
    { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined,
) {
  return {
    'gen_ai.usage.input_tokens': usage?.input_tokens,
    'gen_ai.usage.output_tokens': usage?.output_tokens,
    'gen_ai.usage.cache_read.input_tokens': usage?.cached_input_tokens,
  };
}

function spanAttributes(data: SpanData): Attributes {
  switch (data.type) {
    case 'agent':
      return compact({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': data.name,
        'openai.agents.agent.tools': data.tools?.join(','),
        'openai.agents.agent.output_type': data.output_type,
      });
    case 'task':
      return compact({
        'openai.agents.task.name': data.name,
        'openai.agents.usage.requests': data.usage?.requests,
        ...usageAttributes(data.usage),
      });
    case 'turn':
      return compact({
        'gen_ai.agent.name': data.agent_name,
        'openai.agents.turn': data.turn,
        ...usageAttributes(data.usage),
      });
    case 'function':
      return compact({
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': data.name,
        'gen_ai.tool.type': 'function',
        'gen_ai.tool.call.arguments': data.input,
        'gen_ai.tool.call.result': data.output,
        'openai.agents.function.mcp_data': data.mcp_data,
      });
    case 'generation':
      return compact({
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': data.model,
        'openai.agents.model_config': data.model_config && text(data.model_config),
        'gen_ai.input.messages': data.input && text(data.input),
        'gen_ai.output.messages': data.output && text(data.output),
        'gen_ai.usage.input_tokens': data.usage?.input_tokens,
        'gen_ai.usage.output_tokens': data.usage?.output_tokens,
      });
    case 'response':
      return {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        ...compact({ 'gen_ai.input.messages': data._input && text(data._input) }),
        ...(data._response ? responseAttributes(data._response as ModelResponse) : {}),
      };
    default:
      return { 'openai.agents.span_data': text(data) };
  }
}

// The whole span data for the log record. The response span's fields are
// underscored in the SDK, because its own exporter leaves them out.
function spanPayload(data: SpanData) {
  if (data.type !== 'response') return data;
  return {
    type: data.type,
    response_id: data.response_id,
    input: data._input,
    response: data._response,
  };
}

const LOGGED_SPANS = new Set(['function', 'generation', 'response', 'handoff', 'guardrail']);

function spanMilliseconds(span: AgentSpan) {
  if (!span.startedAt || !span.endedAt) return 0;
  return Date.parse(span.endedAt) - Date.parse(span.startedAt);
}

// Sees each Agents SDK span before the plugin's processor ends the matching
// OpenTelemetry span, and adds what the plugin leaves out: prompts, tool
// arguments and results, model output, and token counts.
class AgentDetailProcessor implements TracingProcessor {
  #open: OpenAgentSpans;
  #logger: OtelLogger;
  #meters: Meters;
  #traces = new Map<string, Attributes>();

  constructor(open: OpenAgentSpans, logger: OtelLogger, meters: Meters) {
    this.#open = open;
    this.#logger = logger;
    this.#meters = meters;
  }

  async onTraceStart(agentTrace: Trace) {
    this.#traces.set(agentTrace.traceId, traceAttributes(agentTrace));
  }

  async onTraceEnd(agentTrace: Trace) {
    const root = this.#open.spans.get(otelTraceId(agentTrace.traceId).slice(0, 16));
    root?.setAttributes(traceAttributes(agentTrace));
    this.#traces.delete(agentTrace.traceId);
  }

  async onSpanStart() {}

  async onSpanEnd(span: AgentSpan) {
    const data = span.spanData;
    this.#count(span);
    const otelSpan = this.#open.spans.get(otelSpanId(span.spanId));
    if (!otelSpan) return;
    const traceAttributes = this.#traces.get(span.traceId) ?? {};
    otelSpan.setAttributes({ ...traceAttributes, ...spanAttributes(data) });
    if (span.error) otelSpan.setAttribute('openai.agents.error', text(span.error));
    if (data.type === 'response' && data._response) {
      addWebSearchEvents(otelSpan, data._response as ModelResponse);
    }
    if (LOGGED_SPANS.has(data.type) || span.error) {
      emitPayload(
        this.#logger,
        otelSpan,
        `openai.agents.${data.type}`,
        { ...spanPayload(data), error: span.error ?? undefined },
        span.error != null,
        compact({
          ...traceAttributes,
          'gen_ai.tool.name': data.type === 'function' ? data.name : undefined,
        }),
      );
    }
  }

  #count(span: AgentSpan) {
    const data = span.spanData;
    const outcome = span.error ? 'error' : 'ok';
    if (data.type === 'response') {
      const response = (data._response ?? null) as ModelResponse | null;
      recordModelCall(
        this.#meters,
        'agents',
        response?.model ?? 'unknown',
        response,
        spanMilliseconds(span),
        span.error ? 'error' : (response?.status ?? 'unknown'),
      );
    } else if (data.type === 'function') {
      this.#meters.toolCalls.add(1, { tool: data.name, outcome });
    } else if (data.type === 'turn') {
      this.#meters.agentTurns.add(1, { agent: data.agent_name });
    } else if (data.type === 'agent') {
      this.#meters.agentRuns.add(1, { agent: data.name, outcome });
    }
  }

  async shutdown() {}

  async forceFlush() {}
}
