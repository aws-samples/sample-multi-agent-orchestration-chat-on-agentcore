/**
 * Visible, de-duplicated persistence degradation (AC-3).
 *
 * When user-scoped credentials can no longer be refreshed, every message
 * save and every file sync fails. The turn must surface that ONCE — one
 * error-level log and one client warning event — instead of one warning per
 * message / file that nobody sees.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../../libs/logger/index.js', () => ({ logger }));

const { reportPersistenceFailure, isCredentialExpiryError } =
  await import('../persistence-health.js');
const { UserCredentialsExpiredError } = await import('../../../libs/utils/scoped-credentials.js');
const { createRequestContext, runWithContext } =
  await import('../../../libs/context/request-context.js');

function newTurn() {
  const ctx = createRequestContext('Bearer at');
  const events: unknown[] = [];
  ctx.emitClientEvent = (event) => events.push(event);
  return { ctx, events };
}

const expired = Object.assign(new Error('The security token included in the request is expired'), {
  name: 'ExpiredTokenException',
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isCredentialExpiryError', () => {
  it.each([
    ['AgentCore Memory', expired],
    [
      'S3 (string from sync result)',
      'Failed to upload a.txt: ExpiredToken: The provided token has expired.',
    ],
    ['refresh impossible', new UserCredentialsExpiredError()],
  ])('recognises %s', (_label, error) => {
    expect(isCredentialExpiryError(error)).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(isCredentialExpiryError(new Error('ThrottlingException'))).toBe(false);
  });
});

describe('reportPersistenceFailure', () => {
  it('logs one error and emits one warning event per turn, however many saves fail', () => {
    const { ctx, events } = newTurn();

    const handled = runWithContext(ctx, () => [
      reportPersistenceFailure('conversation', expired),
      reportPersistenceFailure('conversation', expired),
      reportPersistenceFailure('workspace', 'Failed to upload x: ExpiredToken'),
    ]);

    expect(handled).toEqual([true, true, true]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'serverWarningEvent',
        warning: expect.objectContaining({ code: 'persistenceDegraded' }),
      }),
    ]);
  });

  it('leaves non-credential failures to the caller', () => {
    const { ctx, events } = newTurn();
    const handled = runWithContext(ctx, () =>
      reportPersistenceFailure('conversation', new Error('ThrottlingException'))
    );
    expect(handled).toBe(false);
    expect(events).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports again in the next turn', () => {
    for (let i = 0; i < 2; i++) {
      const { ctx } = newTurn();
      runWithContext(ctx, () => reportPersistenceFailure('conversation', expired));
    }
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
