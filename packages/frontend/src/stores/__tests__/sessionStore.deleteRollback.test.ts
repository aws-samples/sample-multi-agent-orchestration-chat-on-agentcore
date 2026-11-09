/**
 * sessionStore — delete rollback must not duplicate sessions.
 *
 * A failed delete now keeps the DynamoDB row (Memory is deleted first), so a
 * list refresh that lands while the DELETE is in flight re-adds the session.
 * Verified live: a bulk delete of 3 sessions where 2 failed showed those 2
 * twice. The rollback must only restore sessions that are actually missing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SESSION_A = 'aaaaaaaaaa0123456789ABCDEFGHIJ012';
const SESSION_B = 'bbbbbbbbbb0123456789ABCDEFGHIJ012';

const deleteSessionApi = vi.fn();
vi.mock('../../api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/sessions')>()),
  deleteSession: (id: string) => deleteSessionApi(id),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { useSessionStore } from '../sessionStore';

const session = (sessionId: string) =>
  ({ sessionId, title: sessionId, createdAt: '', updatedAt: '' }) as never;

/** Simulate a list refresh landing mid-request: the server still has the row. */
const refreshDuringRequest = (ids: string[]) => {
  useSessionStore.setState((s) => ({
    sessions: [...ids.map(session), ...s.sessions.filter((x) => !ids.includes(x.sessionId))],
  }));
};

describe('sessionStore delete rollback', () => {
  beforeEach(() => {
    deleteSessionApi.mockReset();
    useSessionStore.setState({ sessions: [session(SESSION_A), session(SESSION_B)] });
  });

  it('bulk delete does not duplicate a failed session that a refresh already restored', async () => {
    deleteSessionApi.mockImplementation(async (id: string) => {
      refreshDuringRequest([SESSION_A]);
      if (id === SESSION_A) throw new Error('partially deleted');
    });
    await useSessionStore.getState().deleteMultipleSessions([SESSION_A, SESSION_B]);
    const ids = useSessionStore.getState().sessions.map((s) => s.sessionId);
    expect(ids.filter((id) => id === SESSION_A)).toHaveLength(1);
  });

  it('single delete does not duplicate when a refresh already restored the session', async () => {
    deleteSessionApi.mockImplementation(async () => {
      refreshDuringRequest([SESSION_A]);
      throw new Error('partially deleted');
    });
    await expect(useSessionStore.getState().deleteSession(SESSION_A)).rejects.toThrow();
    const ids = useSessionStore.getState().sessions.map((s) => s.sessionId);
    expect(ids.filter((id) => id === SESSION_A)).toHaveLength(1);
  });

  it('still restores a failed session that is missing from the list', async () => {
    deleteSessionApi.mockRejectedValue(new Error('partially deleted'));
    await useSessionStore.getState().deleteMultipleSessions([SESSION_A]);
    expect(useSessionStore.getState().sessions.map((s) => s.sessionId)).toContain(SESSION_A);
  });
});
