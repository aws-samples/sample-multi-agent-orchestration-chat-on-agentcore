/**
 * Codec between Strands SDK `ContentBlock` instances and the agent's
 * AgentCore Memory wire format.
 *
 * Why this exists
 * ---------------
 * `@strands-agents/sdk@>=1.0` `ContentBlock` classes (`TextBlock`,
 * `ToolUseBlock`, `ToolResultBlock`, ...) define a `toJSON()` that emits
 * the **Bedrock Converse API native shape** (`{ toolUse: {...} }`,
 * `{ toolResult: {...} }`) and **drops the `type` discriminator**. Calling
 * `JSON.stringify(content)` on a Strands `Message.content` therefore
 * produces blobs without `block.type`, which breaks both the agent's own
 * read-back path and the backend's `convertToMessageContents` (since both
 * dispatch on `type`).
 *
 * The codec here defends against that by:
 *
 *   - Building wire blocks **field by field** instead of relying on
 *     `toJSON()`, so the discriminator is always present.
 *   - Using an exhaustive `switch` that bottoms out on a `never` check —
 *     if SDK adds a new `*Block` subclass, the build fails.
 *   - Pulling field types from SDK classes (see
 *     `content-block-codec.types.ts`) so renamed fields surface as type
 *     errors at the boundary.
 *
 * The reverse path (`wireToContentBlock`) restores SDK class instances so
 * the resulting `Message[]` can be passed to `new Agent({ messages })`.
 */

import {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  type ContentBlock,
  type ToolResultContent,
} from '@strands-agents/sdk';

import { logger } from '../logger/index.js';
import type {
  WireContentBlock,
  WireImageBlock,
  WireTextBlock,
  WireToolResultBlock,
  WireToolUseBlock,
} from './content-block-codec.types.js';

// ---------------------------------------------------------------------------
// SDK → wire
// ---------------------------------------------------------------------------

/**
 * Convert a SDK `ContentBlock` instance to its wire representation.
 *
 * Field access (`block.text`, `block.name`, ...) is type-checked against
 * the live SDK declarations, so a SDK rename is caught at compile time.
 *
 * @throws if the SDK introduces a new `ContentBlock` subclass we haven't
 * covered. The `never` assertion in the `default` branch ensures the
 * TypeScript compiler refuses to build until this file is updated.
 */
export function contentBlockToWire(block: ContentBlock): WireContentBlock {
  switch (block.type) {
    case 'textBlock': {
      const wire: WireTextBlock = { type: 'textBlock', text: block.text };
      return wire;
    }

    case 'toolUseBlock': {
      const wire: WireToolUseBlock = {
        type: 'toolUseBlock',
        name: block.name,
        toolUseId: block.toolUseId,
        input: block.input,
      };
      // Preserve reasoningSignature only when present; SDK marks it optional.
      if (block.reasoningSignature !== undefined) {
        wire.reasoningSignature = block.reasoningSignature;
      }
      return wire;
    }

    case 'toolResultBlock': {
      const wire: WireToolResultBlock = {
        type: 'toolResultBlock',
        toolUseId: block.toolUseId,
        status: block.status,
        // `ToolResultContent` may carry non-serialisable fields (e.g. a
        // raw `Error` on `block.error`). We strip those by JSON-cycling
        // through `JSON.parse(JSON.stringify(...))`, which is safe because
        // the SDK's own `toJSON()` already projects each `ToolResultContent`
        // entry into a plain object.
        content: JSON.parse(JSON.stringify(block.content)),
      };
      return wire;
    }

    case 'imageBlock': {
      // ImageBlock.source.bytes is a Uint8Array. The backend cannot import
      // SDK classes, so we always serialise to base64 here regardless of
      // what shape SDK's own toJSON() chooses.
      const sourceBytes = (block as unknown as { source?: { bytes?: Uint8Array } }).source?.bytes;
      const base64 = sourceBytes ? Buffer.from(sourceBytes).toString('base64') : '';
      // Default to 'png' when SDK leaves `format` undefined — Bedrock requires
      // a concrete format on the wire and historical S3-uploaded images were
      // serialised with this default.
      const wire: WireImageBlock = {
        type: 'imageBlock',
        format: (block.format ?? 'png') as WireImageBlock['format'],
        base64,
      };
      return wire;
    }

    case 'reasoningBlock':
    case 'cachePointBlock':
    case 'guardContentBlock':
    case 'videoBlock':
    case 'documentBlock':
    case 'citationsBlock': {
      // No structured wire shape needed yet; preserve every enumerable
      // property the SDK class exposes so the read-back path can attempt
      // best-effort restoration. We deliberately spread `block` instead of
      // calling `block.toJSON()` because the latter strips `type`.
      return { ...(block as unknown as Record<string, unknown>), type: block.type };
    }

    default: {
      // Compile-time exhaustiveness: if SDK adds a new ContentBlock subtype,
      // `block` here will not be `never` and `tsc` will fail.
      const _exhaustive: never = block;
      throw new Error(
        `contentBlockToWire: unhandled ContentBlock at runtime: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// wire → SDK
// ---------------------------------------------------------------------------

/**
 * Restore a wire block back into a SDK `ContentBlock` instance suitable
 * for passing into `new Agent({ messages })`.
 *
 * Unknown wire types fall back to a placeholder `TextBlock(' ')` rather
 * than throwing, because conversation history may legitimately contain
 * blocks the agent did not produce (e.g. saved by a previous SDK version
 * that emitted a now-removed type).
 */
export function wireToContentBlock(wire: WireContentBlock): ContentBlock {
  switch (wire.type) {
    case 'textBlock':
      return new TextBlock(wire.text);

    case 'toolUseBlock':
      return new ToolUseBlock({
        name: wire.name,
        toolUseId: wire.toolUseId,
        input: wire.input,
        ...(wire.reasoningSignature !== undefined
          ? { reasoningSignature: wire.reasoningSignature }
          : {}),
      });

    case 'toolResultBlock':
      return new ToolResultBlock({
        toolUseId: wire.toolUseId,
        status: wire.status,
        // We saved a JSONValue projection; cast back to `ToolResultContent[]`.
        content: wire.content as unknown as ToolResultContent[],
      });

    case 'imageBlock': {
      const bytes = wire.base64
        ? new Uint8Array(Buffer.from(wire.base64, 'base64'))
        : new Uint8Array();
      return new ImageBlock({ format: wire.format, source: { bytes } });
    }

    case 'reasoningBlock':
    case 'cachePointBlock':
    case 'guardContentBlock':
    case 'videoBlock':
    case 'documentBlock':
    case 'citationsBlock':
      // Pass-through blocks: cast to `ContentBlock`. Strands SDK accepts
      // plain `MessageData` shape inside `new Agent({ messages })`, and
      // the agent loop's internal `contentBlockFromData` will reconstruct
      // a class instance if needed for downstream model providers.
      return wire as unknown as ContentBlock;

    default: {
      logger.warn(
        { wire },
        'wireToContentBlock: unknown wire content block type, falling back to empty TextBlock'
      );
      return new TextBlock(' ');
    }
  }
}
