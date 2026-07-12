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
 *    when it sees recognized LLO attribute keys on a span (see
 *    `node_modules/@aws/aws-distro-opentelemetry-node-autoinstrumentation/
 *    build/src/llo-handler.js` `LLO_PATTERNS`, `collectAllLloMessages`,
 *    and `emitLloAttributes`, plus `otlp-aws-span-exporter.js` which runs
 *    `processSpans` before serialisation). The LLO handler wraps each
 *    attribute's *raw string value* as a single message's `content`
 *    (`{ role: <patternRole>, content: <attr value> }`).
 *
 *    ADOT 0.10's LLO pattern registry recognizes `gen_ai.prompt` (user)
 *    and `gen_ai.completion` (assistant) as DIRECT patterns, but does NOT
 *    recognize `gen_ai.input.messages` / `gen_ai.output.messages` (those
 *    were added in a later release). Strands TS SDK 1.2.0 emits per-cycle
 *    events on the agent span (`gen_ai.user.message` + `gen_ai.choice` in
 *    stable mode, or `gen_ai.client.inference.operation.details` in
 *    latest mode) but does not write any of the LLO-handler-recognized
 *    span attributes itself, so the Input/Output columns render empty
 *    without intervention.
 *
 *    The fix: project the per-message events Strands writes down to
 *    **plain text strings** — the user prompt verbatim, the assistant
 *    response verbatim — and write those onto `gen_ai.prompt` /
 *    `gen_ai.completion` (the keys ADOT 0.10 actually picks up). The LLO
 *    handler then assembles the final
 *    `{ input: { messages: [{role: "user", content}] }, output: {...} }`
 *    envelope. We also write the latest-semconv keys
 *    (`gen_ai.input.messages` / `gen_ai.output.messages`) and the legacy
 *    `gen_ai.input.prompt` / `gen_ai.output.text` keys with the same
 *    plain text as forward-compatible fallbacks for ADOT versions that
 *    add them to the registry, and for any consumer that reads span
 *    attributes directly.
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
 * Attribute that positively identifies one of OUR agent spans (main or
 * sub-agent). Every agent we build goes through `createAgent`, which stamps
 * this marker UNCONDITIONALLY onto the `invoke_agent` span via
 * `traceAttributes` — unlike `enduser.id`, it does not depend on a resolved
 * userId, so a context-less invocation (e.g. a sub-agent whose task lost its
 * userId) still keeps CLIENT promotion and token aggregation.
 *
 * The GoalLoop judge Agent is constructed internally by the SDK with no id,
 * the default name, and NONE of our trace attributes — so its `invoke_agent`
 * span lacks this key. Both adaptations below are gated on its presence so the
 * judge span is left as INTERNAL and its tokens are NOT rolled into the
 * trace-level CLIENT aggregation (which would double-count the goal turn: host
 * agent + judge).
 */
const OUR_AGENT_MARKER_ATTR = 'moca.agent.managed';

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
 *
 * `gen_ai.prompt` / `gen_ai.completion` are the keys ADOT 0.10 picks up
 * (DIRECT patterns in `LLO_PATTERNS`, mapped to user/assistant roles).
 * `gen_ai.input.messages` / `gen_ai.output.messages` are the latest-
 * semconv keys (forward-compatible — picked up by newer ADOT releases).
 * `gen_ai.input.prompt` / `gen_ai.output.text` are legacy keys preserved
 * as a belt-and-braces fallback.
 */
const ATTR_PROMPT = 'gen_ai.prompt';
const ATTR_COMPLETION = 'gen_ai.completion';
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
    // Leave the GoalLoop judge's own invoke_agent span as INTERNAL so its tokens
    // are not summed into the trace-level CLIENT aggregation (double-counting the
    // goal turn). The judge span lacks our marker attribute; ours always has it.
    if (span.attributes[OUR_AGENT_MARKER_ATTR] === undefined) return;
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
    // Skip the GoalLoop judge span (see OUR_AGENT_MARKER_ATTR): the judge's
    // prompt/completion is internal grading, not user-facing I/O, so it should
    // not populate the trace list's Input/Output columns.
    if (span.attributes[OUR_AGENT_MARKER_ATTR] === undefined) return;

    // `ReadableSpan.attributes` is `Readonly` at the type level only; the
    // runtime object is the same one the OTLP transformer iterates. Cast
    // off the readonly modifier to write through it.
    const attrs = span.attributes as { [key: string]: unknown };

    const userText = extractInputText(span);
    if (userText !== undefined) {
      if (attrs[ATTR_PROMPT] === undefined) attrs[ATTR_PROMPT] = userText;
      if (attrs[ATTR_INPUT_MESSAGES] === undefined) attrs[ATTR_INPUT_MESSAGES] = userText;
      if (attrs[ATTR_INPUT_PROMPT] === undefined) attrs[ATTR_INPUT_PROMPT] = userText;
    }

    const assistantText = extractOutputText(span);
    if (assistantText !== undefined) {
      if (attrs[ATTR_COMPLETION] === undefined) attrs[ATTR_COMPLETION] = assistantText;
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
