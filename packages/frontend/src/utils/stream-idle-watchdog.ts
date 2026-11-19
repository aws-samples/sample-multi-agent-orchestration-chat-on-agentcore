/**
 * Detect a response stream that has silently stopped delivering.
 *
 * After an iOS PWA resumes, a fetch stream can hang forever without erroring;
 * the reply then stays `isStreaming` and the tab never falls back to the
 * reattach path. The runtime writes a heartbeat every 30 s, so silence for
 * several heartbeats means the stream is gone.
 */

import { onPageWake } from './page-wake';

/** Three missed runtime heartbeats (HEARTBEAT_INTERVAL_MS = 30 s). */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * After the page was frozen, give a live stream time to flush what it
 * buffered and deliver its next heartbeat before calling it dead.
 */
export const STREAM_WAKE_GRACE_MS = 35_000;

/** A timer firing this late means the page (and the stream) was frozen. */
const FROZEN_TIMER_SLACK_MS = 5_000;

export class StreamStalledError extends Error {
  constructor() {
    super(`No data from the agent for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`);
    this.name = 'StreamStalledError';
  }
}

export interface StreamIdleWatchdog {
  /** Data arrived. */
  touch(): void;
  stop(): void;
}

export function watchStreamIdle(onStall: () => void): StreamIdleWatchdog {
  let deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const extendForWake = (): void => {
    deadline = Math.max(deadline, Date.now() + STREAM_WAKE_GRACE_MS);
  };

  const arm = (): void => {
    const expectedAt = deadline;
    timer = setTimeout(
      () => {
        if (stopped) return;
        const now = Date.now();
        // Do not rely on visibilitychange arriving before this timer on resume.
        if (now - expectedAt > FROZEN_TIMER_SLACK_MS) extendForWake();
        if (now >= deadline) {
          stopped = true;
          disposeWake();
          onStall();
          return;
        }
        arm();
      },
      Math.max(0, deadline - Date.now())
    );
  };

  const disposeWake = onPageWake(extendForWake);
  arm();

  return {
    touch: () => {
      deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      disposeWake();
    },
  };
}
