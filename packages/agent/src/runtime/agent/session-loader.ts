/**
 * Session history loader
 *
 * Loads saved messages from session storage for conversation continuity.
 */

import { Message, TextBlock, type ContentBlock } from '@strands-agents/sdk';
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
 * Remove orphaned tool blocks from a loaded conversation history.
 *
 * WHY: messages are persisted one at a time, in real time, as they are added
 * (see SessionPersistenceHook.onMessageAdded → storage.appendMessage). When a
 * long-running agent is interrupted AFTER an assistant `toolUse` block is saved
 * but BEFORE the matching `toolResult` is produced/saved, the stored history
 * ends with an orphaned `toolUse`. On resume, that history is restored and the
 * next user message ("続けてください") is appended after it — so Bedrock sees a
 * `tool_use` with no following `tool_result` and rejects the request with:
 *   "tool_use ids were found without tool_result blocks immediately after".
 *
 * This pass removes, across the whole history (matched by `toolUseId`):
 *   - any `toolUseBlock` that has no matching `toolResultBlock`, and
 *   - any `toolResultBlock` that has no matching `toolUseBlock`.
 *
 * Message COUNT is preserved. A whole message is never dropped, because:
 *   - Dropping a trailing `toolUse`-only assistant message would leave the
 *     preceding `user` message adjacent to the appended resume `user` message —
 *     a NEW Bedrock alternation violation.
 *   - `AgentCoreMemoryStorage.saveMessages` computes new messages via
 *     `messages.slice(existingCount)` against a fresh raw Memory read; keeping
 *     the in-memory count aligned with the stored count avoids save drift.
 * When stripping empties a message's content, a single-space `TextBlock` is
 * substituted (the same fallback `converters.ts` uses) so Bedrock does not
 * reject an empty `content` array.
 *
 * The returned array is a NEW array when anything changed; otherwise the
 * original reference is returned unchanged (cheap no-op for tool-free chats).
 * The input array and its messages are never mutated.
 *
 * NOTE: this only sanitises the in-memory history handed to the Agent. The
 * underlying AgentCore Memory events are NOT modified, so the session-history
 * API the UI reads (GET /sessions/:id/events) still returns the full record.
 */
export function sanitizeOrphanedToolBlocks(messages: Message[]): Message[] {
  // Collect the toolUseIds that have a corresponding partner of the other kind.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') {
        if (block.toolUseId) toolUseIds.add(block.toolUseId);
      } else if (block.type === 'toolResultBlock') {
        if (block.toolUseId) toolResultIds.add(block.toolUseId);
      }
    }
  }

  // Fast path: no tool blocks at all → nothing to do.
  if (toolUseIds.size === 0 && toolResultIds.size === 0) {
    return messages;
  }

  const isOrphan = (block: ContentBlock): boolean => {
    if (block.type === 'toolUseBlock') {
      return !block.toolUseId || !toolResultIds.has(block.toolUseId);
    }
    if (block.type === 'toolResultBlock') {
      return !block.toolUseId || !toolUseIds.has(block.toolUseId);
    }
    return false;
  };

  // Detect whether anything needs stripping before allocating new arrays.
  const hasOrphans = messages.some((m) => m.content.some(isOrphan));
  if (!hasOrphans) {
    return messages;
  }

  let removedCount = 0;
  const sanitized = messages.map((message) => {
    if (!message.content.some(isOrphan)) {
      return message;
    }
    const kept = message.content.filter((block) => !isOrphan(block));
    removedCount += message.content.length - kept.length;
    // Never hand Bedrock an empty content array — substitute a placeholder.
    const content: ContentBlock[] = kept.length > 0 ? kept : [new TextBlock(' ')];
    return new Message({ role: message.role, content });
  });

  logger.warn(
    `Session history: stripped ${removedCount} orphaned tool block(s) (interrupted toolUse/toolResult) from restored history`
  );
  return sanitized;
}

/**
 * Load session history from storage.
 * Returns an empty array if storage or config is not provided.
 *
 * The loaded history is always passed through {@link sanitizeOrphanedToolBlocks}
 * to drop orphaned tool blocks left by an interrupted turn (see that function).
 * This runs unconditionally — BEFORE windowing — because the bug it fixes slips
 * through both the early `length <= windowSize` return and the "no valid trim
 * point" fallback in {@link applyWindowTruncation}.
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
  const loaded = await sessionStorage.loadMessages(sessionConfig);
  logger.info(`Session history restored: ${loaded.length} messages`);

  const messages = sanitizeOrphanedToolBlocks(loaded);

  if (windowSize !== undefined) {
    return applyWindowTruncation(messages, windowSize);
  }

  return messages;
}
