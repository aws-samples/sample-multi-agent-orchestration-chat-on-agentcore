/**
 * Workaround SpanProcessor that adapts Strands TS SDK 1.x agent spans to
 * the shape AgentCore Observability expects. Two adaptations are applied,
 * both targeting the `invoke_agent` span only:
 *
 * 1. **Span kind (`onStart`)** — AgentCore Observability's trace-level token
 *    aggregator (`aws/spans` Logs Insights) sums
 *    `attributes.gen_ai.usage.total_tokens` over spans where `kind = "CLIENT"`.
 *    The Strands Python SDK emits `invoke_agent` as `SpanKind.CLIENT`, but
 *    the TypeScript SDK 1.2.0 emits everything as `SpanKind.INTERNAL` (see
 *    `node_modules/@strands-agents/sdk/dist/src/telemetry/tracer.js` lines
 *    204, 267, 332, 422, 474). We promote INTERNAL → CLIENT only on
 *    `invoke_agent` — promoting `chat` / `execute_event_loop_cycle` /
 *    `execute_tool` would double-count tokens, since those carry the same
 *    per-cycle accumulated usage that `endAgentSpan` writes onto
 *    `invoke_agent` (e.g. invoke_agent=6683 + chat=6683 → 13366).
 *
 * 2. **Input/output span attributes (`onEnd`)** — AgentCore Observability's
 *    trace list view's Input / Output columns are populated from the
 *    Gen AI Event log record that the ADOT JS distro's LLO handler emits
 *    when it sees `gen_ai.input.messages` / `gen_ai.output.messages` on a
 *    span (see
 *    `node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/
 *    build/src/llo-handler.js` `collectAllLloMessages` and
 *    `emitLloAttributes`, plus `otlp-aws-span-exporter.js` which runs
 *    `processSpans` before serialisation). The LLO handler wraps each
 *    attribute's *raw string value* as a single message's `content`
 *    (`{ role: "user", content: <attr value> }` for input;
 *    `{ role: "assistant", content: <attr value> }` for output) — it does
 *    **not** parse the latest-semconv array shape (the Python distro does;
 *    the JS distro does not). So writing a JSON-stringified
 *    `[{ role, parts }]` array would render as
 *    `{"messages":[{"content":"[{\"role\":\"assistant\",..."}]}` in the
 *    column, with our envelope nested inside the LLO handler's envelope.
 *
 *    The fix: project the per-message events Strands writes
 *    (`gen_ai.user.message` / `gen_ai.choice` in stable mode, or the
 *    `gen_ai.client.inference.operation.details` event in latest mode)
 *    down to **plain text strings** — the user prompt verbatim, the
 *    assistant response verbatim — and write those onto the LLO-handler-
 *    consumed attribute keys. The LLO handler then assembles the final
 *    `{ input: { messages: [{role, content}] }, output: {...} }` envelope
 *    correctly. We also write the legacy `gen_ai.input.prompt` /
 *    `gen_ai.output.text` keys with the same plain text as a belt-and-
 *    braces fallback for any consumer that still reads them.
 *
 * Why mutate `span.attributes` directly in `onEnd` rather than via a Strands
 * plugin/hook? `BeforeInvocationEvent` fires *before* `startAgentSpan`
 * (agent.js:636-666) so the span doesn't exist yet, and `AfterInvocationEvent`
 * fires *after* `endAgentSpan` (agent.js:862-873), where `setAttribute`
 * short-circuits on the ended span (Span.js:80). `onEnd` runs at exactly the
 * right moment — the span object is finalised but the BatchSpanProcessor has
 * only buffered a reference, so direct attribute-object mutation is picked
 * up when the OTLP exporter later serialises the span (and runs the LLO
 * handler over it).
 *
 * Remove this once the Strands TS SDK upstream emits CLIENT-kind agent spans
 * with `gen_ai.input.messages` / `gen_ai.output.messages` written as span
 * attributes (parity with the Python SDK + `aws-opentelemetry-distro`).
 */

import { SpanKind } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * `gen_ai.operation.name` value Strands TS SDK assigns to the top-level
 * agent span (matched span name: `invoke_agent <agent-name>`). Matching on
 * the attribute rather than the span name keeps the rule robust against
 * upstream renames of the agent name suffix.
 */
const STRANDS_AGENT_OPERATION = 'invoke_agent';

/**
 * Per-message events Strands TS SDK writes in **stable** semconv mode (the
 * default — `OTEL_SEMCONV_STABILITY_OPT_IN` is not set in this deployment).
 * The user-message event carries a JSON-stringified `content` attribute (an
 * array of Bedrock content blocks); the choice event carries a `message`
 * attribute that's already joined plain text from `_addResponseEvent`.
 */
const STRANDS_USER_MESSAGE_EVENT = 'gen_ai.user.message';
const STRANDS_CHOICE_EVENT = 'gen_ai.choice';

/**
 * Single combined event Strands TS SDK writes when **latest** semconv is
 * enabled. Its attributes carry `gen_ai.input.messages` /
 * `gen_ai.output.messages` as JSON-stringified latest-semconv arrays
 * (`[{ role, parts: [{ type: "text", content }] }]`). We decode those back
 * to plain text since the ADOT JS distro's LLO handler does not parse the
 * array shape.
 */
const STRANDS_LATEST_DETAILS_EVENT = 'gen_ai.client.inference.operation.details';

/**
 * Span-attribute keys the ADOT JS distro's LLO handler reads (and that
 * AgentCore Observability surfaces in the trace list view via the emitted
 * Gen AI Event log record).
 */
const ATTR_INPUT_MESSAGES = 'gen_ai.input.messages';
const ATTR_OUTPUT_MESSAGES = 'gen_ai.output.messages';
const ATTR_INPUT_PROMPT = 'gen_ai.input.prompt';
const ATTR_OUTPUT_TEXT = 'gen_ai.output.text';

export class StrandsSpanKindFixer implements SpanProcessor {
  /**
   * `onStart` runs before the span is exported and while the underlying
   * `SpanImpl.kind` field is still mutable (the API marks it `readonly`,
   * which is a compile-time-only constraint). Mutating here means the
   * downstream BatchSpanProcessor sees `CLIENT` when serialising.
   */
  onStart(span: Span, _parentContext: Context): void {
    if (span.kind !== SpanKind.INTERNAL) return;
    if (span.attributes['gen_ai.operation.name'] !== STRANDS_AGENT_OPERATION) return;
    (span as { kind: SpanKind }).kind = SpanKind.CLIENT;
  }

  /**
   * `onEnd` runs after `endAgentSpan` has finalised the span but before the
   * BatchSpanProcessor flushes its buffer to OTLP. Mutating the underlying
   * `attributes` object here is safe — `setAttribute` would short-circuit on
   * the already-ended span, but the object itself is still the one the OTLP
   * transformer (and the LLO handler) reads at export time.
   */
  onEnd(span: ReadableSpan): void {
    if (span.attributes['gen_ai.operation.name'] !== STRANDS_AGENT_OPERATION) return;

    // `ReadableSpan.attributes` is `Readonly` at the type level only; the
    // runtime object is the same one the OTLP transformer iterates. Cast
    // off the readonly modifier to write through it.
    const attrs = span.attributes as { [key: string]: unknown };

    const userText = extractInputText(span);
    if (userText !== undefined) {
      if (attrs[ATTR_INPUT_MESSAGES] === undefined) attrs[ATTR_INPUT_MESSAGES] = userText;
      if (attrs[ATTR_INPUT_PROMPT] === undefined) attrs[ATTR_INPUT_PROMPT] = userText;
    }

    const assistantText = extractOutputText(span);
    if (assistantText !== undefined) {
      if (attrs[ATTR_OUTPUT_MESSAGES] === undefined) attrs[ATTR_OUTPUT_MESSAGES] = assistantText;
      if (attrs[ATTR_OUTPUT_TEXT] === undefined) attrs[ATTR_OUTPUT_TEXT] = assistantText;
    }
  }

  async forceFlush(): Promise<void> {
    // No buffered state to flush.
  }

  async shutdown(): Promise<void> {
    // No buffered state to release.
  }
}

/**
 * Pull the user prompt as plain text from whichever event shape Strands
 * wrote. Stable mode: `gen_ai.user.message` event with a JSON-stringified
 * Bedrock content-block `content` attribute (decode + concatenate text
 * blocks). Latest mode: `gen_ai.client.inference.operation.details` event
 * with `gen_ai.input.messages` already in latest-semconv array shape
 * (decode + concatenate `parts[].content`).
 */
function extractInputText(span: ReadableSpan): string | undefined {
  const fromLatest = readEventAttributeNewestFirst(
    span,
    STRANDS_LATEST_DETAILS_EVENT,
    ATTR_INPUT_MESSAGES
  );
  const latestText = textFromLatestSemconvMessages(fromLatest);
  if (latestText !== undefined) return latestText;

  const userContentJson = readEventAttributeNewestFirst(
    span,
    STRANDS_USER_MESSAGE_EVENT,
    'content'
  );
  if (typeof userContentJson !== 'string') return undefined;
  return decodeContentBlocksToText(userContentJson);
}

/**
 * Pull the assistant response as plain text. Stable mode: `gen_ai.choice`
 * event's `message` attribute is already joined plain text (from
 * `_addResponseEvent`). Latest mode: `gen_ai.client.inference.operation.
 * details` event's `gen_ai.output.messages` is a latest-semconv array.
 */
function extractOutputText(span: ReadableSpan): string | undefined {
  const fromLatest = readEventAttributeNewestFirst(
    span,
    STRANDS_LATEST_DETAILS_EVENT,
    ATTR_OUTPUT_MESSAGES
  );
  const latestText = textFromLatestSemconvMessages(fromLatest);
  if (latestText !== undefined) return latestText;

  const choiceMessage = readEventAttributeNewestFirst(span, STRANDS_CHOICE_EVENT, 'message');
  if (typeof choiceMessage !== 'string' || choiceMessage.length === 0) return undefined;
  return choiceMessage;
}

/**
 * Walk events newest-first looking for one whose name matches; return the
 * named attribute's value from the first match.
 */
function readEventAttributeNewestFirst(
  span: ReadableSpan,
  eventName: string,
  attributeKey: string
): unknown {
  for (let i = span.events.length - 1; i >= 0; i--) {
    const event = span.events[i];
    if (event?.name !== eventName) continue;
    const value = event.attributes?.[attributeKey];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Strands stable-mode messages are stored as JSON-stringified Bedrock
 * content blocks (e.g. `[{ "type": "textBlock", "text": "…" }]`). Decode
 * and join the text blocks; fall back to the raw string if the payload
 * doesn't match (defensive — keeps the column populated even if Strands
 * changes the shape).
 */
function decodeContentBlocksToText(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!Array.isArray(parsed)) return json;
  const texts: string[] = [];
  for (const block of parsed) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'textBlock' && typeof b.text === 'string') texts.push(b.text);
  }
  if (texts.length === 0) return undefined;
  return texts.join('\n');
}

/**
 * Pull plain text out of a latest-semconv messages payload (a
 * JSON-stringified array of `{ role, parts: [{ type: "text", content }] }`).
 * Returns undefined if the value is missing, not a string, or doesn't parse
 * to that shape.
 */
function textFromLatestSemconvMessages(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const texts: string[] = [];
  for (const message of parsed) {
    if (!message || typeof message !== 'object') continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: unknown; content?: unknown };
      if (p.type === 'text' && typeof p.content === 'string') texts.push(p.content);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}
