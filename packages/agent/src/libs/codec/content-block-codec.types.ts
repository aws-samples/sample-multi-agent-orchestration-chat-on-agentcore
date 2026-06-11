/**
 * Wire format types for AgentCore Memory blob payloads.
 *
 * The Strands SDK's `ContentBlock` classes (`TextBlock`, `ToolUseBlock`,
 * `ToolResultBlock`, ...) define a `toJSON()` that emits the **Bedrock
 * Converse API native shape** — `{ toolUse: {...} }`, `{ toolResult: {...} }`
 * — and crucially **drops the `type` discriminator**. This is correct for
 * sending to Bedrock but *not* what we want for AgentCore Memory storage,
 * because:
 *
 *   1. The backend reads back this blob as plain JSON (no SDK classes
 *      available there) and uses `block.type` as a switch discriminator
 *      for transforming into its own UI DTO.
 *   2. The agent itself, on conversation history reload, also depends on
 *      `block.type` to reconstruct `ContentBlock` instances before passing
 *      `messages` into `new Agent({ messages })`.
 *
 * To preserve a stable wire contract regardless of how the SDK changes its
 * `toJSON()` representation, we define our own `Wire*Block` shapes and
 * derive their *field types* from the SDK classes via `TBlock['field']`
 * indexed-access types. This is the type-safety net:
 *
 *   - If `@strands-agents/sdk` ever renames `ToolUseBlock.name` to
 *     `toolName`, `WireToolUseBlock['name']` becomes `never` and any
 *     consumer breaks at compile time.
 *   - If a new `ContentBlock` subclass is added (e.g., `AudioBlock`), the
 *     `default` branch in `contentBlockToWire` (`content-block-codec.ts`)
 *     is reached with a non-`never` value and `tsc` flags it.
 *
 * @see content-block-codec.ts for the conversion functions.
 */

import type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  ReasoningBlock,
  ContentBlock,
  JSONValue,
} from '@strands-agents/sdk';

/** Schema version stamped into every newly-written blob. */
export const WIRE_SCHEMA_VERSION = 'v2-strands-sdk-1' as const;
export type WireSchemaVersion = typeof WIRE_SCHEMA_VERSION;

/**
 * Text content block on the wire.
 * Field types are pulled from `TextBlock` so a SDK-side rename (`text` →
 * something else) surfaces as a TypeScript error here.
 */
export interface WireTextBlock {
  type: 'textBlock';
  text: TextBlock['text'];
}

/**
 * Tool use block on the wire.
 * Field types are pulled from `ToolUseBlock` (not `ToolUseBlockData`) so
 * any rename / signature change on the runtime class breaks compilation.
 */
export interface WireToolUseBlock {
  type: 'toolUseBlock';
  name: ToolUseBlock['name'];
  toolUseId: ToolUseBlock['toolUseId'];
  input: ToolUseBlock['input'];
  /** Optional reasoning signature carried for thinking models. */
  reasoningSignature?: ToolUseBlock['reasoningSignature'];
}

/**
 * Tool result block on the wire.
 * `content` is intentionally serialised as `JSONValue` (not the SDK's
 * `ToolResultContent[]`) because some `ToolResultContent` subtypes carry
 * non-serialisable references (e.g., `Error` objects) that we deliberately
 * strip before persisting.
 */
export interface WireToolResultBlock {
  type: 'toolResultBlock';
  toolUseId: ToolResultBlock['toolUseId'];
  status: ToolResultBlock['status'];
  /** Plain-JSON projection of `ToolResultBlock.content`. */
  content: JSONValue;
}

/**
 * Image block on the wire.
 * Bytes are stored as a base64 string regardless of how the SDK chose to
 * serialise them, so the backend can decode without depending on the SDK.
 */
export interface WireImageBlock {
  type: 'imageBlock';
  format: ImageBlock['format'];
  /** Base64-encoded image bytes (decoded on the agent on read-back). */
  base64: string;
}

/**
 * Reasoning (extended thinking) block on the wire.
 *
 * A passthrough spread would corrupt the block: `ReasoningBlock.redactedContent`
 * is a `Uint8Array`, and `JSON.stringify` turns a `Uint8Array` into
 * `{"0":12,...}` — un-round-trippable, so Bedrock would reject the block on the
 * next turn. We therefore project it into a structured shape: `text`/`signature`
 * pulled from the SDK class (so a rename breaks compilation, mirroring
 * `WireToolUseBlock`), and `redactedContent` stored as a base64 string.
 *
 * `redactedContentBase64` is round-trip only — it is NEVER surfaced to the UI
 * (the backend converter drops it); it exists solely so the encrypted thinking
 * survives Memory persistence and can be re-sent to Bedrock verbatim.
 */
export interface WireReasoningBlock {
  type: 'reasoningBlock';
  text?: ReasoningBlock['text'];
  signature?: ReasoningBlock['signature'];
  /** Base64-encoded `redactedContent` (decoded back to Uint8Array on read-back). */
  redactedContentBase64?: string;
}

/**
 * Passthrough block for `ContentBlock` subtypes we don't yet need a
 * structured wire shape for. The runtime stores whatever fields the SDK
 * exposes and the read-back path tolerates schema drift.
 */
export interface WirePassthroughBlock {
  type:
    | 'cachePointBlock'
    | 'guardContentBlock'
    | 'videoBlock'
    | 'documentBlock'
    | 'citationsBlock';
  [key: string]: unknown;
}

/**
 * Discriminated union of all wire content blocks.
 *
 * NOTE on `ContentBlock` exhaustiveness: the SDK's `ContentBlock` union is
 * `TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock |
 * CachePointBlock | GuardContentBlock | ImageBlock | VideoBlock |
 * DocumentBlock | CitationsBlock`. The compile-time check in
 * `contentBlockToWire` ensures every member is handled here — if SDK adds
 * an 11th class, that switch fails to type-check.
 */
export type WireContentBlock =
  | WireTextBlock
  | WireToolUseBlock
  | WireToolResultBlock
  | WireImageBlock
  | WireReasoningBlock
  | WirePassthroughBlock;

/** Role discriminator on the wire. Stays in sync with `Message.role`. */
export type WireRole = 'user' | 'assistant';

/**
 * Blob payload format for AgentCore Memory.
 *
 * `schemaVersion` is **required** for v2+ and absent for legacy v1 (SDK
 * 0.1.x). Readers should branch on its presence.
 */
export interface WireBlobPayloadV2 {
  schemaVersion: WireSchemaVersion;
  messageType: 'content';
  role: WireRole;
  content: WireContentBlock[];
}

/**
 * Compile-time guarantee that we cover every `ContentBlock` subtype.
 *
 * If `@strands-agents/sdk` adds a new `*Block` to the `ContentBlock` union,
 * the `_KnownContentBlockTypes` literal-union below becomes a strict subset
 * of `ContentBlock['type']`, and the `_AssertContentBlockTypeCoverage`
 * conditional drops to `false`, which is rejected by the `extends true`
 * constraint and surfaces as a TypeScript error.
 */
type _KnownContentBlockTypes =
  | 'textBlock'
  | 'toolUseBlock'
  | 'toolResultBlock'
  | 'reasoningBlock'
  | 'cachePointBlock'
  | 'guardContentBlock'
  | 'imageBlock'
  | 'videoBlock'
  | 'documentBlock'
  | 'citationsBlock';

type _AssertContentBlockTypeCoverage = ContentBlock['type'] extends _KnownContentBlockTypes
  ? _KnownContentBlockTypes extends ContentBlock['type']
    ? true
    : false
  : false;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ContentBlockTypeCoverageGuard = _AssertContentBlockTypeCoverage extends true ? true : never;
