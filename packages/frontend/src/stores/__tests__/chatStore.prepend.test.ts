/**
 * chatStore.prependSessionHistory — unit tests
 *
 * The action merges incoming messages into the existing list by:
 *  - Deduplicating by message ID (existing copy wins on collision)
 *  - Sorting all settled messages by timestamp ascending (stable; ID tie-break)
 *  - Keeping in-flight streaming messages at the end, unmodified
 *
 * Covers:
 *  1. New messages are inserted in timestamp order, not blindly prepended
 *  2. Existing streaming messages are preserved intact at the end
 *  3. Duplicate IDs are silently dropped (page-boundary dedup)
 *  4. A no-op call with empty array leaves state unchanged
 *  5. Merge to a session with no existing state creates the session slot
 *  6. assistant type is mapped correctly
 *  7. Messages with interleaved timestamps are placed in correct chronological order
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

// A valid 33-char alphanumeric SessionId
const SESSION_ID = 'prepend0000000000000000000000000p' as const;

const makeConvMsg = (
  id: string,
  type: 'user' | 'assistant' = 'user',
  isoTimestamp = '2024-01-01T00:00:00.000Z'
) => ({
  id,
  type,
  contents: [{ type: 'text' as const, text: `content of ${id}` }],
  timestamp: isoTimestamp,
});

describe('chatStore.prependSessionHistory', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {}, activeSessionId: null, lastStreamCompletedAt: {} });
  });

  // 1. Timestamp-sorted merge (not naive prepend)
  it('places messages in timestamp order regardless of call order', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            {
              id: 'recent-1',
              type: 'user',
              contents: [],
              timestamp: new Date('2024-01-03T00:00:00.000Z'),
              isStreaming: false,
            },
          ],
          isLoading: false,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [
        makeConvMsg('older-2', 'user', '2024-01-02T00:00:00.000Z'),
        makeConvMsg('older-1', 'user', '2024-01-01T00:00:00.000Z'),
      ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs.map((m) => m.id)).toEqual(['older-1', 'older-2', 'recent-1']);
    expect(msgs).toHaveLength(3);
  });

  // 2. Existing streaming message is preserved intact at the end
  it('does not touch an existing streaming message; it stays at the end', () => {
    const streamingMessage = {
      id: 'streaming-now',
      type: 'assistant' as const,
      contents: [{ type: 'text' as const, text: 'partial response...' }],
      timestamp: new Date('2024-01-04T00:00:00.000Z'),
      isStreaming: true,
    };

    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [streamingMessage],
          isLoading: true,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [
        makeConvMsg('old-1', 'user', '2024-01-01T00:00:00.000Z'),
      ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    // Streaming message stays at the END.
    expect(msgs[msgs.length - 1].id).toBe('streaming-now');
    expect(msgs[msgs.length - 1].isStreaming).toBe(true);
    expect(msgs[msgs.length - 1].contents[0]).toEqual({
      type: 'text',
      text: 'partial response...',
    });
    // Historical message is first.
    expect(msgs[0].id).toBe('old-1');
  });

  // 3. Duplicate IDs are dropped; existing copy is kept
  it('drops incoming messages whose IDs already exist in the current list', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            {
              id: 'shared-id',
              type: 'user',
              contents: [{ type: 'text', text: 'existing copy' }],
              timestamp: new Date('2024-01-02T00:00:00.000Z'),
              isStreaming: false,
            },
          ],
          isLoading: false,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    useChatStore.getState().prependSessionHistory(SESSION_ID, [
      makeConvMsg('truly-new', 'user', '2024-01-01T00:00:00.000Z'),
      makeConvMsg('shared-id', 'user', '2024-01-02T00:00:00.000Z'), // duplicate — must be dropped
    ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs).toHaveLength(2);
    // Only one entry with shared-id, and it's the existing copy.
    expect(msgs.filter((m) => m.id === 'shared-id')).toHaveLength(1);
    expect(msgs.find((m) => m.id === 'shared-id')?.contents[0]).toEqual({
      type: 'text',
      text: 'existing copy',
    });
  });

  // 4. Empty array is a no-op
  it('is a no-op when called with an empty array', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            {
              id: 'existing',
              type: 'user',
              contents: [],
              timestamp: new Date(),
              isStreaming: false,
            },
          ],
          isLoading: false,
          error: null,
          lastUpdated: new Date(),
        },
      },
    });

    useChatStore.getState().prependSessionHistory(SESSION_ID, []);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('existing');
  });

  // 5. Creates session slot when no prior state exists
  it('creates the session slot when the session has no prior state', () => {
    useChatStore.setState({ sessions: {} });

    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [
        makeConvMsg('first-ever', 'user', '2024-01-01T00:00:00.000Z'),
      ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('first-ever');
  });

  // 6. assistant type is mapped correctly
  it('maps assistant type messages correctly', () => {
    useChatStore.setState({ sessions: {} });

    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [
        makeConvMsg('asst-1', 'assistant', '2024-01-01T00:00:00.000Z'),
      ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs[0].type).toBe('assistant');
    expect(msgs[0].isStreaming).toBe(false);
  });

  // 7. Interleaved timestamps across multiple merge calls
  it('produces correct chronological order after multiple merge calls', () => {
    useChatStore.setState({ sessions: {} });
    const store = useChatStore.getState();

    // First merge: events from page 1
    store.prependSessionHistory(SESSION_ID, [
      makeConvMsg('e3', 'user', '2024-01-03T00:00:00.000Z'),
      makeConvMsg('e5', 'user', '2024-01-05T00:00:00.000Z'),
    ]);
    // Second merge: events from page 2 (interleaved timestamps)
    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [
        makeConvMsg('e1', 'user', '2024-01-01T00:00:00.000Z'),
        makeConvMsg('e4', 'user', '2024-01-04T00:00:00.000Z'),
      ]);
    // Third merge: another page
    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [makeConvMsg('e2', 'user', '2024-01-02T00:00:00.000Z')]);

    const ids = (useChatStore.getState().sessions[SESSION_ID]?.messages ?? []).map((m) => m.id);
    expect(ids).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});
