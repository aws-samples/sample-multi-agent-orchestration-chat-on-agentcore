/**
 * Reasoning content (extended thinking) — end-to-end integration.
 *
 * Verifies the full reasoning data path against the REAL Bedrock API:
 *
 *   1. `createBedrockModel({ reasoningEnabled: true })` turns on extended
 *      thinking via `additionalRequestFields.thinking` and the stream emits
 *      `reasoningContentDelta` events with text.
 *   2. The settled assistant message carries a `reasoningBlock` with
 *      non-empty `text` AND a `signature` (Bedrock requires the signature
 *      to be echoed back on later turns).
 *   3. Multi-turn: re-sending the turn-1 reasoning block (incl. signature)
 *      through the SDK does not error and the model can use the context.
 *   4. Codec round-trip: `contentBlockToWire` produces a JSON-safe wire
 *      shape for reasoning blocks (no Uint8Array index-key mangling), and
 *      `wireToContentBlock` restores blocks that Bedrock ACCEPTS when the
 *      restored history is replayed in a fresh Agent — this simulates the
 *      AgentCore Memory persist → reload path used in production.
 *   5. Tool use + reasoning: interleaved reasoning/toolUse blocks survive
 *      a multi-turn conversation (signature carried on the wire).
 *
 * The suite is OPT-IN: set RUN_BEDROCK_REASONING_INTEGRATION=1 to run.
 * Requirements:
 *   - AWS credentials with bedrock:InvokeModelWithResponseStream on the
 *     model under test (default: Claude Sonnet 4.6 via global profile)
 *   - BEDROCK_REGION pointing at a region with the global.* profile
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_REASONING_INTEGRATION=1 \
 *     npm run test:integration -- reasoning-content
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import type { Message } from '@strands-agents/sdk';
import { z } from 'zod';
import { createBedrockModel } from '../../../config/bedrock.js';
import {
  contentBlockToWire,
  wireToContentBlock,
} from '../../../libs/codec/content-block-codec.js';
import type { ContentBlock } from '@strands-agents/sdk';
import { EmptyReasoningBlockHook } from '../empty-reasoning-block-hook.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const MODEL_ID = process.env.REASONING_TEST_MODEL_ID || 'global.anthropic.claude-sonnet-4-6';

const describeReasoning = describeIfEnv(
  ['RUN_BEDROCK_REASONING_INTEGRATION'],
  'Reasoning content integration'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ReasoningDeltaShape {
  type?: string;
  text?: string;
  signature?: string;
  redactedContent?: unknown;
}

interface ReasoningBlockShape {
  type?: string;
  text?: string;
  signature?: string;
  redactedContent?: unknown;
}

/** Build an Agent wired the same way production agent.ts does. */
function buildAgent(): Agent {
  return new Agent({
    model: createBedrockModel({
      modelId: MODEL_ID,
      reasoningEnabled: true,
      reasoningBudgetTokens: 2048,
    }),
    systemPrompt: 'Be concise.',
    tools: [],
    plugins: [new EmptyReasoningBlockHook()],
    conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
  });
}

/** Drain the stream collecting every reasoningContentDelta payload. */
async function streamCollectingReasoningDeltas(
  agent: Agent,
  prompt: string
): Promise<ReasoningDeltaShape[]> {
  const deltas: ReasoningDeltaShape[] = [];
  for await (const event of agent.stream(prompt)) {
    const outer = event as { type?: string; event?: { type?: string; delta?: unknown } };
    const inner = outer.type === 'modelStreamUpdateEvent' ? outer.event : outer;
    if (inner?.type === 'modelContentBlockDeltaEvent') {
      const delta = (inner as { delta?: ReasoningDeltaShape }).delta;
      if (delta?.type === 'reasoningContentDelta') {
        deltas.push(delta);
      }
    }
  }
  return deltas;
}

/** Extract text from a message's content blocks. */
function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** All reasoning blocks across assistant messages. */
function reasoningBlocksOf(messages: ReadonlyArray<{ role: string; content: unknown[] }>) {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((b): b is ReasoningBlockShape => (b as { type?: string }).type === 'reasoningBlock');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeReasoning('Reasoning content end-to-end', () => {
  it('streams reasoningContentDelta events and settles a signed reasoningBlock', async () => {
    const agent = buildAgent();

    const deltas = await streamCollectingReasoningDeltas(
      agent,
      'What is 17 multiplied by 23? Think step by step, then answer.'
    );

    // 1. Reasoning deltas were streamed with actual text.
    const textDeltas = deltas.filter((d) => typeof d.text === 'string' && d.text.length > 0);
    expect(textDeltas.length).toBeGreaterThan(0);

    // 2. The settled assistant message carries a signed reasoning block.
    const blocks = reasoningBlocksOf(agent.messages);
    expect(blocks.length).toBeGreaterThan(0);
    const block = blocks[0];
    expect(typeof block.text).toBe('string');
    expect((block.text as string).length).toBeGreaterThan(0);
    expect(typeof block.signature).toBe('string');
    expect((block.signature as string).length).toBeGreaterThan(0);

    // 3. The answer itself is correct.
    expect(textOf(agent.messages[agent.messages.length - 1])).toMatch(/391/);
  }, 120_000);

  it('completes a multi-turn conversation re-sending the signed reasoning block', async () => {
    const agent = buildAgent();

    await streamCollectingReasoningDeltas(
      agent,
      'What is 17 multiplied by 23? Think first, then answer.'
    );

    // Turn 2 re-sends the turn-1 assistant reasoning block (with signature)
    // back to Bedrock. A missing/altered signature would be rejected.
    await expect(
      streamCollectingReasoningDeltas(agent, 'Now multiply that result by 2.')
    ).resolves.toBeDefined();

    expect(textOf(agent.messages[agent.messages.length - 1])).toMatch(/782/);
  }, 180_000);

  it('round-trips reasoning blocks through the wire codec and Bedrock accepts the restored history', async () => {
    // Turn 1 on a throwaway agent to obtain a real signed reasoning block.
    const first = buildAgent();
    await streamCollectingReasoningDeltas(
      first,
      'What is 17 multiplied by 23? Think first, then answer.'
    );

    // --- Persist: SDK ContentBlock → wire → JSON (AgentCore Memory blob) ---
    const wireMessages = first.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) => contentBlockToWire(b as ContentBlock)),
    }));
    const blob = JSON.stringify(wireMessages);

    // The wire JSON must be clean: a Uint8Array that leaks into JSON.stringify
    // serialises as {"0":..,"1":..} index keys — assert that never happens.
    expect(blob).not.toMatch(/"0":/);

    // Wire reasoning blocks keep text + signature verbatim.
    const parsed = JSON.parse(blob) as Array<{ role: string; content: ReasoningBlockShape[] }>;
    const wireReasoning = parsed
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'reasoningBlock');
    expect(wireReasoning.length).toBeGreaterThan(0);
    expect(typeof wireReasoning[0].text).toBe('string');
    expect((wireReasoning[0].text as string).length).toBeGreaterThan(0);
    expect(typeof wireReasoning[0].signature).toBe('string');

    // --- Reload: JSON → wire → SDK ContentBlock (fresh process simulation) ---
    const restored: Message[] = parsed.map(
      (m) =>
        ({
          role: m.role,
          content: m.content.map((b) => wireToContentBlock(b as never)),
        }) as unknown as Message
    );

    // Restored reasoning blocks are real instances with signature intact.
    const restoredReasoning = reasoningBlocksOf(restored);
    expect(restoredReasoning[0].text).toBe(wireReasoning[0].text);
    expect(restoredReasoning[0].signature).toBe(wireReasoning[0].signature);

    // --- Replay: a NEW agent seeded with the restored history must be able
    // to take the next turn — Bedrock validates the echoed reasoning block
    // (signature included), so acceptance here proves wire fidelity.
    const second = new Agent({
      model: createBedrockModel({
        modelId: MODEL_ID,
        reasoningEnabled: true,
        reasoningBudgetTokens: 2048,
      }),
      systemPrompt: 'Be concise.',
      tools: [],
      messages: restored,
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await expect(
      streamCollectingReasoningDeltas(second, 'Now multiply that result by 2.')
    ).resolves.toBeDefined();
    expect(textOf(second.messages[second.messages.length - 1])).toMatch(/782/);
  }, 240_000);

  it('handles tool use interleaved with reasoning across turns', async () => {
    const lookupTool = tool({
      name: 'warehouse_lookup',
      description: 'Look up the number of items stored in a named warehouse.',
      inputSchema: z.object({ warehouse: z.string() }),
      callback: (input: { warehouse: string }) =>
        input.warehouse === 'tokyo' ? '391 items' : '0 items',
    });

    const agent = new Agent({
      model: createBedrockModel({
        modelId: MODEL_ID,
        reasoningEnabled: true,
        reasoningBudgetTokens: 2048,
      }),
      systemPrompt: 'Be concise. Use tools when asked about warehouses.',
      tools: [lookupTool],
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamCollectingReasoningDeltas(
      agent,
      'How many items are stored in the tokyo warehouse? Use the tool.'
    );
    expect(textOf(agent.messages[agent.messages.length - 1])).toMatch(/391/);

    // Turn 2 replays reasoning + toolUse + toolResult history.
    await expect(
      streamCollectingReasoningDeltas(agent, 'Double that count and tell me the result.')
    ).resolves.toBeDefined();
    expect(textOf(agent.messages[agent.messages.length - 1])).toMatch(/782/);
  }, 240_000);
});
