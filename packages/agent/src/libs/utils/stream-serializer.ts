/**
 * Streaming event serialization for Strands Agents.
 *
 * SDK 1.x event-shape changes (vs. SDK 0.1.x)
 * -------------------------------------------
 * 1. The agent stream wraps every model-provider delta inside a single
 *    `ModelStreamUpdateEvent` whose `.event` field is the legacy
 *    `ModelStreamEvent` discriminated union (`modelContentBlockDeltaEvent`,
 *    `modelContentBlockStartEvent`, `modelContentBlockStopEvent`,
 *    `modelMessageStartEvent`, `modelMessageStopEvent`, `modelMetadataEvent`,
 *    `modelRedactionEvent`).
 *
 *    To keep the wire protocol — and therefore the frontend handler —
 *    stable, we **unwrap** `modelStreamUpdateEvent` here and forward the
 *    inner event as if it had been emitted directly by the SDK 0.1.x
 *    agent loop. The frontend's existing switch statement
 *    (`api/agent.ts`) keeps working unchanged.
 *
 * 2. SDK 1.x `ContentBlock` classes (`TextBlock`, `ToolUseBlock`,
 *    `ToolResultBlock`, `ImageBlock`) define a `toJSON()` that emits the
 *    Bedrock Converse native shape (`{ toolUse: {...} }`,
 *    `{ toolResult: {...} }`, `{ text: ... }`, `{ image: {...} }`) and
 *    **drops the `type` discriminator**. Anywhere a Strands `ContentBlock`
 *    instance is forwarded directly to `JSON.stringify(...)` (`res.write`
 *    in `stream-handler.ts`), the frontend's `switch (block.type)`
 *    silently breaks — tool results don't render until the page reloads.
 *
 *    For events that carry `Message.content` arrays or `ContentBlock`
 *    instances (`messageAddedEvent`, `afterToolsEvent`, `toolResultEvent`,
 *    `contentBlockEvent`), we therefore route the content through
 *    {@link contentBlockToWire} from the agent's content-block codec.
 *    This mirrors the AgentCore-Memory persistence path so both wire
 *    surfaces — streaming NDJSON and Memory blobs — share a single,
 *    type-safe ContentBlock serialiser.
 *
 * Other newly added wrapper events (`agentResultEvent`,
 * `toolStreamUpdateEvent`, `beforeToolCallEvent`, `afterToolCallEvent`,
 * `interruptEvent`) are emitted with a minimal serialization so they no
 * longer trigger the "New unknown streaming event" warning, but the
 * frontend currently treats them as no-ops via its default case.
 */

import type { ContentBlock } from '@strands-agents/sdk';

import { contentBlockToWire } from '../codec/content-block-codec.js';
import type { WireContentBlock } from '../codec/content-block-codec.types.js';
import { logger } from '../logger/index.js';

/**
 * Coerce an array of raw stream-event content blocks into wire shape.
 *
 * The runtime values may be either:
 *   - SDK 1.x `ContentBlock` class instances (the common case for
 *     in-process events emitted by the agent), or
 *   - already-plain `MessageData`-shaped objects (when the same event was
 *     reconstructed from session history).
 *
 * `contentBlockToWire` accepts the class form via its switch on
 * `block.type` — and SDK plain `MessageData` blocks also carry that
 * field — so we forward both. Items that don't expose a recognised
 * `type` (e.g. bug-window blobs from old persisted history) fall through
 * untouched; the frontend simply ignores them.
 */
function contentToWire(content: unknown): WireContentBlock[] | unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    const candidate = block as { type?: string };
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.type === 'string' &&
      isKnownContentBlockType(candidate.type)
    ) {
      try {
        return contentBlockToWire(block as ContentBlock);
      } catch (error) {
        logger.warn(
          { type: candidate.type, err: error },
          'contentBlockToWire failed inside stream serializer; emitting block untouched'
        );
        return block;
      }
    }
    return block;
  });
}

/**
 * Mirror of the discriminator literals on the SDK's `ContentBlock`
 * union. Kept loose-typed (string set) so the helper above can guard
 * against unknown / corrupted entries without dragging the codec's
 * compile-time exhaustiveness check into this hot path.
 */
const KNOWN_CONTENT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'textBlock',
  'toolUseBlock',
  'toolResultBlock',
  'reasoningBlock',
  'cachePointBlock',
  'guardContentBlock',
  'imageBlock',
  'videoBlock',
  'documentBlock',
  'citationsBlock',
]);

function isKnownContentBlockType(type: string): boolean {
  return KNOWN_CONTENT_BLOCK_TYPES.has(type);
}

/**
 * Normalise a `modelContentBlockDeltaEvent.delta` for the wire.
 *
 * A `reasoningContentDelta` may carry `redactedContent` as a `Uint8Array`
 * (encrypted thinking). Forwarding it verbatim through `JSON.stringify` would
 * corrupt it into `{"0":..}`. We base64-encode it under `redactedContentBase64`
 * (and drop the raw field) so the frontend — which never displays redacted
 * content anyway — receives a stable, non-garbled shape. `text`/`signature`
 * pass through untouched. All other delta types are forwarded unchanged.
 */
function normalizeDelta(delta: unknown): unknown {
  if (!delta || typeof delta !== 'object') return delta;
  const d = delta as { type?: string; redactedContent?: unknown; [k: string]: unknown };
  if (d.type !== 'reasoningContentDelta' || d.redactedContent == null) {
    return delta;
  }
  const { redactedContent, ...rest } = d;
  const bytes = redactedContent as Uint8Array;
  return {
    ...rest,
    ...(bytes.length > 0
      ? { redactedContentBase64: Buffer.from(bytes).toString('base64') }
      : {}),
  };
}

/**
 * Project a Strands `Message`-shaped object onto the wire by normalising
 * each content block. Returns `undefined` when input is falsy so callers
 * can pass through `eventObj.message` without a guard.
 */
function messageToWire(message: unknown):
  | {
      role: unknown;
      content: WireContentBlock[] | unknown;
    }
  | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { role: unknown; content: unknown };
  return {
    role: m.role,
    content: contentToWire(m.content),
  };
}

/**
 * Safely serialize Strands Agents streaming events.
 *
 * Returns an array because `modelStreamUpdateEvent` may unwrap into a
 * single inner event. Callers should iterate the returned array and
 * write each item as its own NDJSON line so the wire ordering matches
 * the agent loop's emission order.
 */
export function serializeStreamEvent(event: unknown): object[] {
  const eventObj = event as { type?: string; [key: string]: unknown };
  const baseEvent = { type: eventObj.type };

  switch (eventObj.type) {
    // ---------------------------------------------------------------------
    // SDK 1.x wrapper for streaming model deltas — unwrap to legacy shape
    // so the frontend can keep handling `modelContentBlockDeltaEvent` etc.
    // directly. The inner Data objects are plain (no agent reference) so
    // they are safe to forward.
    // ---------------------------------------------------------------------
    case 'modelStreamUpdateEvent': {
      const inner = eventObj.event as { type?: string; [key: string]: unknown } | undefined;
      if (!inner) {
        return [baseEvent];
      }
      // Recurse to apply the same legacy serialization rules to the
      // unwrapped inner event. This keeps `modelMetadataEvent` cache-metric
      // logging working in particular.
      return serializeStreamEvent(inner);
    }

    // Text generation events (legacy SDK 0.1.x types — still emitted today
    // either directly by `messageAddedEvent` or via the unwrap above).
    case 'modelContentBlockDeltaEvent':
      return [
        {
          ...baseEvent,
          delta: normalizeDelta(eventObj.delta),
        },
      ];

    case 'modelContentBlockStartEvent':
      return [
        {
          ...baseEvent,
          start: eventObj.start,
        },
      ];

    case 'modelContentBlockStopEvent':
      return [
        {
          ...baseEvent,
          stop: eventObj.stop,
        },
      ];

    // Message lifecycle events
    case 'modelMessageStartEvent':
    case 'modelMessageStopEvent':
      return [
        {
          ...baseEvent,
          message: messageToWire(eventObj.message),
        },
      ];

    case 'messageAddedEvent':
      // Critical: `event.message.content` carries SDK ContentBlock class
      // instances. Without `contentBlockToWire` each `ToolResultBlock` etc.
      // would be JSON.stringified through SDK toJSON() (drops `type`) and
      // the frontend's `block.type === 'toolResultBlock'` check would
      // silently fail — tool results would not appear in the chat pane
      // until reload.
      return [
        {
          ...baseEvent,
          message: messageToWire(eventObj.message),
        },
      ];

    // Metadata and result events
    case 'modelMetadataEvent': {
      // Log cache metrics
      if (eventObj.usage) {
        const usage = eventObj.usage as {
          inputTokens?: number;
          outputTokens?: number;
          cacheWriteInputTokens?: number;
          cacheReadInputTokens?: number;
        };

        if (usage.cacheWriteInputTokens || usage.cacheReadInputTokens) {
          logger.info(
            {
              cacheWriteInputTokens: usage.cacheWriteInputTokens || 0,
              cacheReadInputTokens: usage.cacheReadInputTokens || 0,
              inputTokens: usage.inputTokens || 0,
              outputTokens: usage.outputTokens || 0,
            },
            'Cache metrics'
          );
        }
      }
      return [
        {
          ...baseEvent,
          usage: eventObj.usage,
        },
      ];
    }

    // Legacy SDK 0.1.x agent result event (no longer emitted by SDK 1.x;
    // kept for backwards compat with any cached fixtures).
    case 'agentResult':
      return [
        {
          ...baseEvent,
          result: eventObj.result,
        },
      ];

    // SDK 1.x — emitted once at the very end of the loop. The server-side
    // `serverCompletionEvent` already carries the conversation length /
    // metadata the frontend relies on, so we forward only the type.
    case 'agentResultEvent':
      return [baseEvent];

    // SDK 1.x — fully assembled content block (TextBlock / ToolUseBlock /
    // ReasoningBlock). Normalise via the codec so the `type` discriminator
    // is preserved on the wire.
    case 'contentBlockEvent':
      return [
        {
          ...baseEvent,
          contentBlock: (() => {
            const cb = eventObj.contentBlock as { type?: string } | undefined;
            if (cb && typeof cb === 'object' && typeof cb.type === 'string') {
              try {
                return contentBlockToWire(cb as ContentBlock);
              } catch {
                return cb;
              }
            }
            return cb;
          })(),
        },
      ];

    // SDK 1.x — full assistant message after model streaming finishes.
    // Functionally redundant with `messageAddedEvent` for the frontend,
    // but normalise message content the same way so any consumer that
    // reads `message.content` sees a stable wire shape.
    case 'modelMessageEvent':
      return [
        {
          ...baseEvent,
          message: messageToWire(eventObj.message),
          stopReason: eventObj.stopReason,
        },
      ];

    // SDK 1.x — incremental tool execution stream.
    case 'toolStreamUpdateEvent':
      return [
        {
          ...baseEvent,
          event: eventObj.event,
        },
      ];

    // SDK 1.x — single tool result. `result` is a `ToolResultBlock`
    // class instance; route it through the codec so the frontend sees
    // `block.type === 'toolResultBlock'` even before `messageAddedEvent`
    // fires.
    case 'toolResultEvent':
      return [
        {
          ...baseEvent,
          result: (() => {
            const r = eventObj.result as { type?: string } | undefined;
            if (r && typeof r === 'object' && typeof r.type === 'string') {
              try {
                return contentBlockToWire(r as ContentBlock);
              } catch {
                return r;
              }
            }
            return r;
          })(),
        },
      ];

    // Text block events
    case 'textBlock':
      return [
        {
          ...baseEvent,
          text: eventObj.text,
        },
      ];

    // Stream hook events (lightweight due to frequent occurrence)
    case 'modelStreamEventHook':
      return [
        {
          ...baseEvent,
          // Hook information generally unnecessary, only type
        },
      ];

    // Lifecycle events with no payload of interest to the frontend
    case 'beforeInvocationEvent':
    case 'afterInvocationEvent':
    case 'beforeModelCallEvent':
    case 'beforeToolCallEvent':
    case 'afterToolCallEvent':
    case 'initializedEvent':
    case 'interruptEvent':
      return [baseEvent];

    case 'beforeToolsEvent':
      return [
        {
          ...baseEvent,
          message: messageToWire(eventObj.message),
        },
      ];

    case 'afterToolsEvent':
      // SDK 1.x exposes the tool result content via `event.message.content`
      // (a `Message`-shaped object). Forward it through the codec so the
      // frontend's existing block-level inspection in `api/agent.ts` —
      // which expects `type: 'toolResultBlock'` — keeps working in
      // streaming mode.
      return [
        {
          ...baseEvent,
          message: messageToWire(eventObj.message),
        },
      ];

    case 'afterModelCallEvent':
      return [
        {
          ...baseEvent,
          stopReason: eventObj.stopReason,
          stopData: eventObj.stopData
            ? {
                message: (eventObj.stopData as { message: unknown }).message,
              }
            : undefined,
        },
      ];

    default:
      // Show warning only for truly unknown event types
      logger.warn({ type: eventObj.type }, 'New unknown streaming event:');
      return [baseEvent];
  }
}
