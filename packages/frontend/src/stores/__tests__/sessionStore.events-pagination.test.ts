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
// vi.mock is hoisted; factories must NOT reference variables defined later
// in the module. Configured mock return values are set in beforeEach instead.
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
// Helpers (defined AFTER vi.mock so the hoisted factories can't reference them)
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
      isCreatingSession: false,
    });
    vi.clearAllMocks();

    // Re-apply mock defaults after clearAllMocks
    vi.mocked(fetchSessions).mockResolvedValue({
      sessions: [],
      nextToken: undefined,
      hasMore: false,
    });
    vi.mocked(fetchSessionEventsPage).mockResolvedValue(INITIAL_PAGE_RESULT);
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });

  // 1. Pagination state is reset when selectSession completes
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

  // 3. Race guard: loadOlderEvents is a no-op for a non-active session
  it('skips loadOlderEvents when called for a session that is no longer active', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');
    useSessionStore.setState({
      activeSessionId: SESSION_B, // different session is active
      eventsHasMore: true,
      eventsNextCursor: 'cursor-x',
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A); // SESSION_A is not active

    expect(fetchSessionEventsPage).not.toHaveBeenCalled();
  });

  // 4. loadOlderEvents prepends events and advances cursor
  it('prepends older events and updates cursor after loadOlderEvents', async () => {
    const { fetchSessionEventsPage } = await import('../../api/sessions');

    // Set initial state: 2 recent events, cursor available
    useSessionStore.setState({
      activeSessionId: SESSION_A,
      sessionEvents: [makeMsg('recent-1'), makeMsg('recent-2')],
      eventsHasMore: true,
      eventsNextCursor: 'cursor-page-2',
      isLoadingOlderEvents: false,
    });

    // Override mock to return a second page
    vi.mocked(fetchSessionEventsPage).mockResolvedValueOnce({
      events: [makeMsg('older-1'), makeMsg('older-2')],
      nextCursor: 'cursor-page-3',
      hasMore: true,
    });

    await useSessionStore.getState().loadOlderEvents(SESSION_A);

    const state = useSessionStore.getState();
    // Older events prepended: [older-1, older-2, recent-1, recent-2]
    expect(state.sessionEvents[0].id).toBe('older-1');
    expect(state.sessionEvents[1].id).toBe('older-2');
    expect(state.sessionEvents[2].id).toBe('recent-1');
    expect(state.sessionEvents).toHaveLength(4);
    expect(state.eventsNextCursor).toBe('cursor-page-3');
    expect(state.eventsHasMore).toBe(true);
    expect(state.isLoadingOlderEvents).toBe(false);
  });

  // 5. loadOlderEvents clears olderEventsError on the next attempt
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

  // 6. Session switch (selectSession) resets pagination state for the new session
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
    // Stale cursor must be replaced by the new page's cursor
    expect(state.eventsNextCursor).toBe('cursor-page-2');
    expect(state.eventsHasMore).toBe(true);
    // Old session's events must not bleed over
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
});
