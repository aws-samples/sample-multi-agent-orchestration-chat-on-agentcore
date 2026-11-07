/**
 * Token-renewal side channel (AC-1, AC-7).
 *
 * During a long turn the frontend re-sends its refreshed Cognito tokens with
 * `{ action: 'renewTokens' }` on the same Runtime session (same microVM). The
 * tokens are recorded by requestContextMiddleware; this middleware only has to
 * acknowledge without starting an agent turn.
 */

import { jest, describe, it, expect } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const { renewTokensMiddleware } = await import('../renew-tokens.js');
const { createRequestContext, runWithContext } = await import('../../context/request-context.js');

function createResponse() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function run(body: unknown, sessionId?: string) {
  const ctx = createRequestContext('Bearer at');
  ctx.sessionId = sessionId as never;
  const res = createResponse();
  const next = jest.fn();
  runWithContext(ctx, () =>
    renewTokensMiddleware({ body } as Request, res, next as unknown as NextFunction)
  );
  return { res, next };
}

describe('renewTokensMiddleware', () => {
  it('passes regular prompts through', () => {
    const { next, res } = run({ prompt: 'hi' }, 'S'.repeat(33));
    expect(next).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('acknowledges a renewal without starting a turn', () => {
    const { next, res } = run({ action: 'renewTokens' }, 'S'.repeat(33));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ type: 'tokensRenewed' });
  });

  it('rejects a renewal without a session id (nothing to renew)', () => {
    const { next, res } = run({ action: 'renewTokens' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
