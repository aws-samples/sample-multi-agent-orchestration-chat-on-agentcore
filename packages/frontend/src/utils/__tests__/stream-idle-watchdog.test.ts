import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  watchStreamIdle,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_WAKE_GRACE_MS,
} from '../stream-idle-watchdog';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('watchStreamIdle', () => {
  it('reports a stall after the idle timeout without data', () => {
    const onStall = vi.fn();
    watchStreamIdle(onStall);

    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('restarts the clock on every chunk', () => {
    const onStall = vi.fn();
    const watchdog = watchStreamIdle(onStall);

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000); // runtime heartbeat cadence
      watchdog.touch();
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it('gives a stream frozen with the page time to resume before calling it dead', () => {
    const onStall = vi.fn();
    watchStreamIdle(onStall);

    // The page sleeps for 10 min: the clock jumps, then the overdue timer fires.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(STREAM_WAKE_GRACE_MS);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('never fires once stopped', () => {
    const onStall = vi.fn();
    watchStreamIdle(onStall).stop();

    vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS * 2);
    expect(onStall).not.toHaveBeenCalled();
  });
});
