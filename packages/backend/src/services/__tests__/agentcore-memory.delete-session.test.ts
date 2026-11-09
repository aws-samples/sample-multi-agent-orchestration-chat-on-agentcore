/**
 * deleteSession — failure surfacing, time budget and idempotency.
 *
 * Live incident: DeleteEvent was throttled (`ThrottledException: Rate
 * exceeded`), the error was swallowed, and DELETE /sessions/:id returned 200
 * while 6 of 56 events stayed in AgentCore Memory. Throttling itself is now
 * absorbed by the client's adaptive retry mode; these tests pin what the
 * service does with whatever still fails.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  BedrockAgentCoreClient,
  DeleteEventCommand,
  ListEventsCommand,
} from '@aws-sdk/client-bedrock-agentcore';

jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));

import {
  AgentCoreMemoryService,
  DELETE_SESSION_DEADLINE_MS,
  SessionEventsDeleteError,
} from '../agentcore-memory';

const awsError = (name: string) => Object.assign(new Error(name), { name });

interface SetupOptions {
  /** Error to throw for a DeleteEvent of a given event id. */
  deleteErrors?: Record<string, Error>;
  /** Error to throw from ListEvents. */
  listError?: Error;
  /** Simulated clock: advances by this many ms per DeleteEvent. */
  msPerDelete?: number;
}

function setup(eventIds: string[], opts: SetupOptions = {}) {
  const deleteCalls: string[] = [];
  let clock = 0;
  const send = jest.fn(async (command: unknown) => {
    if (command instanceof ListEventsCommand) {
      if (opts.listError) throw opts.listError;
      return { events: eventIds.map((eventId) => ({ eventId })), nextToken: undefined };
    }
    if (command instanceof DeleteEventCommand) {
      const id = command.input.eventId as string;
      deleteCalls.push(id);
      clock += opts.msPerDelete ?? 0;
      const err = opts.deleteErrors?.[id];
      if (err) throw err;
      return {};
    }
    throw new Error('unexpected command');
  });
  // paginateListEvents checks `instanceof BedrockAgentCoreClient`, so use a
  // real client and only stub its transport.
  const client = new BedrockAgentCoreClient({ region: 'us-east-1' });
  client.send = send as unknown as BedrockAgentCoreClient['send'];
  const service = new AgentCoreMemoryService('test-memory-id', client, { now: () => clock });
  return { service, deleteCalls };
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe('AgentCoreMemoryService.deleteSession', () => {
  it('deletes every event sequentially', async () => {
    const { service, deleteCalls } = setup(['e1', 'e2', 'e3']);
    await expect(service.deleteSession('actor', 'sid')).resolves.toBeUndefined();
    expect(deleteCalls).toEqual(['e1', 'e2', 'e3']);
  });

  it('throws SessionEventsDeleteError when a delete still fails, after trying every event', async () => {
    const { service, deleteCalls } = setup(['e1', 'e2', 'e3'], {
      deleteErrors: { e2: awsError('ThrottledException') },
    });
    const error = await rejection(service.deleteSession('actor', 'sid'));
    expect(error).toBeInstanceOf(SessionEventsDeleteError);
    expect(error).toMatchObject({ remainingEvents: 1, totalEvents: 3, reason: 'errors' });
    expect(deleteCalls).toEqual(['e1', 'e2', 'e3']);
  });

  it('stops at the time budget and reports the events it never attempted', async () => {
    // Each delete "takes" 40% of the budget: e1, e2, e3 run (the check happens
    // before each call), then the clock is past the deadline.
    const { service, deleteCalls } = setup(['e1', 'e2', 'e3', 'e4', 'e5'], {
      msPerDelete: DELETE_SESSION_DEADLINE_MS * 0.4,
    });
    const error = await rejection(service.deleteSession('actor', 'sid'));
    expect(deleteCalls).toEqual(['e1', 'e2', 'e3']);
    expect(error).toMatchObject({ remainingEvents: 2, totalEvents: 5, reason: 'deadline' });
  });

  it('treats an already-deleted event as deleted', async () => {
    const { service } = setup(['e1', 'e2'], {
      deleteErrors: { e1: awsError('ResourceNotFoundException') },
    });
    await expect(service.deleteSession('actor', 'sid')).resolves.toBeUndefined();
  });

  it('treats ResourceNotFound from ListEvents as nothing to delete (idempotent retry)', async () => {
    const { service, deleteCalls } = setup(['e1'], {
      listError: awsError('ResourceNotFoundException'),
    });
    await expect(service.deleteSession('actor', 'sid')).resolves.toBeUndefined();
    expect(deleteCalls).toEqual([]);
  });

  it('propagates other ListEvents errors (e.g. AccessDenied)', async () => {
    const { service } = setup(['e1'], { listError: awsError('AccessDeniedException') });
    await expect(service.deleteSession('actor', 'sid')).rejects.toMatchObject({
      name: 'AccessDeniedException',
    });
  });
});
