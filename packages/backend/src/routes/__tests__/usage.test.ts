/**
 * /usage routes — validation, the per-user rate limit, and machine-user
 * group resolution.
 */

import { describe, it, expect, jest, afterAll, beforeAll, beforeEach } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../../config/index', () => ({
  config: {
    AWS_REGION: 'ap-northeast-1',
    COGNITO_USER_POOL_ID: 'pool',
    USAGE_TABLE_NAME: 'usage',
    // Not an image_to_text model: proves BEDROCK_MODEL_IDS feeds the allow-list.
    BEDROCK_MODEL_IDS: 'global.anthropic.claude-opus-5-5',
    TOKEN_LIMITS_CONFIG: JSON.stringify({
      timezone: 'Asia/Tokyo',
      limits: { default: { input: 1000, output: 100 } },
      groups: { admin: 'unlimited' },
    }),
  },
}));

const addUsage = jest.fn(async () => {});
jest.mock('../../repositories/usage/usage-repository.factory', () => ({
  getUsageRepository: () => ({ isConfigured: () => true, addUsage, getMonth: async () => [] }),
}));
const getGroupsForUserSub = jest.fn(async () => ['admin']);
jest.mock('../../services/cognito-groups', () => ({ getGroupsForUserSub }));

import usageRouter, { RECORDS_PER_MINUTE, resetRateLimitForTest } from '../usage';
import { errorHandlerMiddleware } from '../../middleware/error-handler';

const USER_ID = '97745a78-00b1-70ed-13a3-1032026f75b4';
const TARGET = '0a1b2c3d-0000-4000-8000-000000000001';
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
let server: Server;
let baseUrl: string;
let machine = false;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      jwt: machine
        ? { sub: 'client', client_id: 'client', token_use: 'access' }
        : { sub: USER_ID, 'cognito:username': 'u', 'cognito:groups': [], token_use: 'access' },
      userId: machine ? undefined : USER_ID,
      log: noopLog,
    });
    next();
  });
  app.use('/usage', usageRouter);
  app.use(errorHandlerMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  machine = false;
  addUsage.mockClear();
  getGroupsForUserSub.mockClear();
  resetRateLimitForTest();
});

const record = (overrides: Record<string, unknown> = {}) => ({
  recordId: '3b241101-e2bb-4255-8caf-4136c566a962',
  modelId: 'global.anthropic.claude-opus-5-5',
  uncachedInputTokens: 1,
  cacheReadInputTokens: 2,
  cacheWriteInputTokens: 3,
  outputTokens: 4,
  ...overrides,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/usage/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('POST /usage/records', () => {
  it('records valid usage for the caller', async () => {
    const res = await post({ records: [record()] });
    expect(res.status).toBe(204);
    expect(addUsage).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      'anthropic.claude-opus-5-5',
      expect.objectContaining({ outputTokens: 4 })
    );
  });

  it.each([
    ['negative tokens', { outputTokens: -1 }],
    ['fractional tokens', { outputTokens: 1.5 }],
    ['absurd tokens', { outputTokens: 10_000_000 }],
  ])('rejects %s', async (_name, overrides) => {
    const res = await post({ records: [record(overrides)] });
    expect(res.status).toBe(400);
    expect(addUsage).not.toHaveBeenCalled();
  });

  it('rejects more than 50 records', async () => {
    const res = await post({ records: Array.from({ length: 51 }, () => record()) });
    expect(res.status).toBe(400);
  });

  it('rate-limits a caller after RECORDS_PER_MINUTE requests', async () => {
    for (let i = 0; i < RECORDS_PER_MINUTE; i++)
      expect((await post({ records: [record()] })).status).toBe(204);
    expect((await post({ records: [record()] })).status).toBe(429);
  });

  // A regular user naming someone else must only ever add to their own usage.
  it('ignores X-Target-User-Id from a regular user', async () => {
    const res = await post({ records: [record()] }, { 'X-Target-User-Id': TARGET });
    expect(res.status).toBe(204);
    expect(addUsage).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
      expect.any(String),
      expect.anything()
    );
    expect(addUsage).not.toHaveBeenCalledWith(
      TARGET,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it('requires X-Target-User-Id from a machine user', async () => {
    machine = true;
    expect((await post({ records: [record()] })).status).toBe(400);
    expect(addUsage).not.toHaveBeenCalled();
  });

  it('records machine-user usage for X-Target-User-Id', async () => {
    machine = true;
    const res = await post({ records: [record()] }, { 'X-Target-User-Id': TARGET });
    expect(res.status).toBe(204);
    expect(addUsage).toHaveBeenCalledWith(
      TARGET,
      expect.any(String),
      expect.any(String),
      expect.anything()
    );
  });
});

describe('GET /usage/me', () => {
  it('returns the summary in the standard envelope', async () => {
    const res = await fetch(`${baseUrl}/usage/me`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      period: { timezone: 'Asia/Tokyo' },
      metadata: expect.any(Object),
    });
    expect(getGroupsForUserSub).not.toHaveBeenCalled();
  });

  it('looks up groups from Cognito for machine users', async () => {
    machine = true;
    const res = await fetch(`${baseUrl}/usage/me`, { headers: { 'X-Target-User-Id': TARGET } });
    const body = (await res.json()) as { groups: string[] };
    expect(res.status).toBe(200);
    expect(getGroupsForUserSub).toHaveBeenCalledWith(TARGET);
    expect(body.groups).toEqual(['admin']);
  });
});
