/**
 * sessionStore — events pagination state management tests
 *
 * Covers:
 *  1. Initial pagination state is reset on selectSession
 *  2. loadOlderEvents is a no-op when eventsHasMore is false
 *  3. loadOlderEvents is a no-op when called for a non-active session (race guard)
 *  4. loadOlderEvents prepends events and advances cursor
 *  5. loadOlderEvents resets olderEventsError on retry
 *  6. Session switch clears pagination state
 *  7. clearActiveSession resets all events pagination fields
 *  8. createNewSession resets pagination state
 *  9. Generation counter is incremented on selectSession
 * 10. Stale response (A→B→A) is discarded via generation guard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../sessionStore';

// ---------------------------------------------------------------------------
// Valid IDs
// ---------------------------------------------------------------------------
const SESSION_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa' as const; // 33 chars
const SESSION_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb' as const;

// ---------------------------------------------------------------------------
// Mock dependencies that sessionStore imports
// ---------------------------------------------------------------------------
vi.mock('../../api/sessions', () => ({
  fetchSessions: vi.fn(),
  fetchSessionEventsPage: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: { getState: () => ({ getAgent: () => null, selectAgent: () => {} }) },
}));

vi.mock('../../stores/storageStore', () => ({
  useStorageStore: { getState: () => ({ setAgentWorkingDirectory: () => {} }) },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../i18n', () => ({
  default: { t: (key: string) => key },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const makeMsg = (id: string, ts = '2024-01-01T00:00:00.000Z') => ({
  id,
  type: 'user' as const,
  contents: [{ type: 'text' as const, text: `msg ${id}` }],
  timestamp: ts,
});

const INITIAL_PAGE_RESULT = {
  events: [makeMsg('page1-msg1'), makeMsg('page1-msg2')],
  nextCursor: 'cursor-page-2',
  hasMore: true,
};

const RESET_STATE = {
  sessions: [] as ReturnType<typeof useSessionStore.getState>['sessions'],
  isLoadingSessions: false,
  sessionsError: null,
  hasLoadedOnce: false,
  nextToken: null,
  hasMoreSessions: false,
  isLoadingMoreSessions: false,
  activeSessionId: null,
  sessionEvents: [] as ReturnType<typeof useSessionStore.getState>['sessionEvents'],
  isLoadingEvents: false,
  eventsError: null,
  eventsNextCursor: null,
  eventsHasMore: false,
  isLoadingOlderEvents: false,
  olderEventsError: null,
  eventsLoadGeneration: 0,
  isCreatingSession: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessionStore — events pagination', () => {
  beforeEach(async () => {
    const { fetchSessions, fetchSessionEventsPage, deleteSession } =
      await import('../../api/sessions');
    vi.mocked(fetchSessions).mockResolvedValue({
      sessions: [],
      nextToken: undefined,
      hasMore: false,
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValue(INITIAL_PAGE_RESULT);
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    useSessionStore.setState(RESET_STATE);
    vi.clearAllMocks();

    // Re-apply defaults after clearAllMocks
    vi.mocked(fetchSessions).mockResolvedValue({
      sessions: [],
      nextToken: undefined,
      hasMore: false,
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValue(INITIAL_PAGE_RESULT);
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });

  // 1. Pagination state is set after selectSession completes
  it('sets eventsNextCursor and eventsHasMore after selectSession', async () => {
    await useSessionStore.getState().selectSession(SESSION_A);

    const state = useSessionStore.getState();
    expect(state.eventsNextCursor).toBe('cursor-page-2');
    expect(state.eventsHasMore).toBe(true);
    expect(state.sessionEvents).toHaveLength(2);
  });

  // 2. loadOlderEvents is a no-op when eventsHasMore is false
  it('skips loadOlderEvents when eventsHasMore is false', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      eventsHasMore: false,
      eventsNextCursor: null,
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    expect(fetchSessionEventsPage).not.toHaveBeenCalled();
  });

  // 3. Race guard: loadOlderEvents no-ops for a non-active session
  it('skips loadOlderEvents when called for a session that is no longer active', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');
    useSessionStore.setState({
      activeSessionId: SESSION_B,
      eventsHasMore: true,
      eventsNextCursor: 'cursor-x',
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    expect(fetchSessionEventsPage).not.toHaveBeenCalled();
  });

  // 4. loadOlderEvents prepends events and advances cursor
  it('prepends older events and updates cursor after loadOlderEvents', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('recent-1'), makeMsg('recent-2')],
      eventsHasMore: true,
      eventsNextCursor: 'cursor-page-2',
      isLoadingOlderEvents: false,
    });

    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce({
      events: [makeMsg('older-1'), makeMsg('older-2')],
      nextCursor: 'cursor-page-3',
      hasMore: true,
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    const state = useSessionStore.getState();
    // Older events should appear before recent events in sessionEvents
    expect(state.sessionEvents[0].id).toBe('older-1');
    expect(state.sessionEvents[1].id).toBe('older-2');
    expect(state.sessionEvents[2].id).toBe('recent-1');
    expect(state.sessionEvents).toHaveLength(4);
    expect(state.eventsNextCursor).toBe('cursor-page-3');
    expect(state.eventsHasMore).toBe(true);
    expect(state.isLoadingOlderEvents).toBe(false);
  });

  // 5. loadOlderEvents clears olderEventsError on retry
  it('clears olderEventsError at the start of loadOlderEvents', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      eventsHasMore: true,
      eventsNextCursor: 'cursor-x',
      olderEventsError: 'Previous error',
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce({
      events: [],
      nextCursor: undefined,
      hasMore: false,
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    expect(useSessionStore.getState().olderEventsError).toBeNull();
  });

  // 6. Session switch resets pagination state
  it('resets pagination state when selectSession is called for a new session', async () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      eventsHasMore: true,
      eventsNextCursor: 'stale-cursor',
      sessionEvents: [makeMsg('old')],
    });

    await useSessionStore.getState().selectSession(SESSION_B);

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe(SESSION_B);
    expect(state.eventsNextCursor).toBe('cursor-page-2');
    expect(state.eventsHasMore).toBe(true);
    expect(state.sessionEvents.every((e) => e.id.startsWith('page1'))).toBe(true);
  });

  // 7. clearActiveSession resets all events pagination fields
  it('clears all events pagination state on clearActiveSession', () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('m1')],
      eventsHasMore: true,
      eventsNextCursor: 'cursor',
      isLoadingOlderEvents: false,
      olderEventsError: null,
    });

    useSessionStore.getState().clearActiveSession();

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.sessionEvents).toHaveLength(0);
    expect(state.eventsHasMore).toBe(false);
    expect(state.eventsNextCursor).toBeNull();
    expect(state.isLoadingOlderEvents).toBe(false);
    expect(state.olderEventsError).toBeNull();
  });

  // 8. createNewSession resets pagination state
  it('resets pagination state when a new session is created', () => {
    useSessionStore.setState({
      eventsHasMore: true,
      eventsNextCursor: 'cursor',
      sessionEvents: [makeMsg('old')],
    });

    useSessionStore.getState().createNewSession();

    const state = useSessionStore.getState();
    expect(state.eventsHasMore).toBe(false);
    expect(state.eventsNextCursor).toBeNull();
    expect(state.sessionEvents).toHaveLength(0);
  });

  // 9. Generation counter is incremented each selectSession call
  it('increments eventsLoadGeneration on each selectSession call', async () => {
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(0);
    await useSessionStore.getState().selectSession(SESSION_A);
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(1);
    await useSessionStore.getState().selectSession(SESSION_A);
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(2);
  });

  // 10. A→B→A stale response is discarded by generation guard
  it('discards stale A→B→A response: second selectSession(A) wins', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    let resolveFirst!: (v: typeof INITIAL_PAGE_RESULT) => void;
    const firstCallPromise = new Promise<typeof INITIAL_PAGE_RESULT>((res) => {
      resolveFirst = res;
    });

    const staleResult = {
      events: [makeMsg('stale-event')],
      nextCursor: 'stale-cursor',
      hasMore: true,
    };
    const freshResult = {
      events: [makeMsg('fresh-event')],
      nextCursor: 'fresh-cursor',
      hasMore: false,
    };

    // First call (session A) is delayed; second call (session A again) resolves immediately.
    vi.mocked(fetchSessionEventsPage)
      .mockReturnValueOnce(firstCallPromise) // delayed first load
      .mockResolvedValueOnce(freshResult); // immediate second load

    // Start first load (delayed) — do NOT await.
    const firstLoad = useSessionStore.getState().selectSession(SESSION_A);
    // Switch to session B in between.
    await useSessionStore.getState().selectSession(SESSION_B);
    // Switch back to A — this is the "fresh" second load.
    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce(freshResult);
    await useSessionStore.getState().selectSession(SESSION_A);

    // Now resolve the delayed stale first load.
    resolveFirst(staleResult);
    await firstLoad;

    // The fresh second load's result must win; stale result must be discarded.
    const state = useSessionStore.getState();
    expect(state.sessionEvents.some((e) => e.id === 'stale-event')).toBe(false);
    expect(state.sessionEvents.some((e) => e.id === 'fresh-event')).toBe(true);
  });
});
