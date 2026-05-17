/**
 * SchedulerService Tests
 * Tests formatScheduleExpression logic (via CreateScheduleCommand mock inspection)
 * and other SchedulerService methods.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(() => Promise.resolve({})),
  })),
  CreateScheduleCommand: jest.fn().mockImplementation((input: unknown) => ({ _input: input })),
  UpdateScheduleCommand: jest.fn().mockImplementation((input: unknown) => ({ _input: input })),
  DeleteScheduleCommand: jest.fn().mockImplementation((input: unknown) => ({ _input: input })),
  GetScheduleCommand: jest.fn().mockImplementation((input: unknown) => ({ _input: input })),
}));

// Mock `../config/index` before the module under test imports it, otherwise
// the real config.ts evaluates its Zod schema against `process.env` and the
// test process crashes on missing required vars (memory, triggers, etc.).
jest.mock('../../config/index', () => ({
  config: {
    AWS_REGION: 'us-east-1',
    SCHEDULE_GROUP_NAME: 'default',
  },
}));

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { SchedulerService, InvalidScheduleIntervalError } from '../scheduler-service.js';
import type { UserId, AgentId, TriggerId } from '@moca/core';

const MockSchedulerClient = jest.mocked(SchedulerClient);
const MockCreateScheduleCommand = jest.mocked(CreateScheduleCommand);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _MockUpdateScheduleCommand = jest.mocked(UpdateScheduleCommand);
const MockDeleteScheduleCommand = jest.mocked(DeleteScheduleCommand);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _MockGetScheduleCommand = jest.mocked(GetScheduleCommand);

const BASE_CONFIG = {
  name: 'test-schedule',
  expression: '0 9 * * ? *',
  payload: {
    triggerId: '550e8400-e29b-41d4-a716-446655440000' as TriggerId,
    userId: 'user-456' as UserId,
    agentId: 'agent-789' as AgentId,
    prompt: 'Run daily task',
  },
  targetArn: 'arn:aws:lambda:us-east-1:123456789:function:test',
  roleArn: 'arn:aws:iam::123456789:role/scheduler-role',
};

describe('SchedulerService - formatScheduleExpression (via createSchedule mock inspection)', () => {
  let service: SchedulerService;
  let mockSend: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchedulerService('us-east-1', 'test-group');
    // Get the mock send function from the SchedulerClient instance
    const clientInstance = MockSchedulerClient.mock.results[0].value as {
      send: ReturnType<typeof jest.fn>;
    };
    mockSend = clientInstance.send as ReturnType<typeof jest.fn>;

    mockSend.mockImplementation(() => Promise.resolve({}));
  });

  it('wraps raw cron expression with cron()', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: '0 9 * * ? *' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('cron(0 9 * * ? *)');
  });

  it('leaves already-wrapped cron() expression unchanged', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: 'cron(0 9 * * ? *)' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('cron(0 9 * * ? *)');
  });

  it('leaves already-wrapped rate() expression unchanged', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: 'rate(1 hour)' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('rate(1 hour)');
  });

  it('converts "rate <value>" (with space) to rate(<value>)', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: 'rate 1 hour' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('rate(1 hour)');
  });

  it('trims leading/trailing whitespace before formatting', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: '  0 9 * * ? *  ' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('cron(0 9 * * ? *)');
  });

  it('trims whitespace from already-wrapped cron() expression', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: '  cron(0 9 * * ? *)  ' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('cron(0 9 * * ? *)');
  });

  it('trims whitespace from "rate <value>" expression', async () => {
    await service.createSchedule({ ...BASE_CONFIG, expression: '  rate 5 minutes  ' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { ScheduleExpression: string };
    expect(call.ScheduleExpression).toBe('rate(5 minutes)');
  });
});

describe('SchedulerService - createSchedule', () => {
  let service: SchedulerService;
  let mockSend: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchedulerService('us-east-1', 'test-group');
    const clientInstance = MockSchedulerClient.mock.results[0].value as {
      send: ReturnType<typeof jest.fn>;
    };
    mockSend = clientInstance.send as ReturnType<typeof jest.fn>;

    mockSend.mockImplementation(() => Promise.resolve({}));
  });

  it('uses schedule name as "trigger-<triggerId>"', async () => {
    await service.createSchedule(BASE_CONFIG);

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { Name: string };
    expect(call.Name).toBe('trigger-550e8400-e29b-41d4-a716-446655440000');
  });

  it('sets GroupName from constructor parameter', async () => {
    await service.createSchedule(BASE_CONFIG);

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { GroupName: string };
    expect(call.GroupName).toBe('test-group');
  });

  it('sets State to ENABLED when config.enabled is not false', async () => {
    await service.createSchedule({ ...BASE_CONFIG, enabled: true });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { State: string };
    expect(call.State).toBe('ENABLED');
  });

  it('sets State to ENABLED when enabled is undefined', async () => {
    await service.createSchedule({ ...BASE_CONFIG });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { State: string };
    expect(call.State).toBe('ENABLED');
  });

  it('sets State to DISABLED when config.enabled is false', async () => {
    await service.createSchedule({ ...BASE_CONFIG, enabled: false });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as { State: string };
    expect(call.State).toBe('DISABLED');
  });

  it('sets UTC timezone when not specified', async () => {
    await service.createSchedule(BASE_CONFIG);

    const call = MockCreateScheduleCommand.mock.calls[0][0] as {
      ScheduleExpressionTimezone: string;
    };
    expect(call.ScheduleExpressionTimezone).toBe('UTC');
  });

  it('uses specified timezone', async () => {
    await service.createSchedule({ ...BASE_CONFIG, timezone: 'America/New_York' });

    const call = MockCreateScheduleCommand.mock.calls[0][0] as {
      ScheduleExpressionTimezone: string;
    };
    expect(call.ScheduleExpressionTimezone).toBe('America/New_York');
  });

  it('returns schedule ARN on success', async () => {
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';

    const arn = await service.createSchedule(BASE_CONFIG);

    expect(arn).toContain('trigger-550e8400-e29b-41d4-a716-446655440000');
    expect(arn).toContain('test-group');
  });

  it('throws error when client.send fails', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('AWS error')));

    await expect(service.createSchedule(BASE_CONFIG)).rejects.toThrow(
      'Failed to create EventBridge schedule: AWS error'
    );
  });
});

describe('SchedulerService - deleteSchedule', () => {
  let service: SchedulerService;
  let mockSend: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchedulerService('us-east-1', 'test-group');
    const clientInstance = MockSchedulerClient.mock.results[0].value as {
      send: ReturnType<typeof jest.fn>;
    };
    mockSend = clientInstance.send as ReturnType<typeof jest.fn>;

    mockSend.mockImplementation(() => Promise.resolve({}));
  });

  it('calls DeleteScheduleCommand with correct schedule name', async () => {
    await service.deleteSchedule('a1b2c3d4-e5f6-7890-abcd-ef1234567890' as TriggerId);

    const call = MockDeleteScheduleCommand.mock.calls[0][0] as { Name: string; GroupName: string };
    expect(call.Name).toBe('trigger-a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(call.GroupName).toBe('test-group');
  });

  it('throws error when delete fails', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('Not found')));

    await expect(
      service.deleteSchedule('a1b2c3d4-e5f6-7890-abcd-ef1234567890' as TriggerId)
    ).rejects.toThrow('Failed to delete EventBridge schedule: Not found');
  });
});

describe('SchedulerService - scheduleExists', () => {
  let service: SchedulerService;
  let mockSend: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchedulerService('us-east-1', 'test-group');
    const clientInstance = MockSchedulerClient.mock.results[0].value as {
      send: ReturnType<typeof jest.fn>;
    };
    mockSend = clientInstance.send as ReturnType<typeof jest.fn>;
  });

  it('returns true when schedule exists', async () => {
    mockSend.mockImplementation(() => Promise.resolve({ Name: 'trigger-123' }));

    const exists = await service.scheduleExists(
      '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f' as TriggerId
    );
    expect(exists).toBe(true);
  });

  it('returns false when ResourceNotFoundException is thrown', async () => {
    const error = Object.assign(new Error('Resource not found'), {
      name: 'ResourceNotFoundException',
    });
    mockSend.mockImplementation(() => Promise.reject(error));

    const exists = await service.scheduleExists(
      '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f' as TriggerId
    );
    expect(exists).toBe(false);
  });

  it('rethrows non-ResourceNotFoundException errors', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('Internal server error')));

    await expect(
      service.scheduleExists('019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f' as TriggerId)
    ).rejects.toThrow('Internal server error');
  });
});

/**
 * Minimum-interval guard: rejects cron / rate expressions that would fire
 * more than once per minute. See
 * `docs/event-driven-identity-pool-credentials.md` > Quotas & Rate Limits
 * for the rationale (GetOpenIdTokenForDeveloperIdentity 25 TPS hard quota).
 *
 * The matching unit tests for the frontend mirror implementation live at
 * `packages/frontend/src/components/triggers/CronBuilder/__tests__/cronUtils.test.ts`.
 */
describe('SchedulerService - minimum interval enforcement', () => {
  let service: SchedulerService;
  let mockSend: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SchedulerService('us-east-1', 'test-group');
    const clientInstance = MockSchedulerClient.mock.results[0].value as {
      send: ReturnType<typeof jest.fn>;
    };
    mockSend = clientInstance.send as ReturnType<typeof jest.fn>;
    mockSend.mockImplementation(() => Promise.resolve({}));
  });

  it.each([['rate(30 seconds)'], ['rate(0.5 minutes)'], ['rate(0 seconds)']])(
    'createSchedule rejects sub-minute expression %s',
    async (expression) => {
      await expect(service.createSchedule({ ...BASE_CONFIG, expression })).rejects.toBeInstanceOf(
        InvalidScheduleIntervalError
      );

      // The EventBridge client must NOT be called when interval validation
      // fails — otherwise we would waste an API round-trip and surface a
      // less-actionable generic failure.
      expect(MockCreateScheduleCommand).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['rate(1 minute)'],
    ['* * * * ? *'], // every minute (warning, but allowed)
    ['*/5 * * * ? *'], // every 5 minutes
    ['0 * * * ? *'], // every hour
    ['0 0 * * ? *'], // every day
  ])('createSchedule allows expression %s', async (expression) => {
    await expect(service.createSchedule({ ...BASE_CONFIG, expression })).resolves.toBeDefined();
    expect(MockCreateScheduleCommand).toHaveBeenCalledTimes(1);
  });

  it('updateSchedule rejects sub-minute expression when expression is changing', async () => {
    await expect(
      service.updateSchedule(BASE_CONFIG.payload.triggerId, {
        expression: 'rate(10 seconds)',
      })
    ).rejects.toBeInstanceOf(InvalidScheduleIntervalError);
  });

  it('updateSchedule skips validation when expression is omitted', async () => {
    // Omitting `expression` preserves the current schedule, which was already
    // validated at creation time; re-running the check would misreport a
    // pure "pause/resume" edit as a 400.
    //
    // GetScheduleCommand mock must return something for the update merge.
    mockSend.mockImplementationOnce(() =>
      Promise.resolve({
        ScheduleExpression: 'cron(0 * * * ? *)',
        ScheduleExpressionTimezone: 'UTC',
        State: 'ENABLED',
        Target: { Arn: 'x', RoleArn: 'y' },
      })
    );

    await expect(
      service.updateSchedule(BASE_CONFIG.payload.triggerId, { enabled: false })
    ).resolves.toBeUndefined();
  });
});
