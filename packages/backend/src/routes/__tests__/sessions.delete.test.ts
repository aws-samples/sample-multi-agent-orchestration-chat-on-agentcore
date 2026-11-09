/**
 * DELETE /sessions/:sessionId — store ordering and failure surfacing.
 *
 * The session list reads DynamoDB, so the row is the user's only handle to
 * retry. The route must delete Memory events first and remove the row only
 * after Memory succeeded; a Memory failure must keep the row and return 500.
 */

import { describe, it, expect, jest, beforeEach, afterAll, beforeAll } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));

const calls: string[] = [];
const memoryDelete = jest.fn(async () => {
  calls.push('memory');
});
const repo = {
  isConfigured: () => true,
  getSession: jest.fn(async () => ({ sessionId: SESSION_ID }) as unknown),
  deleteSession: jest.fn(async () => {
    calls.push('dynamo');
  }),
};

jest.mock('../../services/agentcore-memory', () => ({
  createAgentCoreMemoryServiceForRequest: async () => ({ deleteSession: memoryDelete }),
}));
jest.mock('../../repositories/sessions/sessions-repository.factory', () => ({
  getSessionsRepository: () => repo,
}));

import sessionsRouter from '../sessions';
import { errorHandlerMiddleware } from '../../middleware/error-handler';

const SESSION_ID = 'a'.repeat(33);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { identityId: 'ap-northeast-1:actor', log: noopLog });
    next();
  });
  app.use('/sessions', sessionsRouter);
  app.use(errorHandlerMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
  memoryDelete.mockClear();
  memoryDelete.mockImplementation(async () => {
    calls.push('memory');
  });
  repo.getSession.mockClear();
  repo.getSession.mockImplementation(async () => ({ sessionId: SESSION_ID }));
  repo.deleteSession.mockClear();
});

const del = () => fetch(`${baseUrl}/sessions/${SESSION_ID}`, { method: 'DELETE' });

describe('DELETE /sessions/:sessionId', () => {
  it('deletes Memory events before the DynamoDB row', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(calls).toEqual(['memory', 'dynamo']);
  });

  it('keeps the DynamoDB row and returns 500 when the Memory delete fails', async () => {
    memoryDelete.mockImplementation(async () => {
      throw new Error('3 of 56 session events were not deleted (delete errors)');
    });
    const res = await del();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/partially deleted; please retry/);
    expect(repo.deleteSession).not.toHaveBeenCalled();
  });

  it('still cleans up Memory when the row is already gone (retry of an older failure)', async () => {
    repo.getSession.mockImplementation(async () => null);
    const res = await del();
    expect(res.status).toBe(200);
    expect(calls).toEqual(['memory']);
  });

  it('returns 500 when the DynamoDB delete fails after Memory succeeded', async () => {
    repo.deleteSession.mockImplementationOnce(async () => {
      throw new Error('ddb down');
    });
    const res = await del();
    expect(res.status).toBe(500);
    expect(memoryDelete).toHaveBeenCalledTimes(1);
  });
});
