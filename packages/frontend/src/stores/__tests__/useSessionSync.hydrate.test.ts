/**
 * useSessionSync hydration-logic regression tests
 *
 * These tests exercise the store-level state transitions that the
 * useSessionSync hook orchestrates, without requiring a DOM environment.
 * They verify the correctness of three behaviours that were found to be
 * buggy in the review:
 *
 *  C1. selectSession clears sessionEvents immediately so that stale events
 *      from a previous session cannot trigger loadSessionHistory for the
 *      new session (tested via selectSession store action — also in
 *      sessionStore.events-pagination.test #15).
 *
 *  C2. Empty first page must be treated as "hydrated":
 *      - After selectSession resolves with 0 events (isLoadingEvents → false,
 *        sessionEvents = []), the hook would see isLoadingEvents=false and
 *        sessionEvents.length=0. With the new logic it marks hydratedForRef
 *        and does NOT call loadSessionHistory. Subsequent loadOlderEvents
 *        additions must reach chatStore via prependSessionHistory.
 *      We simulate this by asserting that sessionStore state after a
 *      zero-event selectSession correctly sets isLoadingEvents=false and
 *      sessionEvents=[].
 *
 *  C3. isLoadingEvents guard: while isLoadingEvents is true, the hook
 *      must not hydrate (sessionEvents may still be empty due to the
 *      pre-load clear). We verify that selectSession sets isLoadingEvents=true
 *      synchronously (before the API response).
 *
 *  C4. Stale session events do not persist after session switch:
 *      selectSession B immediately clears sessionEvents (=0) while
 *      isLoadingEvents=true, regardless of what A had loaded before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../sessionStore';

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

const SESSION_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa' as const;
const SESSION_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBb' as const;

const makeMsg = (id: string) => ({
  id,
  type: 'user' as const,
  contents: [{ type: 'text' as const, text: id }],
  timestamp: '2024-01-01T00:00:00.000Z',
});

describe('useSessionSync hydration logic — store-level regression', () => {
  beforeEach(async () => {
    const { fetchSessions, fetchSessionEventsPage, deleteSession } =
      await import('../../api/sessions');
    vi.mocked(fetchSessions).mockResolvedValue({
      sessions: [],
      nextToken: undefined,
      hasMore: false,
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValue({
      events: [],
      nextCursor: undefined,
      hasMore: false,
    });
    vi.mocked(deleteSession).mockResolvedValue(undefined);

    useSessionStore.setState({
      sessions: [],
      isLoadingSessions: false,
      sessionsError: null,
      hasLoadedOnce: false,
      nextToken: null,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      activeSessionId: null,
      sessionEvents: [],
      isLoadingEvents: false,
      eventsError: null,
      eventsNextCursor: null,
      eventsHasMore: false,
      isLoadingOlderEvents: false,
      olderEventsError: null,
      eventsLoadGeneration: 0,
      isCreatingSession: false,
    });
    vi.clearAllMocks();
    vi.mocked(fetchSessions).mockResolvedValue({
      sessions: [],
      nextToken: undefined,
      hasMore: false,
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValue({
      events: [],
      nextCursor: undefined,
      hasMore: false,
    });
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });

  // C3. isLoadingEvents is true synchronously after selectSession starts
  it('C3: isLoadingEvents becomes true synchronously when selectSession is called', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    let resolveFetch!: (v: {
      events: ReturnType<typeof makeMsg>[];
      nextCursor?: string;
      hasMore: boolean;
    }) => void;
    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      }) as never
    );

    const load = useSessionStore.getState().selectSession(SESSION_A);

    // Synchronously after the call (before API responds), isLoadingEvents must be true.
    expect(useSessionStore.getState().isLoadingEvents).toBe(true);

    // sessionEvents must be empty (cleared by selectSession).
    expect(useSessionStore.getState().sessionEvents).toHaveLength(0);

    resolveFetch({ events: [], hasMore: false });
    await load;

    // After the API response, isLoadingEvents must be false.
    expect(useSessionStore.getState().isLoadingEvents).toBe(false);
  });

  // C2. Empty first page: isLoadingEvents=false, sessionEvents=[] after resolve
  it('C2: empty first page leaves isLoadingEvents=false and sessionEvents=[]', async () => {
    await useSessionStore.getState().selectSession(SESSION_A);

    const state = useSessionStore.getState();
    expect(state.isLoadingEvents).toBe(false);
    expect(state.sessionEvents).toHaveLength(0);
    expect(state.activeSessionId).toBe(SESSION_A);
    // hasMore is false — hook should treat this as "hydrated" (no more pages)
    expect(state.eventsHasMore).toBe(false);
  });

  // C4. Stale A events cleared when B is selected
  it('C4: stale session A events are gone from state immediately after selectSession(B) starts', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    // Load session A with some events.
    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce({
      events: [makeMsg('a1'), makeMsg('a2')],
      nextCursor: undefined,
      hasMore: false,
    });
    await useSessionStore.getState().selectSession(SESSION_A);
    expect(useSessionStore.getState().sessionEvents).toHaveLength(2);

    // Now start loading session B (delayed).
    let resolveFetchB!: (v: {
      events: ReturnType<typeof makeMsg>[];
      nextCursor?: string;
      hasMore: boolean;
    }) => void;
    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(
      new Promise((res) => {
        resolveFetchB = res;
      }) as never
    );

    const loadB = useSessionStore.getState().selectSession(SESSION_B);

    // Synchronously after selectSession(B) is called, A's events must be gone.
    expect(useSessionStore.getState().sessionEvents).toHaveLength(0);
    expect(useSessionStore.getState().activeSessionId).toBe(SESSION_B);
    expect(useSessionStore.getState().isLoadingEvents).toBe(true);

    resolveFetchB({ events: [makeMsg('b1')], hasMore: false });
    await loadB;

    expect(useSessionStore.getState().sessionEvents).toHaveLength(1);
    expect(useSessionStore.getState().sessionEvents[0].id).toBe('b1');
  });

  // C1. Verify: selectSession clears sessionEvents before the API call
  //     (same as test 15 in sessionStore.events-pagination.test.ts, included here
  //     as a cross-reference test to confirm the hydration-guard dependency).
  it('C1: selectSession clears sessionEvents before API response arrives', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    useSessionStore.setState({
      sessionEvents: [makeMsg('stale')],
      activeSessionId: SESSION_A,
    });

    let resolveFetchB!: (v: {
      events: ReturnType<typeof makeMsg>[];
      nextCursor?: string;
      hasMore: boolean;
    }) => void;
    vi.mocked(fetchSessionEventsPage).mockReturnValueOnce(
      new Promise((res) => {
        resolveFetchB = res;
      }) as never
    );

    const loadB = useSessionStore.getState().selectSession(SESSION_B);

    // Stale events from A must be gone immediately.
    expect(useSessionStore.getState().sessionEvents).toHaveLength(0);

    resolveFetchB({ events: [], hasMore: false });
    await loadB;
  });
});
