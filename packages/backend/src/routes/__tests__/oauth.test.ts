/**
 * POST /oauth/complete — AgentCore Identity URL session binding for 3LO targets.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const mockGetCurrentAuth = jest.fn<() => { isMachineUser: boolean }>();

jest.mock('../../config/index.js', () => ({ config: { AWS_REGION: 'us-west-2' } }));
jest.mock('../../middleware/auth.js', () => ({ getCurrentAuth: () => mockGetCurrentAuth() }));
jest.mock('../../libs/auth/jwks.js', () => ({
  extractJWTFromHeader: (header: string) =>
    header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createOAuthRouter } = require('../oauth.js') as typeof import('../oauth.js');

const SESSION_URI = 'urn:ietf:params:oauth:request_uri:Y2E5NTJmMTgtMzJhMy00NWE5';
const send = jest.fn<(command: { input: unknown }) => Promise<unknown>>();

let server: Server;
let baseUrl: string;

beforeEach(() => {
  send.mockReset().mockResolvedValue({});
  mockGetCurrentAuth.mockReturnValue({ isMachineUser: false });
});

afterAll(() => server?.close());

async function post(body: unknown, authorization = 'Bearer user-access-token') {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { log: unknown }).log = { info: jest.fn(), warn: jest.fn() };
      next();
    });
    app.use(
      '/oauth',
      createOAuthRouter(() => ({ send }) as never)
    );
    app.use(
      (err: { status?: number; code?: string }, _req: Request, res: Response, _n: NextFunction) => {
        res.status(err.status ?? 500).json({ code: err.code });
      }
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const res = await fetch(`${baseUrl}/oauth/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /oauth/complete', () => {
  it('completes the binding with the caller access token, not a body value', async () => {
    const res = await post({ sessionUri: SESSION_URI, userToken: 'attacker-token' });
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(send.mock.calls[0][0].input).toEqual({
      sessionUri: SESSION_URI,
      userIdentifier: { userToken: 'user-access-token' },
    });
  });

  it('rejects machine users before calling AgentCore Identity', async () => {
    mockGetCurrentAuth.mockReturnValue({ isMachineUser: true });
    const res = await post({ sessionUri: SESSION_URI });
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['not a request_uri', { sessionUri: 'https://evil.example/' }],
    ['too long', { sessionUri: `urn:ietf:params:oauth:request_uri:${'a'.repeat(600)}` }],
  ])('validates the session URI (%s)', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['AccessDeniedException', 'ValidationException'])(
    'maps a rejected session (%s) to 400',
    async (name) => {
      send.mockRejectedValue(Object.assign(new Error('Invalid or expired session'), { name }));
      const res = await post({ sessionUri: SESSION_URI });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ARGUMENT');
    }
  );

  it('keeps IAM denials as an upstream error', async () => {
    const denied = new Error(
      'User: arn:aws:sts::1:assumed-role/x is not authorized to perform: bedrock-agentcore:CompleteResourceTokenAuth'
    );
    send.mockRejectedValue(Object.assign(denied, { name: 'AccessDeniedException' }));
    const res = await post({ sessionUri: SESSION_URI });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
  });
});
