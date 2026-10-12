/**
 * Session Loader Unit Tests
 *
 * Tests for loadSessionHistory() which loads saved messages
 * from session storage for conversation continuity.
 *
 * Also tests applyWindowTruncation() which pre-truncates loaded history
 * to prevent 400K+ token context windows (fix for Issue #357).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { SessionStorage, SessionConfig } from '../../../services/session/types.js';
import type { IdentityId, SessionId } from '@moca/core';

// Mock logger to suppress output during tests
jest.unstable_mockModule('../../../config/index.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  config: {},
}));

const { loadSessionHistory, applyWindowTruncation, sanitizeOrphanedToolBlocks } = await import(
  '../session-loader.js'
);

/** Create a minimal mock message object for testing (avoids importing ESM SDK) */
function createMockMessage(role: string, text: string) {
  return { role, content: [{ type: 'textBlock', text }] };
}

function createToolUseMessage(toolUseId: string) {
  return {
    role: 'assistant',
    content: [{ type: 'toolUseBlock', toolUseId, name: 'test', input: {} }],
  };
}

function createToolResultMessage(toolUseId: string) {
  return {
    role: 'user',
    content: [{ type: 'toolResultBlock', toolUseId, status: 'success', content: [] }],
  };
}

/** Assistant message mixing a text block with a toolUse block (single message). */
function createTextThenToolUseMessage(text: string, toolUseId: string) {
  return {
    role: 'assistant',
    content: [
      { type: 'textBlock', text },
      { type: 'toolUseBlock', toolUseId, name: 'test', input: {} },
    ],
  };
}

// ---------------------------------------------------------------------------
// loadSessionHistory (existing + windowSize extension)
// ---------------------------------------------------------------------------

describe('loadSessionHistory', () => {
  const mockMessages = [createMockMessage('user', 'Hello'), createMockMessage('assistant', 'Hi!')];

  const mockSessionConfig: SessionConfig = {
    sessionId: 'test-session-id' as SessionId,
    actorId: 'test-actor-id' as IdentityId,
  };

  let mockSessionStorage: jest.Mocked<SessionStorage>;

  beforeEach(() => {
    mockSessionStorage = {
      loadMessages: jest.fn<() => Promise<unknown[]>>().mockResolvedValue(mockMessages),
      saveMessages: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      appendMessage: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      clearSession: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SessionStorage>;
  });

  it('should return empty array when sessionStorage is undefined', async () => {
    const result = await loadSessionHistory(undefined, mockSessionConfig);
    expect(result).toEqual([]);
  });

  it('should return empty array when sessionConfig is undefined', async () => {
    const result = await loadSessionHistory(mockSessionStorage, undefined);
    expect(result).toEqual([]);
  });

  it('should return empty array when both parameters are undefined', async () => {
    const result = await loadSessionHistory(undefined, undefined);
    expect(result).toEqual([]);
  });

  it('should load messages from session storage when both parameters are provided', async () => {
    const result = await loadSessionHistory(mockSessionStorage, mockSessionConfig);

    expect(mockSessionStorage.loadMessages).toHaveBeenCalledWith(mockSessionConfig);
    expect(result).toEqual(mockMessages);
  });

  it('should return empty array when storage has no messages', async () => {
    mockSessionStorage.loadMessages.mockResolvedValue([]);

    const result = await loadSessionHistory(mockSessionStorage, mockSessionConfig);

    expect(result).toEqual([]);
  });

  it('should propagate errors from session storage', async () => {
    mockSessionStorage.loadMessages.mockRejectedValue(new Error('Storage unavailable'));

    await expect(loadSessionHistory(mockSessionStorage, mockSessionConfig)).rejects.toThrow(
      'Storage unavailable'
    );
  });

  it('should return all messages when windowSize is undefined (backward compatibility)', async () => {
    const result = await loadSessionHistory(mockSessionStorage, mockSessionConfig, undefined);
    expect(result).toEqual(mockMessages);
  });

  it('should return all messages when message count is within windowSize', async () => {
    const result = await loadSessionHistory(mockSessionStorage, mockSessionConfig, 10);
    expect(result).toEqual(mockMessages);
    expect(result).toHaveLength(2);
  });

  it('should truncate messages when message count exceeds windowSize', async () => {
    // 20 messages in storage, windowSize=4 → keep last 4
    const manyMessages = Array.from({ length: 10 }, (_, i) => [
      createMockMessage('user', `Q${i + 1}`),
      createMockMessage('assistant', `A${i + 1}`),
    ]).flat();
    mockSessionStorage.loadMessages.mockResolvedValue(manyMessages as unknown as never[]);

    const result = await loadSessionHistory(mockSessionStorage, mockSessionConfig, 4);

    expect(result).toHaveLength(4);
    // Should keep the last 4 messages
    expect((result[0] as ReturnType<typeof createMockMessage>).content[0].text).toBe('Q9');
    expect((result[1] as ReturnType<typeof createMockMessage>).content[0].text).toBe('A9');
    expect((result[2] as ReturnType<typeof createMockMessage>).content[0].text).toBe('Q10');
    expect((result[3] as ReturnType<typeof createMockMessage>).content[0].text).toBe('A10');
  });
});

// ---------------------------------------------------------------------------
// applyWindowTruncation
// ---------------------------------------------------------------------------

describe('applyWindowTruncation', () => {
  // ---------------------------------------------------------------------------
  // Basic truncation
  // ---------------------------------------------------------------------------

  it('returns messages unchanged when count is within windowSize', () => {
    const messages = [
      createMockMessage('user', 'Q1'),
      createMockMessage('assistant', 'A1'),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 10);
    expect(result).toBe(messages); // same reference — no copy
  });

  it('returns messages unchanged when count equals windowSize', () => {
    const messages = Array.from({ length: 4 }, (_, i) => [
      createMockMessage('user', `Q${i + 1}`),
      createMockMessage('assistant', `A${i + 1}`),
    ]).flat() as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 8);
    expect(result).toBe(messages);
  });

  it('truncates to last windowSize messages for plain text history', () => {
    const messages = Array.from({ length: 10 }, (_, i) => [
      createMockMessage('user', `Q${i + 1}`),
      createMockMessage('assistant', `A${i + 1}`),
    ]).flat() as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 4);

    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('user');
    expect(result[result.length - 1].role).toBe('assistant');
  });

  it('first message after truncation always has role "user" for even windowSize', () => {
    const messages = Array.from({ length: 20 }, (_, i) => [
      createMockMessage('user', `Q${i + 1}`),
      createMockMessage('assistant', `A${i + 1}`),
    ]).flat() as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 6);
    expect(result[0].role).toBe('user');
  });

  it('returns a new array (does not modify the original)', () => {
    const messages = Array.from({ length: 10 }, (_, i) => [
      createMockMessage('user', `Q${i + 1}`),
      createMockMessage('assistant', `A${i + 1}`),
    ]).flat() as unknown as Parameters<typeof applyWindowTruncation>[0];

    const originalLength = messages.length;
    const result = applyWindowTruncation(messages, 4);

    expect(messages).toHaveLength(originalLength); // original unchanged
    expect(result).not.toBe(messages); // new array
  });

  // ---------------------------------------------------------------------------
  // toolUse / toolResult pair safety
  // ---------------------------------------------------------------------------

  it('does not split a toolUse/toolResult pair across the cut boundary', () => {
    // Build: [...plain pairs..., user(Q), assistant(toolUse), user(toolResult), assistant(Done)]
    //        indices: 0-3 plain, 4=user(Q), 5=assistant(toolUse), 6=user(toolResult), 7=assistant(Done)
    //
    // windowSize=3 → ideal trimIndex = 8 - 3 = 5 (assistant with toolUse)
    //
    // Algorithm (fixed):
    //   trimIndex=5 (toolUse): next[6] IS toolResult → valid pair at boundary → valid cut point → break
    //   Result: slice from index 5 → [assistant(toolUse), user(toolResult), assistant(Done)] (3 messages)
    //
    // The window starts with toolUse+toolResult pair intact — this is correct.
    const toolUseId = 'tu-1';
    const messages = [
      createMockMessage('user', 'Q1'),
      createMockMessage('assistant', 'A1'),
      createMockMessage('user', 'Q2'),
      createMockMessage('assistant', 'A2'),
      createMockMessage('user', 'Use the tool'),
      createToolUseMessage(toolUseId), // index 5 — toolUse
      createToolResultMessage(toolUseId), // index 6 — toolResult (paired with index 5)
      createMockMessage('assistant', 'Done'),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 3);

    // Should not start with toolResultBlock
    const firstHasToolResult = result[0].content.some(
      (b: { type: string }) => b.type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    // When the window starts with toolUseBlock, the NEXT message must be toolResultBlock
    // (the pair must be intact at the window boundary)
    const firstHasToolUse = result[0].content.some(
      (b: { type: string }) => b.type === 'toolUseBlock'
    );
    if (firstHasToolUse) {
      expect(result.length).toBeGreaterThan(1);
      const secondHasToolResult = result[1].content.some(
        (b: { type: string }) => b.type === 'toolResultBlock'
      );
      // The paired toolResult must follow immediately
      expect(secondHasToolResult).toBe(true);
    }
  });

  it('skips an orphaned toolUseBlock (no paired toolResult follows)', () => {
    // Build: [...plain..., user(Q), assistant(toolUse-ORPHAN), user(Q2), assistant(A2)]
    //        The assistant(toolUse-ORPHAN) has NO following toolResultBlock.
    //        indices: 0-3 plain, 4=user(Q), 5=assistant(toolUse, NO pair), 6=user(Q2), 7=assistant(A2)
    //
    // windowSize=4 → ideal trimIndex = 8 - 4 = 4 (user(Q))
    //   trimIndex=4 (user): no toolResult, no toolUse → valid cut point → break
    //   Result: slice from index 4 → [user(Q), assistant(toolUse-ORPHAN), user(Q2), assistant(A2)]
    //
    // windowSize=3 → ideal trimIndex = 8 - 3 = 5 (assistant(toolUse-ORPHAN))
    //   trimIndex=5 (toolUse): next[6]=user(Q2) is NOT toolResult → orphaned toolUse → skip
    //   trimIndex=6 (user(Q2)): no toolResult, no toolUse → valid cut point → break
    //   Result: slice from index 6 → [user(Q2), assistant(A2)] (2 messages, shorter than windowSize)
    const orphanToolUseId = 'tu-orphan';
    const messages = [
      createMockMessage('user', 'Q1'),
      createMockMessage('assistant', 'A1'),
      createMockMessage('user', 'Q2'),
      createMockMessage('assistant', 'A2'),
      createMockMessage('user', 'Try the tool'),
      createToolUseMessage(orphanToolUseId), // index 5 — orphaned toolUse (no toolResult follows)
      createMockMessage('user', 'Q3'),
      createMockMessage('assistant', 'A3'),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 3);

    // Must never start with the orphaned toolUseBlock
    const firstHasToolUse = result[0].content.some(
      (b: { type: string }) => b.type === 'toolUseBlock'
    );
    expect(firstHasToolUse).toBe(false);

    // Must never start with toolResultBlock
    const firstHasToolResult = result[0].content.some(
      (b: { type: string }) => b.type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    // trimIndex should have advanced past the orphaned toolUse to index 6
    expect(result[0].role).toBe('user');
  });

  it('toolUse followed by toolResult followed by orphaned toolUse — skips orphan', () => {
    // Sequence: user, assistant(toolUse1), user(toolResult1), assistant(toolUse2-ORPHAN), user(Q), assistant(A)
    // indices:   0      1                   2                   3                           4        5
    //
    // windowSize=4 → ideal trimIndex = 6 - 4 = 2 (toolResult)
    //   trimIndex=2 (toolResult): must skip → trimIndex=3
    //   trimIndex=3 (toolUse2-ORPHAN): next[4]=user(Q) is NOT toolResult → skip → trimIndex=4
    //   trimIndex=4 (user(Q)): valid → break
    //   Result: [user(Q), assistant(A)] (2 messages)
    const toolUseId1 = 'tu-1';
    const orphanToolUseId = 'tu-orphan';
    const messages = [
      createMockMessage('user', 'Q1'),
      createToolUseMessage(toolUseId1), // index 1
      createToolResultMessage(toolUseId1), // index 2 — paired
      createToolUseMessage(orphanToolUseId), // index 3 — orphaned (next is NOT toolResult)
      createMockMessage('user', 'Q2'),
      createMockMessage('assistant', 'A2'),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    const result = applyWindowTruncation(messages, 4);

    // Must not start with toolResultBlock or orphaned toolUseBlock
    const firstHasToolResult = result[0].content.some(
      (b: { type: string }) => b.type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);

    const firstHasToolUse = result[0].content.some(
      (b: { type: string }) => b.type === 'toolUseBlock'
    );
    // If first is toolUse, its pair must follow
    if (firstHasToolUse) {
      expect(result.length).toBeGreaterThan(1);
      const secondHasToolResult = result[1].content.some(
        (b: { type: string }) => b.type === 'toolResultBlock'
      );
      expect(secondHasToolResult).toBe(true);
    }
  });

  it('does not start with a toolResultBlock even when ideal trim lands on it', () => {
    const toolUseId = 'tu-1';
    const messages = [
      createMockMessage('user', 'Q1'),
      createMockMessage('assistant', 'A1'),
      createToolUseMessage(toolUseId), // index 2
      createToolResultMessage(toolUseId), // index 3 — ideal trimIndex for windowSize=5
      createMockMessage('assistant', 'Done'),
      createMockMessage('user', 'Q2'),
      createMockMessage('assistant', 'A2'),
      createMockMessage('user', 'Q3'),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    // messages.length=8, windowSize=5 → ideal trimIndex=3 (toolResult)
    // Must skip 3 → trimIndex=4 (plain assistant 'Done')
    const result = applyWindowTruncation(messages, 5);

    const firstHasToolResult = result[0].content.some(
      (b: { type: string }) => b.type === 'toolResultBlock'
    );
    expect(firstHasToolResult).toBe(false);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  // ---------------------------------------------------------------------------
  // Fallback: no valid trim point
  // ---------------------------------------------------------------------------

  it('returns the full history when no valid trim point exists', () => {
    // Entire history is a single toolUse → toolResult chain with no safe cut
    const toolUseId = 'tu-only';
    const messages = [
      createToolUseMessage(toolUseId),
      createToolResultMessage(toolUseId),
    ] as unknown as Parameters<typeof applyWindowTruncation>[0];

    // windowSize=1 → trimIndex=1 (toolResult), trimIndex advances to 2 → out of bounds
    const result = applyWindowTruncation(messages, 1);

    // Falls back to full history
    expect(result).toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// sanitizeOrphanedToolBlocks
//
// Reproduces the crash reported when resuming a session that was interrupted
// AFTER a toolUse was persisted but BEFORE its toolResult: on resume the
// restored history ends with an orphaned toolUse, and appending the next user
// message ("続けてください") yields a tool_use with no following tool_result —
// Bedrock rejects it with
//   "tool_use ids were found without tool_result blocks immediately after".
// ---------------------------------------------------------------------------

describe('sanitizeOrphanedToolBlocks', () => {
  type Block = { type: string; toolUseId?: string; text?: string };
  type Msg = { role: string; content: Block[] };
  const cast = (m: ReturnType<typeof createMockMessage>[]) =>
    m as unknown as Parameters<typeof sanitizeOrphanedToolBlocks>[0];
  const blocks = (msg: unknown): Block[] => (msg as Msg).content;

  it('returns the array unchanged (same reference) when there are no tool blocks', () => {
    const messages = cast([
      createMockMessage('user', 'Hello'),
      createMockMessage('assistant', 'Hi!'),
    ]);
    const result = sanitizeOrphanedToolBlocks(messages);
    expect(result).toBe(messages);
  });

  it('leaves a matched toolUse/toolResult pair intact', () => {
    const id = 'tu-1';
    const messages = cast([
      createMockMessage('user', 'Use the tool'),
      createToolUseMessage(id) as unknown as ReturnType<typeof createMockMessage>,
      createToolResultMessage(id) as unknown as ReturnType<typeof createMockMessage>,
      createMockMessage('assistant', 'Done'),
    ]);
    const result = sanitizeOrphanedToolBlocks(messages);
    expect(result).toBe(messages); // nothing to strip
    expect(result).toHaveLength(4);
  });

  it('strips a trailing orphaned toolUse (interrupted-after-toolUse case) but keeps the message slot', () => {
    const orphan = 'tu-orphan';
    const messages = cast([
      createMockMessage('user', 'Run it'),
      createToolUseMessage(orphan) as unknown as ReturnType<typeof createMockMessage>,
    ]);

    const result = sanitizeOrphanedToolBlocks(messages);

    // Message COUNT is preserved (do not drop the assistant message — dropping it
    // would leave user → user adjacency once the resume message is appended).
    expect(result).toHaveLength(2);

    // The orphaned toolUse block must be gone.
    const lastBlocks = blocks(result[1]);
    expect(lastBlocks.some((b) => b.type === 'toolUseBlock')).toBe(false);

    // The emptied message keeps a non-empty placeholder block so Bedrock does
    // not reject an empty content array.
    expect(lastBlocks.length).toBeGreaterThan(0);
    expect(lastBlocks.some((b) => b.type === 'textBlock')).toBe(true);
  });

  it('preserves a sibling text block when stripping an orphaned toolUse from the same message', () => {
    const orphan = 'tu-orphan';
    const messages = cast([
      createMockMessage('user', 'Run it'),
      createTextThenToolUseMessage(
        'Let me run that',
        orphan
      ) as unknown as ReturnType<typeof createMockMessage>,
    ]);

    const result = sanitizeOrphanedToolBlocks(messages);

    const lastBlocks = blocks(result[1]);
    // toolUse stripped, original text retained (no placeholder needed).
    expect(lastBlocks.some((b) => b.type === 'toolUseBlock')).toBe(false);
    expect(lastBlocks).toHaveLength(1);
    expect(lastBlocks[0].type).toBe('textBlock');
    expect(lastBlocks[0].text).toBe('Let me run that');
  });

  it('strips a toolResult that has no preceding toolUse', () => {
    const messages = cast([
      createMockMessage('user', 'Hello'),
      createToolResultMessage('tu-missing') as unknown as ReturnType<typeof createMockMessage>,
    ]);

    const result = sanitizeOrphanedToolBlocks(messages);

    const lastBlocks = blocks(result[1]);
    expect(lastBlocks.some((b) => b.type === 'toolResultBlock')).toBe(false);
    expect(lastBlocks.some((b) => b.type === 'textBlock')).toBe(true);
  });

  it('does not mutate the original messages array', () => {
    const orphan = 'tu-orphan';
    const original = cast([
      createMockMessage('user', 'Run it'),
      createToolUseMessage(orphan) as unknown as ReturnType<typeof createMockMessage>,
    ]);
    const before = blocks(original[1]).length;

    sanitizeOrphanedToolBlocks(original);

    // Original assistant message still carries its toolUse block.
    expect(blocks(original[1]).length).toBe(before);
    expect(blocks(original[1]).some((b) => b.type === 'toolUseBlock')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadSessionHistory: orphan sanitisation runs on ALL paths
// (early-return-within-window AND post-truncation), because the original bug
// slipped through both the `messages.length <= windowSize` early return and the
// "no valid trim point" fallback in applyWindowTruncation.
// ---------------------------------------------------------------------------

describe('loadSessionHistory orphaned-toolUse sanitisation', () => {
  const mockSessionConfig: SessionConfig = {
    sessionId: 'test-session-id' as SessionId,
    actorId: 'test-actor-id' as IdentityId,
  };

  function buildStorage(messages: unknown[]): jest.Mocked<SessionStorage> {
    return {
      loadMessages: jest.fn<() => Promise<unknown[]>>().mockResolvedValue(messages),
      saveMessages: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      appendMessage: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      clearSession: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SessionStorage>;
  }

  it('removes a trailing orphaned toolUse even when history is within windowSize', async () => {
    // 2 messages, windowSize=40 → hits the early `length <= windowSize` return.
    const storage = buildStorage([
      createMockMessage('user', 'Run it'),
      createToolUseMessage('tu-orphan'),
    ]);

    const result = (await loadSessionHistory(storage, mockSessionConfig, 40)) as unknown as {
      role: string;
      content: { type: string }[];
    }[];

    expect(result).toHaveLength(2);
    const last = result[1].content;
    expect(last.some((b) => b.type === 'toolUseBlock')).toBe(false);
  });

  it('removes a trailing orphaned toolUse even when no valid trim point exists (fallback path)', async () => {
    // windowSize=1 over a tool chain forces the "no valid trim point" fallback,
    // which previously returned the full (unsanitised) history.
    const storage = buildStorage([
      createToolUseMessage('tu-1'),
      createToolResultMessage('tu-1'),
      createToolUseMessage('tu-orphan'),
    ]);

    const result = (await loadSessionHistory(storage, mockSessionConfig, 1)) as unknown as {
      role: string;
      content: { type: string; toolUseId?: string }[];
    }[];

    // The orphaned trailing toolUse must not survive on any path.
    const hasOrphan = result.some((m) =>
      m.content.some((b) => b.type === 'toolUseBlock' && b.toolUseId === 'tu-orphan')
    );
    expect(hasOrphan).toBe(false);
  });
});
