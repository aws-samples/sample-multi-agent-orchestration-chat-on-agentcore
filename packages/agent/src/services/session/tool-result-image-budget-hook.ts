/**
 * Tool Result Image Budget Hook
 *
 * Caps how many tool-returned images stay live in the conversation.
 *
 * Why this is needed:
 * An image a tool returns stays in `agent.messages` for the rest of the turn
 * and is re-sent on every model call. An agent that inspects screenshot after
 * screenshot in one turn would add up to a megabyte per image to each request
 * until the request is rejected for its size — which the conversation manager
 * does not recover from, because it only reacts to context-window overflow.
 *
 * Images are replaced oldest-first and in batches (down to
 * KEPT_AFTER_PRUNE) rather than one per call: each replacement rewrites
 * earlier messages and so invalidates the prompt cache from that point on.
 */

import { BeforeModelCallEvent } from '@strands-agents/sdk';
import type { Plugin, LocalAgent, Message, ToolResultContent } from '@strands-agents/sdk';
import { toolResultImagePlaceholder } from '../../libs/codec/tool-result-image.js';
import { logger } from '../../libs/logger/index.js';

export const MAX_LIVE_TOOL_RESULT_IMAGES = 10;
export const KEPT_AFTER_PRUNE = 5;

/**
 * Replace the oldest tool-returned images with text placeholders once more
 * than MAX_LIVE_TOOL_RESULT_IMAGES are live. Returns the number replaced.
 */
export function pruneToolResultImages(messages: Message[]): number {
  const slots: { content: ToolResultContent[]; index: number }[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      block.content.forEach((entry, index) => {
        if (entry.type === 'imageBlock') slots.push({ content: block.content, index });
      });
    }
  }
  if (slots.length <= MAX_LIVE_TOOL_RESULT_IMAGES) return 0;

  const stale = slots.slice(0, slots.length - KEPT_AFTER_PRUNE);
  for (const { content, index } of stale) {
    const entry = content[index];
    if (entry.type === 'imageBlock') content[index] = toolResultImagePlaceholder(entry);
  }
  return stale.length;
}

export class ToolResultImageBudgetHook implements Plugin {
  readonly name = 'moca:tool-result-image-budget-hook';

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeModelCallEvent, (event) => {
      const replaced = pruneToolResultImages(event.agent.messages);
      if (replaced > 0) {
        logger.debug(
          { replaced },
          '[TOOL_RESULT_IMAGE_BUDGET_HOOK] Replaced older tool result image(s) with placeholders'
        );
      }
    });
  }
}
