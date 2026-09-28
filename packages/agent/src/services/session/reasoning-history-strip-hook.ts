/**
 * Reasoning History Strip Hook
 *
 * Drops reasoning blocks from completed prior assistant turns before each
 * invocation, for models whose thinking blocks are bound to the request prefix.
 *
 * Why this is needed:
 * Claude Sonnet 5.5 records, in every thinking block, a binding to everything
 * before it — the system prompt, the tools and earlier messages. On accounts
 * created on or after 2026-08-31 (Claude API, Amazon Bedrock, Google Cloud) a
 * request that replays such a block after the prefix changed is rejected with a
 * 400. Moca's prefix is not stable across turns:
 *   - the system prompt carries an hourly `<current_time>`
 *   - long-term memories and the enabled tool set can change between turns
 *   - SlidingWindowConversationManager trims earlier messages
 * Sonnet 5.5 also cannot read Opus 5 / 5.5 or Fable thinking blocks (the API
 * drops them), so after a model switch prior reasoning is ignored anyway.
 *
 * Timing: the hook runs on BeforeInvocationEvent, i.e. before the new user
 * message's agent loop starts. Every assistant message in history at that
 * point belongs to a finished turn. Reasoning blocks produced inside the
 * current tool loop are appended afterwards and are sent back unchanged, as
 * the API requires for multi-step tool use.
 *
 * Only reasoning blocks are removed, and only when other content remains, so an
 * assistant message is never left with empty `content`. The hook is a no-op for
 * models without `stripPriorReasoning` in the @moca/core registry.
 */

import { BeforeInvocationEvent } from '@strands-agents/sdk';
import type { Plugin, LocalAgent, Message } from '@strands-agents/sdk';
import { shouldStripPriorReasoning } from '@moca/core';
import { logger } from '../../libs/logger/index.js';

export function stripReasoningBlocks(messages: Message[]): number {
  let removed = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const content = message.content;
    if (!content.some((block) => block.type !== 'reasoningBlock')) {
      continue;
    }
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i].type === 'reasoningBlock') {
        content.splice(i, 1);
        removed++;
      }
    }
  }
  return removed;
}

export class ReasoningHistoryStripHook implements Plugin {
  readonly name = 'moca:reasoning-history-strip-hook';

  constructor(private readonly modelId: string) {}

  initAgent(agent: LocalAgent): void {
    if (!shouldStripPriorReasoning(this.modelId)) {
      return;
    }
    agent.addHook(BeforeInvocationEvent, (event) => this.onBeforeInvocation(event));
  }

  private onBeforeInvocation(event: BeforeInvocationEvent): void {
    const removed = stripReasoningBlocks(event.agent.messages);
    if (removed > 0) {
      logger.debug(
        { removed, modelId: this.modelId },
        '[REASONING_HISTORY_STRIP_HOOK] Stripped prior-turn reasoning block(s)'
      );
    }
  }
}
