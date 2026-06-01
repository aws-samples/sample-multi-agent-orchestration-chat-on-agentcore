/**
 * Empty Text Block Hook
 *
 * Strips empty (whitespace-only) TextBlocks from assistant messages before they
 * re-enter the conversation history.
 *
 * Why this is needed:
 * Some Bedrock models — notably Qwen3 — emit a leading EMPTY text content block
 * immediately before a `toolUse` block in their stream:
 *
 *   messageStart(assistant)
 *   contentBlockStop(0)            // text block, but NO textDelta ever arrived → text === ''
 *   contentBlockStart(1, toolUse)
 *   contentBlockStop(1)
 *
 * The Strands SDK assembles a stopped content block with no accumulated deltas as
 * `new TextBlock('')` (see node_modules/@strands-agents/sdk/dist/src/models/model.js),
 * so the assistant message becomes `content: [{ text: '' }, { toolUse }]`.
 *
 * The first request (sending only the toolUse turn) succeeds, but on the FOLLOW-UP
 * request — after the tool result is appended and the whole turn is sent back —
 * Bedrock validates the empty text field and rejects it:
 *
 *   ValidationException: The text field in the ContentBlock object at
 *   messages.1.content.0 is blank. Add text to the text field, and try again.
 *
 * Anthropic (Claude) models do not emit these empty blocks, so this hook is a
 * harmless no-op for them. It only removes a TextBlock when other content blocks
 * remain, so an assistant message is never left with empty `content`.
 */

import { MessageAddedEvent } from '@strands-agents/sdk';
import type { Plugin, LocalAgent, Message } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';

/**
 * Returns true for a TextBlock whose text is empty or whitespace-only.
 */
function isEmptyTextBlock(block: Message['content'][number]): boolean {
  return block.type === 'textBlock' && block.text.trim() === '';
}

export class EmptyTextBlockHook implements Plugin {
  readonly name = 'moca:empty-text-block-hook';

  /**
   * Register hook callbacks on the agent.
   * Called by the Agent's PluginRegistry during construction.
   */
  initAgent(agent: LocalAgent): void {
    agent.addHook(MessageAddedEvent, (event) => this.onMessageAdded(event));
  }

  /**
   * Strip empty TextBlocks from assistant messages as they are added to history.
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
    // Only strip when at least one non-empty block remains, so we never produce
    // an assistant message with empty `content`.
    const hasOtherContent = content.some((block) => !isEmptyTextBlock(block));
    if (!hasOtherContent) {
      return;
    }

    let removed = 0;
    for (let i = content.length - 1; i >= 0; i--) {
      if (isEmptyTextBlock(content[i])) {
        content.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(
        { removed, remaining: content.length },
        '[EMPTY_TEXT_BLOCK_HOOK] Stripped empty TextBlock(s) from assistant message'
      );
    }
  }
}
