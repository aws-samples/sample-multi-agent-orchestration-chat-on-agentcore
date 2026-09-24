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
 *  7. clearActiveSession resets all events pagination fields (and advances generation)
 *  8. createNewSession resets pagination state (and advances generation)
 *  9. Generation counter is incremented on each selectSession call
 * 10. A→B→A stale selectSession response is discarded via generation guard
 * 11. loadOlderEvents A→B→A: stale success is discarded (generation guard)
 * 12. loadOlderEvents A→B→A: stale error is discarded (generation guard)
 * 13. clearActiveSession advances generation (loadOlderEvents in-flight is discarded)
 * 14. setActiveSessionId advances generation
 * 15. selectSession clears sessionEvents immediately (prevents stale hydration)
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

  // 7. clearActiveSession resets all events pagination fields and advances generation
  it('clears all events pagination state on clearActiveSession and advances generation', () => {
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('m1')],
      eventsHasMore: true,
      eventsNextCursor: 'cursor',
      isLoadingOlderEvents: false,
      olderEventsError: null,
      eventsLoadGeneration: 5,
    });

    useSessionStore.getState().clearActiveSession();

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.sessionEvents).toHaveLength(0);
    expect(state.eventsHasMore).toBe(false);
    expect(state.eventsNextCursor).toBeNull();
    expect(state.isLoadingOlderEvents).toBe(false);
    expect(state.olderEventsError).toBeNull();
    expect(state.eventsLoadGeneration).toBe(6);
  });

  // 8. createNewSession resets pagination state and advances generation
  it('resets pagination state and advances generation when a new session is created', () => {
    useSessionStore.setState({
      eventsHasMore: true,
      eventsNextCursor: 'cursor',
      sessionEvents: [makeMsg('old')],
      eventsLoadGeneration: 3,
    });

    useSessionStore.getState().createNewSession();

    const state = useSessionStore.getState();
    expect(state.eventsHasMore).toBe(false);
    expect(state.eventsNextCursor).toBeNull();
    expect(state.sessionEvents).toHaveLength(0);
    expect(state.eventsLoadGeneration).toBe(4);
  });

  // 9. Generation counter is incremented each selectSession call
  it('increments eventsLoadGeneration on each selectSession call', async () => {
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(0);
    await useSessionStore.getState().selectSession(SESSION_A);
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(1);
    await useSessionStore.getState().selectSession(SESSION_A);
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(2);
  });

  // 10. A→B→A stale selectSession response is discarded
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

    vi.mocked(fetchSessionEventsPage)
      .mockReturnValueOnce(firstCallPromise)
      .mockResolvedValueOnce(freshResult);

    const firstLoad = useSessionStore.getState().selectSession(SESSION_A);
    await useSessionStore.getState().selectSession(SESSION_B);
    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce(freshResult);
    await useSessionStore.getState().selectSession(SESSION_A);

    resolveFirst(staleResult);
    await firstLoad;

    const state = useSessionStore.getState();
    expect(state.sessionEvents.some((e) => e.id === 'stale-event')).toBe(false);
    expect(state.sessionEvents.some((e) => e.id === 'fresh-event')).toBe(true);
  });

  // 11. loadOlderEvents A→B→A: stale success is discarded
  it('loadOlderEvents: stale success is discarded when session changes during in-flight', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    type OlderResult = {
      events: ReturnType<typeof makeMsg>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    let resolveStaleLoad!: (v: OlderResult) => void;
    const staleLoadPromise = new Promise<OlderResult>((res) => {
      resolveStaleLoad = res;
    });

    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('existing-a')],
      eventsHasMore: true,
      eventsNextCursor: 'cursor-a',
      isLoadingOlderEvents: false,
      eventsLoadGeneration: 1,
    });

    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(staleLoadPromise as never);
    const staleLoad = useSessionStore.getState().loadOlderEvents(SESSION_A);

    // Switch to B (advances generation via setState)
    useSessionStore.setState({
      activeSessionId: SESSION_B,
      sessionEvents: [makeMsg('b-event')],
      eventsHasMore: false,
      eventsNextCursor: null,
      isLoadingOlderEvents: false,
      eventsLoadGeneration: 2,
    });

    resolveStaleLoad({
      events: [makeMsg('stale-older')],
      nextCursor: 'stale-cursor',
      hasMore: true,
    });
    await staleLoad;

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe(SESSION_B);
    expect(state.sessionEvents.some((e) => e.id === 'stale-older')).toBe(false);
    expect(state.sessionEvents.some((e) => e.id === 'b-event')).toBe(true);
    expect(state.isLoadingOlderEvents).toBe(false);
  });

  // 12. loadOlderEvents A→B→A: stale error is discarded
  it('loadOlderEvents: stale error is discarded when session changes during in-flight', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    let rejectStaleLoad!: (err: Error) => void;
    const staleLoadPromise = new Promise<never>((_, rej) => {
      rejectStaleLoad = rej;
    });

    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [],
      eventsHasMore: true,
      eventsNextCursor: 'cursor-a',
      isLoadingOlderEvents: false,
      olderEventsError: null,
      eventsLoadGeneration: 1,
    });

    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(staleLoadPromise as never);
    const staleLoad = useSessionStore.getState().loadOlderEvents(SESSION_A);

    useSessionStore.setState({
      activeSessionId: SESSION_B,
      sessionEvents: [],
      eventsHasMore: false,
      eventsNextCursor: null,
      isLoadingOlderEvents: false,
      olderEventsError: null,
      eventsLoadGeneration: 2,
    });

    rejectStaleLoad(new Error('network failure'));
    await staleLoad;

    const state = useSessionStore.getState();
    expect(state.olderEventsError).toBeNull();
    expect(state.activeSessionId).toBe(SESSION_B);
  });

  // 13. clearActiveSession advances generation; in-flight loadOlderEvents is discarded
  it('clearActiveSession advances generation, discarding in-flight loadOlderEvents', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    type OlderResult = {
      events: ReturnType<typeof makeMsg>[];
      nextCursor?: string;
      hasMore: boolean;
    };
    let resolveLoad!: (v: OlderResult) => void;
    const loadPromise = new Promise<OlderResult>((res) => {
      resolveLoad = res;
    });

    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [],
      eventsHasMore: true,
      eventsNextCursor: 'cursor-a',
      isLoadingOlderEvents: false,
      eventsLoadGeneration: 5,
    });

    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(loadPromise as never);
    const inFlight = useSessionStore.getState().loadOlderEvents(SESSION_A);

    useSessionStore.getState().clearActiveSession();
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(6);

    resolveLoad({ events: [makeMsg('orphaned')], hasMore: false });
    await inFlight;

    expect(useSessionStore.getState().sessionEvents.some((e) => e.id === 'orphaned')).toBe(false);
  });

  // 14. setActiveSessionId advances generation
  it('setActiveSessionId advances eventsLoadGeneration', () => {
    useSessionStore.setState({ eventsLoadGeneration: 7 });
    useSessionStore.getState().setActiveSessionId(SESSION_A);
    expect(useSessionStore.getState().eventsLoadGeneration).toBe(8);
  });

  // 15. selectSession clears sessionEvents immediately (before API response)
  it('selectSession clears sessionEvents immediately to prevent stale hydration', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('a-event')],
      eventsHasMore: false,
      eventsNextCursor: null,
      isLoadingOlderEvents: false,
      eventsLoadGeneration: 0,
    });

    let resolveFetchB!: (v: typeof INITIAL_PAGE_RESULT) => void;
    const fetchBPromise = new Promise<typeof INITIAL_PAGE_RESULT>((res) => {
      resolveFetchB = res;
    });
    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(fetchBPromise);

    const loadB = useSessionStore.getState().selectSession(SESSION_B);

    // While in-flight, sessionEvents must be empty (stale A events cleared)
    expect(useSessionStore.getState().sessionEvents).toHaveLength(0);
    expect(useSessionStore.getState().activeSessionId).toBe(SESSION_B);
    expect(useSessionStore.getState().isLoadingEvents).toBe(true);

    resolveFetchB(INITIAL_PAGE_RESULT);
    await loadB;

    expect(useSessionStore.getState().sessionEvents).toHaveLength(2);
  });
});
