/**
 * chatStore.prependSessionHistory — unit tests
 *
 * Covers:
 *  1. Prepends messages before existing messages in correct order
 *  2. Existing messages (including streaming) are not modified
 *  3. Duplicate IDs are silently dropped (page-boundary dedup)
 *  4. A no-op call with empty array leaves state unchanged
 *  5. Prepend to a session that has no existing state creates the session slot
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore';

// A valid 33-char alphanumeric SessionId
const SESSION_ID = 'prepend0000000000000000000000000p' as const;

const makeConvMsg = (id: string, type: 'user' | 'assistant' = 'user') => ({
  id,
  type,
  contents: [{ type: 'text' as const, text: `content of ${id}` }],
  timestamp: '2024-01-01T00:00:00.000Z',
});

describe('chatStore.prependSessionHistory', () => {
  beforeEach(() => {
    useChatStore.setState({ sessions: {}, activeSessionId: null, lastStreamCompletedAt: {} });
  });

  // 1. Prepends before existing messages
  it('places older messages before existing messages', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            {
              id: 'recent-1',
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

    useChatStore
      .getState()
      .prependSessionHistory(SESSION_ID, [makeConvMsg('older-1'), makeConvMsg('older-2')]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs[0].id).toBe('older-1');
    expect(msgs[1].id).toBe('older-2');
    expect(msgs[2].id).toBe('recent-1');
    expect(msgs).toHaveLength(3);
  });

  // 2. Existing streaming message is preserved intact
  it('does not touch an existing streaming message', () => {
    const streamingMessage = {
      id: 'streaming-now',
      type: 'assistant' as const,
      contents: [{ type: 'text' as const, text: 'partial response...' }],
      timestamp: new Date(),
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

    useChatStore.getState().prependSessionHistory(SESSION_ID, [makeConvMsg('old-1')]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    const streamingMsg = msgs.find((m) => m.id === 'streaming-now');
    expect(streamingMsg?.isStreaming).toBe(true);
    expect(streamingMsg?.contents[0]).toEqual({ type: 'text', text: 'partial response...' });
  });

  // 3. Duplicate IDs are dropped
  it('drops messages whose IDs already exist in the current list', () => {
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [
            {
              id: 'shared-id',
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

    useChatStore.getState().prependSessionHistory(SESSION_ID, [
      makeConvMsg('truly-new'),
      makeConvMsg('shared-id'), // duplicate — must be dropped
    ]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe('truly-new');
    expect(msgs[1].id).toBe('shared-id');
    // Only one entry with shared-id
    expect(msgs.filter((m) => m.id === 'shared-id')).toHaveLength(1);
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

  // 5. Prepend to a session with no prior state initialises it
  it('creates the session slot when the session has no prior state', () => {
    useChatStore.setState({ sessions: {} });

    useChatStore.getState().prependSessionHistory(SESSION_ID, [makeConvMsg('first-ever')]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('first-ever');
  });

  // 6. assistant type message is mapped correctly
  it('maps assistant type messages correctly', () => {
    useChatStore.setState({ sessions: {} });

    useChatStore.getState().prependSessionHistory(SESSION_ID, [makeConvMsg('asst-1', 'assistant')]);

    const msgs = useChatStore.getState().sessions[SESSION_ID]?.messages ?? [];
    expect(msgs[0].type).toBe('assistant');
    expect(msgs[0].isStreaming).toBe(false);
  });
});
