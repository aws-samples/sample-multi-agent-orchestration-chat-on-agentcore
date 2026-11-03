/**
 * Session history loader
 *
 * Loads saved messages from session storage for conversation continuity.
 */

import { Message, TextBlock, type ContentBlock } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';
import type { SessionStorage, SessionConfig } from '../../services/session/types.js';

/**
 * Not whitespace-only: some providers reject blank text blocks.
 */
export const TOOL_PAIRING_PLACEHOLDER = '[tool call interrupted]';

function idsOf(
  message: Message | undefined,
  type: 'toolUseBlock' | 'toolResultBlock'
): Set<string> {
  const ids = new Set<string>();
  for (const block of message?.content ?? []) {
    if (block.type === type) ids.add((block as { toolUseId: string }).toolUseId);
  }
  return ids;
}

/**
 * Enforce the Bedrock tool-pairing invariant: every toolUse is answered by a
 * toolResult (same toolUseId) in the immediately following message, and every
 * toolResult answers a toolUse in the immediately preceding message.
 *
 * Unpaired blocks are removed. A message left empty is replaced with a text
 * placeholder instead of being dropped, so user/assistant alternation survives.
 *
 * @returns The original array when nothing needed repair.
 */
export function repairToolPairing(messages: Message[]): Message[] {
  let changed = false;
  const repaired = messages.map((message, i) => {
    const answeredIds = idsOf(messages[i + 1], 'toolResultBlock');
    const requestedIds = idsOf(messages[i - 1], 'toolUseBlock');
    const kept = message.content.filter((block) => {
      if (block.type === 'toolUseBlock') {
        return answeredIds.has((block as { toolUseId: string }).toolUseId);
      }
      if (block.type === 'toolResultBlock') {
        return requestedIds.has((block as { toolUseId: string }).toolUseId);
      }
      return true;
    });
    if (kept.length === message.content.length) return message;

    changed = true;
    const content: ContentBlock[] =
      kept.length > 0 ? kept : [new TextBlock(TOOL_PAIRING_PLACEHOLDER)];
    return new Message({ ...message, content });
  });

  if (!changed) return messages;
  logger.warn(`Session history: repaired unpaired tool blocks in ${messages.length} messages`);
  return repaired;
}

/**
 * Apply a sliding window truncation to a messages array.
 *
 * Uses the same trim-point algorithm as SlidingWindowConversationManager.reduceContext
 * to ensure:
 *   - toolUse / toolResult pairs are never split across the cut boundary
 *   - The first surviving message always has role 'user'
 *
 * NOTE: SlidingWindowConversationManager only applies its window *after* each
 * invocation (AfterInvocationEvent). It does NOT truncate the initial `messages`
 * array passed to the Agent constructor. This function fills that gap by
 * pre-truncating loaded history before it reaches the Agent.
 *
 * @param messages - Full conversation history loaded from storage
 * @param windowSize - Maximum number of messages to keep (must be ≥ 2)
 * @returns A new array containing at most `windowSize` messages, or the
 *          original array unchanged when no truncation is needed.
 */
export function applyWindowTruncation(messages: Message[], windowSize: number): Message[] {
  if (messages.length <= windowSize) {
    return messages;
  }

  // Ideal cut index: keep the last `windowSize` messages
  let trimIndex = messages.length - windowSize;

  // Walk forward from trimIndex until we find a safe cut point.
  // Mirrors the logic in SlidingWindowConversationManager.reduceContext (private).
  while (trimIndex < messages.length) {
    const msg = messages[trimIndex];
    if (!msg) break;

    // Cannot start a window with a toolResultBlock — it requires a preceding toolUseBlock.
    const hasToolResult = msg.content.some((b) => b.type === 'toolResultBlock');
    if (hasToolResult) {
      trimIndex++;
      continue;
    }

    // Cannot start a window with a toolUseBlock that has no following toolResultBlock —
    // a toolUse without its paired toolResult is invalid for Bedrock.
    // (If the next message IS a toolResultBlock, the pair is intact and this is a valid cut point.)
    const hasToolUse = msg.content.some((b) => b.type === 'toolUseBlock');
    if (hasToolUse) {
      const next = messages[trimIndex + 1];
      const nextHasToolResult = next?.content.some((b) => b.type === 'toolResultBlock');
      if (!nextHasToolResult) {
        // Orphaned toolUse (no paired toolResult follows) — skip this cut point.
        trimIndex++;
        continue;
      }
    }

    // Valid cut point found — the message at trimIndex can safely be the first message.
    break;
  }

  if (trimIndex >= messages.length) {
    // No valid cut point exists (e.g. the entire history is one giant tool chain).
    // Return the full history as a safe fallback — the downstream SlidingWindow
    // manager will handle overflow during the agentic loop.
    logger.warn(
      `Session history: no valid trim point found in ${messages.length} messages — returning full history`
    );
    return messages;
  }

  // The tail is not trimmed here: a window cut can leave unpaired tool blocks
  // at either end, and repairToolPairing() handles both by toolUseId.
  const truncated = repairToolPairing(messages.slice(trimIndex));
  logger.info(
    `Session history truncated: ${messages.length} → ${truncated.length} messages (windowSize: ${windowSize})`
  );
  return truncated;
}

/**
 * Load session history from storage.
 * Returns an empty array if storage or config is not provided.
 *
 * When `windowSize` is provided, the returned history is pre-truncated via
 * {@link applyWindowTruncation} so that no more than `windowSize` messages are
 * passed to the Agent constructor — preventing 400K+ token context windows.
 */
export async function loadSessionHistory(
  sessionStorage?: SessionStorage,
  sessionConfig?: SessionConfig,
  windowSize?: number
): Promise<Message[]> {
  if (!sessionStorage || !sessionConfig) {
    return [];
  }
  const messages = await sessionStorage.loadMessages(sessionConfig);
  logger.info(`Session history restored: ${messages.length} messages`);

  const windowed =
    windowSize !== undefined ? applyWindowTruncation(messages, windowSize) : messages;
  // Last step on every path (within window, truncated, fallback): a turn that
  // was cut off between toolUse and toolResult persists an orphan, and the
  // next prompt would otherwise be rejected by Bedrock.
  return repairToolPairing(windowed);
}
