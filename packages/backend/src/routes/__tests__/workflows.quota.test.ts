/**
 * POST /workflows — active-workflow quota.
 *
 * Stale non-terminal records (older than the orchestrator's 7-day execution
 * timeout) must not hold a slot, and concurrent starts that all pass the
 * first check must be cut back to the limit after the write.
 */

import { describe, it, expect, jest, beforeEach, afterAll, beforeAll } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../../config/index', () => ({
  config: { AWS_REGION: 'ap-northeast-1', WORKFLOW_ORCHESTRATOR_ARN: 'arn:fn:live' },
}));

// A UUIDv7 that sorts after the fixtures' ids below (they model earlier starts).
jest.mock('uuid', () => ({ v7: () => '01a1ffff-0000-7000-8000-000000000000' }));

const lambdaSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => input),
}));
jest.mock('../../services/agents-service', () => ({
  createAgentsService: () => ({ getAgent: async () => ({ agentId: AGENT_ID }) }),
}));

type Header = { workflowId: string; status: string; createdAt: string };
let stored: Header[] = [];
/** Records other requests write between this request's first check and its write. */
let concurrent: Header[] = [];
const repo = {
  isConfigured: () => true,
  list: jest.fn(async () => [...stored].sort((a, b) => b.workflowId.localeCompare(a.workflowId))),
  create: jest.fn(async (record: Header) => {
    stored.push(record, ...concurrent);
  }),
  markFailed: jest.fn(async (_u: string, id: string) => {
    stored = stored.map((w) => (w.workflowId === id ? { ...w, status: 'failed' } : w));
  }),
};
jest.mock('../../repositories/workflows/workflows-repository.factory', () => ({
  getWorkflowsRepository: () => repo,
}));

import workflowsRouter from '../workflows';
import { errorHandlerMiddleware } from '../../middleware/error-handler';

const AGENT_ID = '01a1c4f6-3a99-72fe-a251-64dbbf0c2f1e';
const USER_ID = '97745a78-00b1-70ed-13a3-1032026f75b4';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const day = 24 * 60 * 60 * 1000;
const header = (id: string, ageMs: number, status = 'running'): Header => ({
  workflowId: id,
  status,
  createdAt: new Date(Date.now() - ageMs).toISOString(),
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      jwt: { sub: USER_ID, token_use: 'access' },
      userId: USER_ID,
      log: noopLog,
    });
    next();
  });
  app.use('/workflows', workflowsRouter);
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
  stored = [];
  concurrent = [];
  jest.clearAllMocks();
});

const start = () =>
  fetch(`${baseUrl}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: { goal: 'g', steps: [{ id: 's', agentId: AGENT_ID, prompt: 'p' }] },
    }),
  });

describe('POST /workflows quota', () => {
  it('rejects a fourth active workflow', async () => {
    stored = [header('wf-a', 0), header('wf-b', 0), header('wf-c', 0)];
    const res = await start();
    expect(res.status).toBe(409);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('ignores non-terminal records older than the execution timeout', async () => {
    stored = [header('wf-a', 8 * day), header('wf-b', 9 * day), header('wf-c', 10 * day)];
    const res = await start();
    expect(res.status).toBe(202);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
  });

  it('rejects the late request when concurrent starts overshoot the limit', async () => {
    stored = [header('wf-0001', 0), header('wf-0002', 0)];
    // Another request with an earlier id landed between our check and write.
    concurrent = [header('wf-0003', 0)];
    const res = await start();
    expect(res.status).toBe(409);
    expect(repo.markFailed).toHaveBeenCalledTimes(1);
    expect(lambdaSend).not.toHaveBeenCalled();
  });
});
