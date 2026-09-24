/**
 * GET /sessions/:sessionId/events — route integration tests
 *
 * Mounts the REAL sessions router on a minimal Express app, mocks out:
 *  - getSessionsRepository  → controls ownership checks
 *  - createAgentCoreMemoryServiceForRequest  → controls service behaviour
 *
 * A pre-router middleware injects `req.identityId`, `req.requestId`, and
 * `req.log` so the route handler sees the same shape it expects in production
 * without needing the full Cognito auth stack.
 *
 * Exercises the full route stack: param validation, ownership gate, service
 * delegation, response serialisation, and error-code → HTTP status mapping.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE modules-under-test are imported.
// ---------------------------------------------------------------------------

// 1. Sessions repository factory.
const mockGetSession = jest.fn<() => Promise<{ sessionId: string } | null>>();
const mockIsConfigured = jest.fn<() => boolean>().mockReturnValue(true);

jest.mock('../../repositories/sessions/sessions-repository.factory', () => ({
  getSessionsRepository: () => ({
    isConfigured: mockIsConfigured,
    getSession: mockGetSession,
  }),
}));

// 2. AgentCore memory service factory.
const mockGetEventsPage = jest.fn();
const mockMemoryService = { getSessionEventsPage: mockGetEventsPage };

jest.mock('../../services/agentcore-memory', () => {
  const actual = jest.requireActual<typeof import('../../services/agentcore-memory')>(
    '../../services/agentcore-memory'
  );
  return {
    ...actual,
    createAgentCoreMemoryServiceForRequest: jest.fn().mockResolvedValue(mockMemoryService),
  };
});

// 3. Config.
jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'mem-test' },
  isDevelopment: false,
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocks.
// ---------------------------------------------------------------------------
import sessionsRouter from '../sessions';
import { errorHandlerMiddleware } from '../../middleware/error-handler';
import { AppError, ErrorCode } from '../../libs/http/index';

// ---------------------------------------------------------------------------
// Test app setup.
// ---------------------------------------------------------------------------
const ACTOR_ID = 'actor-test-123';

function buildApp() {
  const app = express();
  app.use(express.json());

  // Inject the fields that auth + request-logger middlewares would set.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const r = req as Request & {
      identityId: string;
      requestId: string;
      log: typeof console;
    };
    r.identityId = ACTOR_ID;
    r.requestId = 'req-test-id';
    r.log = console;
    next();
  });

  app.use('/sessions', sessionsRouter);
  app.use(errorHandlerMiddleware);
  return app;
}

// A valid session ID (matches the zSessionId schema — 33 chars alphanumeric).
const SESSION_ID = 'SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSss';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /sessions/:sessionId/events', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ sessionId: SESSION_ID });
    mockGetEventsPage.mockResolvedValue({
      messages: [],
      hasMore: false,
      truncated: false,
    });
    mockIsConfigured.mockReturnValue(true);
    app = buildApp();
  });

  // ── Ownership gate ───────────────────────────────────────────────────────

  it('returns 404 when session does not belong to the caller', async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('returns 200 when session belongs to the caller', async () => {
    mockGetSession.mockResolvedValue({ sessionId: SESSION_ID });

    const res = await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(200);
    expect(res.body.events).toBeDefined();
  });

  it('skips ownership check and succeeds when repository is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);

    const res = await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(200);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it('returns events array, hasMore, and nextCursor from the service', async () => {
    const fakeMessage = {
      id: 'e1:0',
      type: 'user',
      contents: [{ type: 'text', text: 'hello' }],
      timestamp: '2024-01-01T00:00:00.000Z',
    };
    mockGetEventsPage.mockResolvedValue({
      messages: [fakeMessage],
      nextCursor: 'cursor-abc',
      hasMore: true,
      truncated: false,
    });

    const res = await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([fakeMessage]);
    expect(res.body.nextCursor).toBe('cursor-abc');
    expect(res.body.hasMore).toBe(true);
  });

  // ── Cursor forwarding ─────────────────────────────────────────────────────

  it('forwards the ?cursor query param to the service', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, pageToken: 'page2' }),
      'utf-8'
    ).toString('base64url');

    await request(app).get(`/sessions/${SESSION_ID}/events?cursor=${cursor}`);

    expect(mockGetEventsPage).toHaveBeenCalledWith(
      ACTOR_ID,
      SESSION_ID,
      expect.any(Number),
      cursor
    );
  });

  it('passes undefined cursor to the service when ?cursor is absent', async () => {
    await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(mockGetEventsPage).toHaveBeenCalledWith(
      ACTOR_ID,
      SESSION_ID,
      expect.any(Number),
      undefined
    );
  });

  // ── limit parsing ─────────────────────────────────────────────────────────

  it('defaults limit to 50 when not specified', async () => {
    await request(app).get(`/sessions/${SESSION_ID}/events`);
    expect(mockGetEventsPage).toHaveBeenCalledWith(ACTOR_ID, SESSION_ID, 50, undefined);
  });

  it('clamps limit to 100 when ?limit=9999', async () => {
    await request(app).get(`/sessions/${SESSION_ID}/events?limit=9999`);
    expect(mockGetEventsPage).toHaveBeenCalledWith(ACTOR_ID, SESSION_ID, 100, undefined);
  });

  it('falls back to default when ?limit=0', async () => {
    await request(app).get(`/sessions/${SESSION_ID}/events?limit=0`);
    expect(mockGetEventsPage).toHaveBeenCalledWith(ACTOR_ID, SESSION_ID, 50, undefined);
  });

  // ── 4xx / 413 mapping ─────────────────────────────────────────────────────

  it('returns 400 when service throws VALIDATION_ERROR', async () => {
    mockGetEventsPage.mockRejectedValue(
      new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid cursor format')
    );

    const res = await request(app).get(`/sessions/${SESSION_ID}/events?cursor=garbage`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('returns 413 when service throws PAYLOAD_TOO_LARGE', async () => {
    mockGetEventsPage.mockRejectedValue(
      new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'Single event exceeds response byte budget')
    );

    const res = await request(app).get(`/sessions/${SESSION_ID}/events`);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  // ── sessionId path validation ─────────────────────────────────────────────

  it('returns 400 for an invalid sessionId (too short)', async () => {
    const res = await request(app).get('/sessions/bad/events');
    expect(res.status).toBe(400);
  });
});
