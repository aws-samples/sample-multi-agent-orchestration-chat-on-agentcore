# AgentCore Memory wire format and SDK upgrade tolerance

**Status:** Accepted
**Date:** 2026-05-21

## Context

Conversation history is the only AgentCore Memory payload that mixes
multiple block types (text, tool use, tool result, image). It has two
producers and two consumers:

| Side | Role | Lives in |
|---|---|---|
| Agent | producer + consumer | `packages/agent/src/services/session/` |
| Backend | consumer (read-only, for the UI) | `packages/backend/src/services/agentcore-memory.ts` |

The agent runs the Strands Agents SDK (`@strands-agents/sdk`); the
backend deliberately does not. Both sides need to agree on the wire
format of the blob payload that goes through `AgentCore Memory →
events.payload[].blob`.

## SDK 1.x changed `toJSON()` underneath us

Up to `@strands-agents/sdk@0.1.6`, calling `JSON.stringify(message)` on
a `Message` instance produced plain objects with `block.type`
discriminators (`'textBlock'`, `'toolUseBlock'`, `'toolResultBlock'`,
`'imageBlock'`). Both consumers `switch (block.type)`.

`@strands-agents/sdk@>=1.0` introduced a different convention: each
content-block class now defines a `toJSON()` that returns the **Bedrock
Converse API native shape** —

```jsonc
{ "text": "..." }                  // TextBlock.toJSON()
{ "toolUse":   { "name": ..., "toolUseId": ..., "input": ... } }
{ "toolResult":{ "toolUseId": ..., "status": ..., "content": ... } }
{ "image":     { "format": ..., "source": { "bytes": "<base64>" } } }
```

— and **drops the `type` discriminator**. This is the right shape for
sending to Bedrock, but it silently breaks both consumers because the
field they switch on is now missing.

The symptom was: tool calls and their results streamed correctly during
agent invocation but disappeared from the conversation pane after a page
reload. `AgentCoreMemoryService` was logging `Unknown ContentBlock type:
undefined` on every block.

## Decision

### 1. Agent produces with an explicit codec, NOT `JSON.stringify(content)`

`packages/agent/src/services/session/content-block-codec.ts` walks
each `ContentBlock` instance through an exhaustive `switch` and emits a
`Wire*Block` shape that always carries `type`. The wire types live in
`content-block-codec.types.ts` and derive their fields from the SDK
classes via indexed-access types (`ToolUseBlock['name']`), so a SDK
rename surfaces as a TypeScript error at the codec boundary.

The codec's `default` branch performs a `_exhaustive: never` assignment.
If a future SDK release adds a new `*Block` subclass, the agent build
fails until the codec is updated to handle it — no silent regression.

### 2. Wire envelope carries `schemaVersion`

```ts
{
  schemaVersion: 'v2-strands-sdk-1',
  messageType: 'content',
  role: 'user' | 'assistant',
  content: WireContentBlock[]
}
```

Future incompatible wire changes pivot the version literal and add a
new branch to the read path; old data continues to be readable.

### 3. Backend keeps zero dependency on `@strands-agents/sdk`

The backend pins its own `BackendContentBlock` type that mirrors the
expected wire shape. We **do not** share a typed contract package
between agent and backend, because:

- The backend image / Lambda cold start cost should not pay for SDK
  transitive deps it doesn't need.
- A shared package would push `@strands-agents/sdk` and `zod` into
  `@moca/core`, which is also imported by the frontend. The frontend
  bundle should not pay for them either.
- The two consumers have different *needs* of the format anyway —
  the agent reconstructs SDK class instances; the backend only flattens
  to a UI DTO. Sharing one type leads to leaky compromises.

### 4. Both consumers carry an explicit salvage path

For sessions persisted between the SDK 1.x upgrade and this codec
landing (the "bug window"), the agent ran `JSON.stringify(message.content)`
which invoked the SDK's `toJSON()` and produced typeless wrappers
(`{ toolUse: {...} }`, `{ toolResult: {...} }`, `{ text: "..." }`,
`{ image: {...} }`).

Both sides have a salvage helper that detects these shapes and
reconstructs the structured form. This is small, finite, and lives next
to the type-safe path so it's obvious what edge cases it covers.
Once we are confident no bug-window data remains in production
AgentCore Memory, the salvage paths can be deleted; until then they
keep historical sessions readable.

## Consequences

### Positive

- A SDK class rename or new `*Block` subclass is now a compile-time
  error in the agent, not a silent runtime data loss.
- The `schemaVersion` envelope gives us a clear migration story for
  future incompatible changes.
- Backend stays SDK-free, image stays small.

### Negative

- Two parallel type definitions (agent `WireContentBlock` and backend
  `BackendContentBlock`) that must stay aligned by hand. The
  round-trip integration test in
  `packages/agent/src/services/session/__tests__/converters.test.ts`
  pins the shape from the agent side, and the backend salvage tests
  (planned, see follow-up) will pin the consumer side. Drift between
  the two would manifest as "new tool blocks not displayed in
  reloaded conversation" — operationally visible quickly.

### Rejected alternatives

- **Share a common types package.** Considered placing the wire types
  in `@moca/core` or a new `@moca/agentcore-memory-payload`. Rejected
  because the dependency direction was wrong (`@moca/core` should not
  pull `@strands-agents/sdk` into the frontend) and the actual usage
  patterns at the two consumers don't overlap enough to justify a
  shared abstraction.
- **Run `JSON.stringify` and let SDK choose.** That's exactly what
  caused the original incident — depending on the SDK's serialisation
  shape couples our persistence wire format to whichever Bedrock
  convention the SDK currently mirrors. Owning our own wire format is
  the only way to be insulated from upstream serialisation drift.

## Files of interest

- `packages/agent/src/services/session/content-block-codec.types.ts`
  — wire types derived from SDK indexed-access types + ContentBlock
  union exhaustiveness guard.
- `packages/agent/src/services/session/content-block-codec.ts` —
  `contentBlockToWire`, `wireToContentBlock`, `salvageLegacyContentBlock`.
- `packages/agent/src/services/session/converters.ts` — payload-level
  envelope (conversational vs blob) that uses the codec.
- `packages/backend/src/services/agentcore-memory.ts` —
  `BackendContentBlock`, `normaliseBlock`, `convertToMessageContents`.
