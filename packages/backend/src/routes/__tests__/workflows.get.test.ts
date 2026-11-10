/**
 * GET /workflows/:id — `view=summary` drops step outputs so the UI can poll
 * without re-downloading up to 20 KB per step every few seconds.
 */

import { describe, it, expect, jest, afterAll, beforeAll } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../../config/index', () => ({
  config: { AWS_REGION: 'ap-northeast-1', WORKFLOW_ORCHESTRATOR_ARN: 'arn:fn:live' },
}));
jest.mock('uuid', () => ({ v7: () => '01a1ffff-0000-7000-8000-000000000000' }));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
}));
jest.mock('../../services/agents-service', () => ({ createAgentsService: () => ({}) }));

const WORKFLOW_ID = 'wf-01a1c5fd-fbe4-7719-8d8e-24e7004f5495';
const repo = {
  isConfigured: () => true,
  get: jest.fn(async () => ({
    workflowId: WORKFLOW_ID,
    userId: 'user-1',
    status: 'running',
    spec: { goal: 'g', steps: [{ id: 'a', agentId: 'x', prompt: 'p' }] },
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  })),
  listSteps: jest.fn(async () => [
    {
      workflowId: WORKFLOW_ID,
      stepId: 'a',
      status: 'done',
      runs: 1,
      iteration: 0,
      output: 'x'.repeat(20_000),
      feedback: 'ok',
      startedAt: '2026-11-10T00:00:01Z',
      updatedAt: '2026-11-10T00:01:00Z',
    },
  ]),
};
jest.mock('../../repositories/workflows/workflows-repository.factory', () => ({
  getWorkflowsRepository: () => repo,
}));

import workflowsRouter from '../workflows';
import { errorHandlerMiddleware } from '../../middleware/error-handler';

const USER_ID = '97745a78-00b1-70ed-13a3-1032026f75b4';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
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

const getStep = async (query = '') => {
  const res = await fetch(`${baseUrl}/workflows/${WORKFLOW_ID}${query}`);
  const body = (await res.json()) as {
    workflow: { userId?: string; steps: Record<string, unknown>[] };
  };
  return { status: res.status, workflow: body.workflow, step: body.workflow.steps[0] };
};

describe('GET /workflows/:id', () => {
  it('returns step outputs by default', async () => {
    const { status, workflow, step } = await getStep();
    expect(status).toBe(200);
    expect(workflow.userId).toBeUndefined();
    expect(step.output).toHaveLength(20_000);
  });

  it('omits step outputs but keeps progress fields with view=summary', async () => {
    const { status, step } = await getStep('?view=summary');
    expect(status).toBe(200);
    expect(step).not.toHaveProperty('output');
    expect(step).toMatchObject({
      status: 'done',
      feedback: 'ok',
      startedAt: '2026-11-10T00:00:01Z',
    });
  });

  it('rejects an unknown view', async () => {
    const res = await fetch(`${baseUrl}/workflows/${WORKFLOW_ID}?view=everything`);
    expect(res.status).toBe(400);
  });
});
