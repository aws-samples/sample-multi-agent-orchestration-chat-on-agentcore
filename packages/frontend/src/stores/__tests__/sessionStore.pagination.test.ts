/**
 * sessionStore — event-history pagination (AC2, AC6, AC7, AC8).
 *
 * Tests:
 *   - selectSession stores initial page cursor/hasMore state.
 *   - loadOlderEvents appends older raw events and updates cursor.
 *   - Stale-response guard: switching sessions while a request is in-flight
 *     discards the response without mixing histories (AC6).
 *   - loadOlderEvents is a no-op when hasMore is false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionStore } from '../sessionStore';
import { useChatStore } from '../chatStore';
import { fetchSessionEvents } from '../../api/sessions';

vi.mock('../../api/sessions', () => ({
  fetchSessionEvents: vi.fn(),
  fetchSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
  deleteSession: vi.fn(),
}));

// Silence toast and i18n in tests.
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../agentStore', () => ({
  useAgentStore: { getState: () => ({ getAgent: () => null, selectAgent: vi.fn() }) },
}));
vi.mock('../storageStore', () => ({
  useStorageStore: { getState: () => ({ setAgentWorkingDirectory: vi.fn() }) },
}));

const SESSION_A = 'sessionAAAAAAAAAAAAAAAAAAAAAAAA001';
const SESSION_B = 'sessionBBBBBBBBBBBBBBBBBBBBBBBB001';

const makeMsg = (id: string, ts: string) => ({
  id,
  type: 'assistant' as const,
  contents: [{ type: 'text' as const, text: `msg-${id}` }],
  timestamp: ts,
});

beforeEach(() => {
  useSessionStore.setState({
    sessions: [
      { sessionId: SESSION_A as never, title: 'A', createdAt: '', updatedAt: '' },
      { sessionId: SESSION_B as never, title: 'B', createdAt: '', updatedAt: '' },
    ],
    activeSessionId: null,
    sessionEvents: [],
    isLoadingEvents: false,
    eventsError: null,
    eventsNextCursor: null,
    eventsHasMore: false,
    isLoadingOlderEvents: false,
    olderEventsError: null,
  } as never);
  useChatStore.setState({ sessions: {}, activeSessionId: null } as never);
  vi.clearAllMocks();
});

describe('selectSession — initial page', () => {
  it('stores eventsNextCursor and eventsHasMore from the API response', async () => {
    vi.mocked(fetchSessionEvents).mockResolvedValueOnce({
      events: [makeMsg('m1', '2024-01-01T10:00:00Z'), makeMsg('m2', '2024-01-01T10:01:00Z')],
      nextCursor: 'cursor-abc',
      hasMore: true,
    } as never);

    await useSessionStore.getState().selectSession(SESSION_A);

    const state = useSessionStore.getState();
    expect(state.eventsNextCursor).toBe('cursor-abc');
    expect(state.eventsHasMore).toBe(true);
    expect(state.sessionEvents).toHaveLength(2);
  });

  it('sets hasMore=false when no nextCursor is returned', async () => {
    vi.mocked(fetchSessionEvents).mockResolvedValueOnce({
      events: [makeMsg('m1', '2024-01-01T10:00:00Z')],
      hasMore: false,
    } as never);

    await useSessionStore.getState().selectSession(SESSION_A);

    expect(useSessionStore.getState().eventsHasMore).toBe(false);
    expect(useSessionStore.getState().eventsNextCursor).toBeNull();
  });
});

describe('loadOlderEvents', () => {
  it('prepends older events and updates cursor state', async () => {
    // Set up initial page state.
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('newer1', '2024-01-01T10:05:00Z')],
      eventsNextCursor: 'cursor-page2',
      eventsHasMore: true,
      isLoadingOlderEvents: false,
    } as never);

    vi.mocked(fetchSessionEvents).mockResolvedValueOnce({
      events: [makeMsg('older1', '2024-01-01T10:00:00Z'), makeMsg('older2', '2024-01-01T10:02:00Z')],
      nextCursor: 'cursor-page3',
      hasMore: true,
    } as never);

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    const state = useSessionStore.getState();
    // Older events are prepended.
    expect(state.sessionEvents[0].id).toBe('older1');
    expect(state.sessionEvents[1].id).toBe('older2');
    expect(state.sessionEvents[2].id).toBe('newer1');
    // Cursor updated for next load.
    expect(state.eventsNextCursor).toBe('cursor-page3');
    expect(state.eventsHasMore).toBe(true);
    expect(state.isLoadingOlderEvents).toBe(false);
  });

  it('sets hasMore=false after the last page', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('m1', '2024-01-01T10:05:00Z')],
      eventsNextCursor: 'cursor-last',
      eventsHasMore: true,
      isLoadingOlderEvents: false,
    } as never);

    vi.mocked(fetchSessionEvents).mockResolvedValueOnce({
      events: [makeMsg('old1', '2024-01-01T10:00:00Z')],
      hasMore: false,
    } as never);

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    expect(useSessionStore.getState().eventsHasMore).toBe(false);
    expect(useSessionStore.getState().eventsNextCursor).toBeNull();
  });

  it('is a no-op when eventsHasMore is false (AC8)', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      eventsHasMore: false,
      eventsNextCursor: null,
      isLoadingOlderEvents: false,
    } as never);

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    expect(fetchSessionEvents).not.toHaveBeenCalled();
  });

  it('deduplicates events by id (AC2)', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('dup1', '2024-01-01T10:05:00Z'), makeMsg('unique1', '2024-01-01T10:06:00Z')],
      eventsNextCursor: 'cursor-page2',
      eventsHasMore: true,
      isLoadingOlderEvents: false,
    } as never);

    vi.mocked(fetchSessionEvents).mockResolvedValueOnce({
      events: [makeMsg('old1', '2024-01-01T10:00:00Z'), makeMsg('dup1', '2024-01-01T10:05:00Z')],
      hasMore: false,
    } as never);

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    const ids = useSessionStore.getState().sessionEvents.map((e) => e.id);
    // dup1 should appear only once.
    expect(ids.filter((id) => id === 'dup1')).toHaveLength(1);
    expect(ids).toContain('old1');
    expect(ids).toContain('unique1');
  });

  // AC6: stale-response guard.
  it('discards older events if the active session changed while loading', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('a1', '2024-01-01T10:05:00Z')],
      eventsNextCursor: 'cursor-page2',
      eventsHasMore: true,
      isLoadingOlderEvents: false,
    } as never);

    let resolveOlderEvents!: (v: unknown) => void;
    vi.mocked(fetchSessionEvents).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOlderEvents = resolve;
      }) as never
    );

    // Start loading older events for SESSION_A (doesn't await yet).
    const loadPromise = useSessionStore.getState().loadOlderEvents(SESSION_A);

    // Switch to SESSION_B before the response arrives.
    useSessionStore.setState({ activeSessionId: SESSION_B } as never);

    // Resolve the older-events response for SESSION_A.
    resolveOlderEvents({
      events: [makeMsg('a-old1', '2024-01-01T10:00:00Z')],
      hasMore: false,
    });
    await loadPromise;

    // SESSION_A's events should NOT include the older events (stale discard).
    const sessionEvents = useSessionStore.getState().sessionEvents;
    expect(sessionEvents.every((e) => e.id !== 'a-old1')).toBe(true);
  });

  it('sets olderEventsError on failure and does not clear existing events', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('existing', '2024-01-01T10:05:00Z')],
      eventsNextCursor: 'cursor-page2',
      eventsHasMore: true,
      isLoadingOlderEvents: false,
    } as never);

    vi.mocked(fetchSessionEvents).mockRejectedValueOnce(new Error('network error'));

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    const state = useSessionStore.getState();
    // Existing events preserved.
    expect(state.sessionEvents[0].id).toBe('existing');
    // Error state set.
    expect(state.olderEventsError).toBeTruthy();
    expect(state.isLoadingOlderEvents).toBe(false);
    // hasMore unchanged so user can retry.
    expect(state.eventsHasMore).toBe(true);
  });
});
