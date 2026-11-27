import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const warn = jest.fn();
const error = jest.fn();
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn, error, debug: jest.fn() }),
}));

const { TurnLock, TURN_LOCK_LEASE_MS, TURN_LOCK_RENEW_INTERVAL_MS } =
  await import('../turn-lock.js');

const NOW = 1_800_000_000_000;

function makeStore() {
  return {
    acquireTurnLock: jest.fn<() => Promise<unknown>>().mockResolvedValue({ status: 'acquired' }),
    renewTurnLock: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    releaseTurnLock: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

let store: ReturnType<typeof makeStore>;
let now: number;
const lock = () =>
  new TurnLock(store as never, 'identity', 'session', 'req-1', 'machine', new Date(NOW), () => now);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  store = makeStore();
  now = NOW;
});

afterEach(() => jest.useRealTimers());

describe('TurnLock', () => {
  it('claims with a lease from now', () => {
    expect(lock().claim()).toEqual({
      owner: 'req-1',
      runner: 'machine',
      startedAt: new Date(NOW).toISOString(),
      leaseUntil: NOW + TURN_LOCK_LEASE_MS,
    });
  });

  it('renews every interval while held and stops after release', async () => {
    const l = lock();
    await l.acquire();
    now += TURN_LOCK_RENEW_INTERVAL_MS;
    await jest.advanceTimersByTimeAsync(TURN_LOCK_RENEW_INTERVAL_MS);
    expect(store.renewTurnLock).toHaveBeenCalledWith(
      'identity',
      'session',
      'req-1',
      now + TURN_LOCK_LEASE_MS
    );
    await l.release();
    await jest.advanceTimersByTimeAsync(TURN_LOCK_RENEW_INTERVAL_MS * 3);
    expect(store.renewTurnLock).toHaveBeenCalledTimes(1);
  });

  it('does not renew or release a lock it did not get', async () => {
    store.acquireTurnLock.mockResolvedValue({ status: 'held' });
    const l = lock();
    expect(await l.acquire()).toEqual({ status: 'held' });
    await jest.advanceTimersByTimeAsync(TURN_LOCK_RENEW_INTERVAL_MS);
    await l.release();
    expect(store.renewTurnLock).not.toHaveBeenCalled();
    expect(store.releaseTurnLock).not.toHaveBeenCalled();
  });

  it('releases once even when called twice', async () => {
    const l = lock();
    await l.acquire();
    await l.release();
    await l.release();
    expect(store.releaseTurnLock).toHaveBeenCalledTimes(1);
  });

  it('reports DynamoDB failure as unavailable instead of throwing', async () => {
    store.acquireTurnLock.mockRejectedValue(new Error('ddb'));
    expect(await lock().acquire()).toEqual({ status: 'unavailable' });
  });

  it('logs renew failures and keeps renewing', async () => {
    const l = lock();
    await l.acquire();
    store.renewTurnLock.mockRejectedValueOnce(new Error('throttled'));
    await jest.advanceTimersByTimeAsync(TURN_LOCK_RENEW_INTERVAL_MS * 2);
    expect(warn).toHaveBeenCalled();
    expect(store.renewTurnLock).toHaveBeenCalledTimes(2);
    await l.release();
  });

  it('stops renewing and releasing after losing the lock', async () => {
    const l = lock();
    await l.acquire();
    store.renewTurnLock.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(TURN_LOCK_RENEW_INTERVAL_MS * 2);
    expect(error).toHaveBeenCalled();
    expect(store.renewTurnLock).toHaveBeenCalledTimes(1);
    await l.release();
    expect(store.releaseTurnLock).not.toHaveBeenCalled();
  });

  it('adopts the lock written with a new conversation', async () => {
    const l = lock();
    await l.adoptCreated();
    expect(store.acquireTurnLock).toHaveBeenCalledTimes(1);
    await l.adoptCreated();
    expect(store.acquireTurnLock).toHaveBeenCalledTimes(1);
    await l.release();
    expect(store.releaseTurnLock).toHaveBeenCalledTimes(1);
  });
});
