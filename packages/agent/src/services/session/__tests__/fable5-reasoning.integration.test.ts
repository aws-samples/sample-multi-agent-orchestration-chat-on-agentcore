/**
 * Claude Fable 5 — reasoning round-trip regression (integration).
 *
 * Reproduces the production failure:
 *
 *   reasoning content format incorrect. Either 'text' or 'redactedContent' must be set.
 *
 * Root cause: Fable 5 (Mythos-class) has adaptive thinking always ON and emits a
 * reasoning block whose `reasoningText.text` is the EMPTY string `''` (only a
 * `signature` is present). When that assistant turn re-enters the conversation
 * history and is sent back on the NEXT turn, the Strands SDK's BedrockModel
 * formats it with `if (block.text) { … } else if (block.redactedContent) { … }
 * else throw`. Empty string is falsy, so a `text === ''` reasoning block matches
 * neither branch and the SDK throws before the request even reaches Bedrock.
 *
 * This is the reasoning-block analogue of the empty-TextBlock problem that
 * EmptyTextBlockHook already fixes for Qwen3 (see empty-text-block-hook.ts).
 *
 * The suite is OPT-IN: set RUN_BEDROCK_FABLE_INTEGRATION=1 to run it. It calls
 * the real Bedrock Converse / ConverseStream API, so it requires:
 *   - AWS credentials with bedrock:InvokeModelWithResponseStream on Fable 5
 *   - Fable 5's data-retention prerequisite satisfied in the invocation region
 *     (provider_data_share). Fable 5 is invoked in BEDROCK_REGION (no registry
 *     region pin in the OSS default), so point BEDROCK_REGION at a region where
 *     provider_data_share is enabled.
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_FABLE_INTEGRATION=1 \
 *     npm run test:integration -- fable5-reasoning
 */

import { it, expect } from '@jest/globals';
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { createBedrockModel } from '../../../config/bedrock.js';
import { EmptyReasoningBlockHook } from '../empty-reasoning-block-hook.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const FABLE_5 = 'global.anthropic.claude-fable-5';

const describeFable5 = describeIfEnv(['RUN_BEDROCK_FABLE_INTEGRATION'], 'Fable 5 reasoning integration');

/** Extract text from a message's content blocks. */
function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** Drive the agent via streaming to completion. */
async function streamAll(agent: Agent, prompt: string): Promise<void> {
  // Drain the stream; the events themselves are not asserted here.
  for await (const _event of agent.stream(prompt)) {
    void _event;
  }
}

/** True if the assistant turn carries a reasoning block with empty/absent text. */
function hasEmptyReasoningBlock(message: { content: unknown[] }): boolean {
  return message.content.some((b) => {
    const block = b as { type?: string; text?: string; redactedContent?: unknown };
    return (
      block.type === 'reasoningBlock' &&
      (block.text === undefined || block.text === '') &&
      !block.redactedContent
    );
  });
}

describeFable5('Claude Fable 5 reasoning round-trip', () => {
  it('completes a multi-turn conversation without the "reasoning content format incorrect" error', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: FABLE_5 }),
      systemPrompt: 'Be concise. Show brief reasoning before answering.',
      tools: [],
      // Mirror production wiring (agent.ts always registers this hook). Without
      // it, Fable 5's empty-text reasoning block makes the turn-2 follow-up
      // request fail with the SDK formatter's "reasoning content format
      // incorrect" error.
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    // Turn 1: a prompt that elicits reasoning. Fable 5 commonly returns a
    // reasoning block whose text is '' (signature only).
    await streamAll(agent, 'What is 17 multiplied by 23? Think first, then answer.');

    // Turn 2: re-sends the turn-1 assistant message (incl. the reasoning block)
    // back to Bedrock. Without the fix the SDK throws while formatting the
    // empty-text reasoning block, before the request is sent.
    await expect(
      streamAll(agent, 'Now multiply that result by 2.')
    ).resolves.toBeUndefined();

    expect(textOf(agent.messages[agent.messages.length - 1])).toMatch(/782/);
  }, 120_000);

  it('strips empty reasoning blocks from history so they are never re-sent', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: FABLE_5 }),
      systemPrompt: 'Be concise. Show brief reasoning before answering.',
      tools: [],
      plugins: [new EmptyReasoningBlockHook()],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'What is 17 multiplied by 23? Think first, then answer.');

    // After the turn settles, no assistant message should retain a reasoning
    // block with empty/absent text and no redactedContent — that is exactly the
    // shape the SDK formatter rejects on the next turn.
    const offenders = agent.messages
      .filter((m) => m.role === 'assistant')
      .filter((m) => hasEmptyReasoningBlock(m));
    expect(offenders).toHaveLength(0);
  }, 120_000);
});
