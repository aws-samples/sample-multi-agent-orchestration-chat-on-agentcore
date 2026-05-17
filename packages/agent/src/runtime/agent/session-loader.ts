/**
 * Session history loader
 *
 * Loads saved messages from session storage for conversation continuity.
 */

import type { Message } from '@strands-agents/sdk';
import { logger } from '../../libs/logger/index.js';
import type { SessionStorage, SessionConfig } from '../../services/session/types.js';

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

  // Trim the tail: if the last message is an orphaned toolUseBlock (no following toolResultBlock),
  // it must be removed — Bedrock rejects a toolUse at the end of history that has no paired result.
  // Walk backward from the end and remove any trailing orphaned toolUse / unexpected toolResult.
  let endIndex = messages.length; // exclusive upper bound for slice
  while (endIndex > trimIndex) {
    const lastMsg = messages[endIndex - 1];
    if (!lastMsg) break;

    // Trailing toolResultBlock with no preceding toolUseBlock in the window — invalid.
    const lastHasToolResult = lastMsg.content.some((b) => b.type === 'toolResultBlock');
    if (lastHasToolResult) {
      endIndex--;
      continue;
    }

    // Trailing toolUseBlock with no following toolResultBlock — orphaned, must remove.
    const lastHasToolUse = lastMsg.content.some((b) => b.type === 'toolUseBlock');
    if (lastHasToolUse) {
      const followingMsg = messages[endIndex]; // the message that would follow lastMsg
      const followingHasToolResult = followingMsg?.content.some(
        (b) => b.type === 'toolResultBlock'
      );
      if (!followingHasToolResult) {
        // Orphaned toolUse at the end — remove it.
        endIndex--;
        continue;
      }
    }

    break; // valid tail
  }

  if (endIndex <= trimIndex) {
    // All candidate messages were invalid (e.g. entire window is orphaned tool calls).
    logger.warn(`Session history: no valid tail found after trimming — returning full history`);
    return messages;
  }

  const truncated = messages.slice(trimIndex, endIndex);
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

  if (windowSize !== undefined) {
    return applyWindowTruncation(messages, windowSize);
  }

  return messages;
}
