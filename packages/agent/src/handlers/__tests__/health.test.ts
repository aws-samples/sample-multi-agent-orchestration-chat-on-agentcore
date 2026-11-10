/**
 * Unit tests for the health (`/ping`) handler.
 *
 * AgentCore Runtime polls `/ping` to decide whether a session is Idle. A bare
 * `Healthy` while a long invocation is still running lets the platform reclaim
 * the microVM (SIGTERM) mid-task. `handlePing` must therefore report
 * `HealthyBusy` whenever an invocation is in flight, and `time_of_last_update`
 * must not advance on each poll or the platform never sees the session idle.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { handlePing } from '../health.js';
import { beginInvocation, resetInFlight } from '../../libs/health/in-flight.js';
import { resetLastActivity } from '../../libs/health/last-activity.js';

const T0 = new Date('2026-11-10T00:00:00Z').getTime();

/** Minimal Response stub capturing the JSON body. */
function mockResponse(): { res: Response; body: () => unknown } {
  let captured: unknown;
  const res = {
    json: jest.fn((payload: unknown) => {
      captured = payload;
      return res;
    }),
  } as unknown as Response;
  return { res, body: () => captured };
}

describe('handlePing', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    resetInFlight();
    resetLastActivity();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports "Healthy" when no invocation is in flight', () => {
    const { res, body } = mockResponse();
    handlePing({} as Request, res);
    expect((body() as { status: string }).status).toBe('Healthy');
  });

  it('reports "HealthyBusy" while an invocation is in flight', () => {
    beginInvocation();
    const { res, body } = mockResponse();
    handlePing({} as Request, res);
    expect((body() as { status: string }).status).toBe('HealthyBusy');
  });

  it('reports the last activity time, not the poll time', () => {
    jest.setSystemTime(T0 + 15 * 60_000);
    const { res, body } = mockResponse();
    handlePing({} as Request, res);
    expect((body() as { time_of_last_update: number }).time_of_last_update).toBe(
      Math.floor(T0 / 1000)
    );
  });
});
