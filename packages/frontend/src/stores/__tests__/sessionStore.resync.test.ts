/**
 * sessionStore — catching up an open session after AppSync events were missed
 * (PWA suspended, socket reconnecting; issue #157). AppSync does not replay,
 * so the stored history is re-fetched and merged into what is loaded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionStore, noteLiveMessage, mergeLatestEvents } from '../sessionStore';
import { fetchSessionEvents, fetchSessions } from '../../api/sessions';
import { ApiError } from '../../types/errors';

vi.mock('../../api/sessions', () => ({
  fetchSessionEvents: vi.fn(),
  fetchSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
  deleteSession: vi.fn(),
}));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('../agentStore', () => ({
  useAgentStore: { getState: () => ({ getAgent: () => null, selectAgent: vi.fn() }) },
}));
vi.mock('../storageStore', () => ({
  useStorageStore: { getState: () => ({ setAgentWorkingDirectory: vi.fn() }) },
}));

const SESSION = 'sessionAAAAAAAAAAAAAAAAAAAAAAAA001';
const OTHER = 'sessionBBBBBBBBBBBBBBBBBBBBBBBB001';

const ev = (id: string) => ({
  id,
  type: 'assistant' as const,
  contents: [{ type: 'text' as const, text: id }],
  timestamp: '2026-11-01T00:00:00.000Z',
});
const page = (ids: string[], hasMore = false) => ({
  events: ids.map(ev),
  nextCursor: hasMore ? 'cursor' : undefined,
  hasMore,
});
const loadedIds = () => useSessionStore.getState().sessionEvents.map((e) => e.id);
const fetchMock = vi.mocked(fetchSessionEvents);

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: SESSION,
    sessionEvents: [],
    isLoadingEvents: false,
    eventsNextCursor: null,
    eventsHasMore: false,
  } as never);
  vi.clearAllMocks();
});

describe('mergeLatestEvents', () => {
  it('keeps older pages and appends what is new', () => {
    const merged = mergeLatestEvents(['a', 'b', 'c'].map(ev), ['b', 'c', 'd'].map(ev));
    expect(merged?.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports no overlap when more than a page was missed', () => {
    expect(mergeLatestEvents(['a', 'b'].map(ev), ['x', 'y'].map(ev))).toBeNull();
  });
});

describe('resyncSessionEvents', () => {
  it('back-fills events missed while suspended without dropping older pages', async () => {
    useSessionStore.setState({
      sessionEvents: ['old', 'a', 'b'].map(ev),
      eventsNextCursor: 'older',
      eventsHasMore: true,
    });
    fetchMock.mockResolvedValueOnce(page(['a', 'b', 'c', 'd'], true));

    await useSessionStore.getState().resyncSessionEvents(SESSION);

    expect(loadedIds()).toEqual(['old', 'a', 'b', 'c', 'd']);
    expect(useSessionStore.getState().eventsNextCursor).toBe('older');
    // activeTurnStartedAt / updatedAt may be stale too.
    expect(fetchSessions).toHaveBeenCalled();
  });

  it('starts over from the latest page when the gap is larger than a page', async () => {
    useSessionStore.setState({ sessionEvents: ['a', 'b'].map(ev) });
    fetchMock.mockResolvedValueOnce(page(['x', 'y'], true));

    await useSessionStore.getState().resyncSessionEvents(SESSION);

    expect(loadedIds()).toEqual(['x', 'y']);
    expect(useSessionStore.getState().eventsNextCursor).toBe('cursor');
  });

  it('leaves the event list untouched when nothing changed', async () => {
    const loaded = ['a', 'b'].map(ev);
    useSessionStore.setState({ sessionEvents: loaded });
    fetchMock.mockResolvedValueOnce(page(['a', 'b']));

    await useSessionStore.getState().resyncSessionEvents(SESSION);

    expect(useSessionStore.getState().sessionEvents).toBe(loaded);
  });

  it('refetches when a live message arrived while the fetch was in flight', async () => {
    fetchMock
      .mockImplementationOnce(async () => {
        noteLiveMessage(SESSION); // shown from AppSync, maybe not in this response
        return page(['a']);
      })
      .mockResolvedValueOnce(page(['a', 'b']));

    await useSessionStore.getState().resyncSessionEvents(SESSION);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadedIds()).toEqual(['a', 'b']);
  });

  it('coalesces triggers that fire while a resync is running into one more pass', async () => {
    let release!: () => void;
    fetchMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(page(['a']))))
      )
      .mockResolvedValue(page(['a', 'b']));

    const first = useSessionStore.getState().resyncSessionEvents(SESSION);
    void useSessionStore.getState().resyncSessionEvents(SESSION);
    void useSessionStore.getState().resyncSessionEvents(SESSION);
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadedIds()).toEqual(['a', 'b']);
  });

  it('waits for an in-flight select, then fetches again', async () => {
    let release!: () => void;
    fetchMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(page(['a']))))
      )
      .mockResolvedValueOnce(page(['a', 'b']));

    const select = useSessionStore.getState().selectSession(SESSION);
    const resync = useSessionStore.getState().resyncSessionEvents(SESSION);
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await Promise.all([select, resync]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadedIds()).toEqual(['a', 'b']);
  });

  it('does nothing for a session that is no longer open', async () => {
    useSessionStore.setState({ activeSessionId: OTHER });

    await useSessionStore.getState().resyncSessionEvents(SESSION);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('catches up a session opened while another session was resyncing', async () => {
    let release!: () => void;
    fetchMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(page(['a1']))))
      )
      .mockResolvedValueOnce(page(['b1', 'b2']));

    const first = useSessionStore.getState().resyncSessionEvents(SESSION);
    await vi.waitFor(() => expect(release).toBeDefined());
    useSessionStore.setState({ activeSessionId: OTHER, sessionEvents: [ev('b1')] });
    void useSessionStore.getState().resyncSessionEvents(OTHER);
    release();
    await first;

    expect(fetchMock).toHaveBeenLastCalledWith(OTHER);
    expect(loadedIds()).toEqual(['b1', 'b2']);
  });
});

describe('concurrent writers of sessionEvents', () => {
  it('loading older events keeps newer events a resync appended meanwhile', async () => {
    useSessionStore.setState({
      sessionEvents: ['b', 'c'].map(ev),
      eventsNextCursor: 'older',
      eventsHasMore: true,
    });
    let release!: () => void;
    fetchMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(page(['a']))))
      )
      .mockResolvedValueOnce(page(['b', 'c', 'd']));

    const older = useSessionStore.getState().loadOlderEvents(SESSION);
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    await useSessionStore.getState().resyncSessionEvents(SESSION);
    release();
    await older;

    expect(loadedIds()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a stale selection that fails does not wipe or redirect the newer one', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        set href(v: string) {
          assign(v);
        },
      },
    });
    try {
      let fail!: () => void;
      fetchMock
        .mockImplementationOnce(
          () =>
            new Promise(
              (_, reject) => (fail = () => reject(new ApiError('gone', 404, 'NOT_FOUND')))
            )
        )
        .mockResolvedValueOnce(page(['b1']));

      const stale = useSessionStore.getState().selectSession(SESSION);
      await vi.waitFor(() => expect(fail).toBeDefined(), { timeout: 5000 });
      await useSessionStore.getState().selectSession(OTHER);
      fail();
      await stale;

      expect(useSessionStore.getState().activeSessionId).toBe(OTHER);
      expect(loadedIds()).toEqual(['b1']);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
