/**
 * Bedrock reasoning (extended thinking) — depth + round-trip regression (integration).
 *
 * Validates the feature end to end against the REAL Bedrock Converse / ConverseStream API:
 *
 *   1. Depth → thinking: with a reasoning-capable model (Opus 4.8) and depth
 *      'high', the request is accepted (proving the `{ thinking: { type:
 *      'enabled', budget_tokens } }` shape from @moca/core's getReasoningConfig
 *      is what Bedrock accepts) and the assistant turn carries a reasoning block.
 *      This is the canonical place that pins the additionalModelRequestFields
 *      key shape — if Bedrock ever changes it, this test fails first.
 *
 *   2. Memory round-trip: an assistant message containing a reasoning block is
 *      serialized through the AgentCore-Memory codec (contentBlockToWire →
 *      JSON → wireToContentBlock) and fed back as conversation history on a
 *      follow-up turn. This is the exact path session restore takes, and proves
 *      the reasoning block (text + signature, and any redactedContent as base64)
 *      survives well enough for Bedrock to accept it on re-send — i.e. no
 *      "reasoning content format incorrect" error.
 *
 * The suite is OPT-IN: set RUN_BEDROCK_REASONING_INTEGRATION=1 to run it. It
 * requires:
 *   - AWS credentials with bedrock:InvokeModelWithResponseStream on Opus 4.8
 *   - BEDROCK_REGION pointing at a region where the model is available
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_REASONING_INTEGRATION=1 \
 *     npm run test:integration -- reasoning-depth
 */

import { it, expect } from '@jest/globals';
import {
  Agent,
  SlidingWindowConversationManager,
  type ContentBlock,
  type Message,
} from '@strands-agents/sdk';
import { createBedrockModel } from '../../../config/bedrock.js';
import { EmptyReasoningBlockHook } from '../empty-reasoning-block-hook.js';
import { contentBlockToWire, wireToContentBlock } from '../../../libs/codec/content-block-codec.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const OPUS_4_8 = 'global.anthropic.claude-opus-4-8';

const describeReasoning = describeIfEnv(
  ['RUN_BEDROCK_REASONING_INTEGRATION'],
  'Bedrock reasoning depth integration'
);

/** Extract concatenated text from a message's text blocks. */
function textOf(message: { content: readonly unknown[] }): string {
  return message.content
    .filter((b) => (b as { type?: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** True when the message carries a reasoning block (regardless of text/redacted). */
function hasReasoningBlock(message: { content: readonly unknown[] }): boolean {
  return message.content.some((b) => (b as { type?: string }).type === 'reasoningBlock');
}

/** Drive the agent to completion, ignoring the streamed events. */
async function streamAll(agent: Agent, prompt: string): Promise<void> {
  for await (const _event of agent.stream(prompt)) {
    void _event;
  }
}

/**
 * Round-trip a message's content through the AgentCore-Memory codec exactly as
 * session save/restore does: SDK block → wire → JSON string → wire → SDK block.
 */
function roundTripThroughMemory(message: Message): ContentBlock[] {
  const wire = message.content.map((block) => contentBlockToWire(block as ContentBlock));
  const json = JSON.parse(JSON.stringify(wire));
  return json.map((w: unknown) => wireToContentBlock(w as never));
}

describeReasoning('Bedrock reasoning depth', () => {
  it('depth "high" produces a reasoning block on a capable model', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: OPUS_4_8, reasoningEffort: 'high' }),
      systemPrompt: 'Show your reasoning, then answer.',
      tools: [],
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'What is 17 multiplied by 23? Think step by step, then answer.');

    const last = agent.messages[agent.messages.length - 1];
    expect(textOf(last)).toMatch(/391/);
    // With thinking enabled, the assistant turn should include a reasoning block.
    const assistantTurns = agent.messages.filter((m) => m.role === 'assistant');
    expect(assistantTurns.some((m) => hasReasoningBlock(m))).toBe(true);
  }, 120_000);

  it('survives a Memory round-trip of the reasoning block on the follow-up turn', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: OPUS_4_8, reasoningEffort: 'high' }),
      systemPrompt: 'Show your reasoning, then answer.',
      tools: [],
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'What is 17 multiplied by 23? Think step by step, then answer.');

    // Simulate session persistence + restore: round-trip every message through
    // the codec, then build a fresh agent seeded with the restored history.
    const restored: Message[] = agent.messages.map(
      (m) =>
        ({
          role: m.role,
          content: roundTripThroughMemory(m),
        }) as unknown as Message
    );

    const resumed = new Agent({
      model: createBedrockModel({ modelId: OPUS_4_8, reasoningEffort: 'high' }),
      systemPrompt: 'Show your reasoning, then answer.',
      tools: [],
      messages: restored,
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    // The follow-up re-sends the restored reasoning block to Bedrock. Without a
    // faithful codec round-trip this throws "reasoning content format incorrect".
    await expect(streamAll(resumed, 'Now multiply that result by 2.')).resolves.toBeUndefined();
    expect(textOf(resumed.messages[resumed.messages.length - 1])).toMatch(/782/);
  }, 180_000);
});
