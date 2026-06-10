/**
 * Empty Reasoning Block Hook
 *
 * Strips empty reasoning blocks from assistant messages before they re-enter the
 * conversation history.
 *
 * Why this is needed:
 * Claude Fable 5 (and other Mythos-class models) have adaptive thinking always
 * ON and sometimes emit a `reasoningBlock` whose `text` is the EMPTY string `''`
 * (only a `signature` is present, with no reasoning text and no redactedContent):
 *
 *   content: [
 *     { type: 'reasoningBlock', text: '', signature: 'CAIS…' },
 *     { type: 'textBlock', text: '…the answer…' },
 *   ]
 *
 * The first request succeeds, but on the FOLLOW-UP request — after this assistant
 * turn re-enters history and the whole conversation is sent back — the Strands
 * SDK's BedrockModel formats the reasoning block with:
 *
 *   if (block.text) { … reasoningText … }
 *   else if (block.redactedContent) { … redactedContent … }
 *   else throw Error("reasoning content format incorrect. Either 'text' or 'redactedContent' must be set.")
 *
 * An empty string is falsy, so a `text === ''` reasoning block matches neither
 * branch and the SDK throws before the request reaches Bedrock — surfacing as:
 *
 *   [SYSTEM_ERROR] ModelError: reasoning content format incorrect.
 *   Either 'text' or 'redactedContent' must be set.
 *
 * Dropping the empty reasoning block is safe: it carries no reasoning text and no
 * redactedContent, and the Bedrock Converse API does NOT require thinking blocks
 * to be preserved across turns (verified live, including across a tool-use turn).
 * This is the reasoning-block analogue of EmptyTextBlockHook.
 *
 * Models that do not emit empty reasoning blocks are unaffected — the hook is a
 * harmless no-op. It only removes a reasoning block when other content blocks
 * remain, so an assistant message is never left with empty `content`.
 */

import { MessageAddedEvent } from '@strands-agents/sdk';
import type { Plugin, LocalAgent, Message } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';

/**
 * Returns true for a reasoning block the SDK BedrockModel would reject on the
 * next turn: neither a non-empty `text` nor any `redactedContent`.
 */
function isEmptyReasoningBlock(block: Message['content'][number]): boolean {
  if (block.type !== 'reasoningBlock') {
    return false;
  }
  // `text` and `redactedContent` are both optional on a ReasoningBlock. The SDK
  // formatter accepts the block only when `text` is truthy (non-empty) or
  // `redactedContent` is present; mirror that test exactly.
  const reasoning = block as { text?: string; redactedContent?: Uint8Array };
  const hasText = typeof reasoning.text === 'string' && reasoning.text.length > 0;
  const hasRedacted = reasoning.redactedContent != null && reasoning.redactedContent.length > 0;
  return !hasText && !hasRedacted;
}

export class EmptyReasoningBlockHook implements Plugin {
  readonly name = 'moca:empty-reasoning-block-hook';

  /**
   * Register hook callbacks on the agent.
   * Called by the Agent's PluginRegistry during construction.
   */
  initAgent(agent: LocalAgent): void {
    agent.addHook(MessageAddedEvent, (event) => this.onMessageAdded(event));
  }

  /**
   * Strip empty reasoning blocks from assistant messages as they are added to
   * history.
   *
   * Mutates `message.content` in place: the array reference is `readonly`, but
   * its elements are not, so an in-place `splice` is the supported way to edit
   * the assembled message before it is persisted / re-sent to the model.
   */
  private onMessageAdded(event: MessageAddedEvent): void {
    const { message } = event;
    if (message.role !== 'assistant') {
      return;
    }

    const content = message.content;
    // Only strip when at least one other block remains, so we never produce an
    // assistant message with empty `content`.
    const hasOtherContent = content.some((block) => !isEmptyReasoningBlock(block));
    if (!hasOtherContent) {
      return;
    }

    let removed = 0;
    for (let i = content.length - 1; i >= 0; i--) {
      if (isEmptyReasoningBlock(content[i])) {
        content.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(
        { removed, remaining: content.length },
        '[EMPTY_REASONING_BLOCK_HOOK] Stripped empty reasoning block(s) from assistant message'
      );
    }
  }
}
