/**
 * Session MODIFY events must carry the running-turn marker so an open UI
 * learns when a turn it did not start (or lost the stream of) begins and ends.
 */

import { describe, it, expect } from '@jest/globals';
import type { DynamoDBRecord } from 'aws-lambda';
import { isLeaseOnlyUpdate, parseRecord } from '../index.js';

function modify(newImage: Record<string, unknown>): DynamoDBRecord {
  return { eventName: 'MODIFY', dynamodb: { NewImage: newImage } } as DynamoDBRecord;
}

describe('parseRecord', () => {
  it('includes activeTurnStartedAt while a turn runs', () => {
    const event = parseRecord(
      modify({ sessionId: { S: 's' }, activeTurnStartedAt: { S: '2026-11-01T00:00:00.000Z' } })
    );
    expect(event?.activeTurnStartedAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('reports turnActive=false once the marker is removed', () => {
    const event = parseRecord(modify({ sessionId: { S: 's' } }));
    expect(event?.activeTurnStartedAt).toBeUndefined();
    expect(event?.turnActive).toBe(false);
  });

  it('includes the parent of a child session', () => {
    const event = parseRecord(
      modify({
        sessionId: { S: 's' },
        parent: { M: { sessionId: { S: 'p' }, workflowId: { S: 'w' }, stepId: { S: 'a' } } },
      })
    );
    expect(event?.parent).toEqual({ sessionId: 'p', workflowId: 'w', stepId: 'a' });
  });
});

describe('parseRecord turn lock fields', () => {
  it('includes the turn runner and the rescued runtime session kind', () => {
    const event = parseRecord(
      modify({
        sessionId: { S: 's' },
        activeTurnRunner: { S: 'machine' },
        userRuntimeSessionKind: { S: 'rescued' },
      })
    );
    expect(event?.activeTurnRunner).toBe('machine');
    expect(event?.userRuntimeSessionKind).toBe('rescued');
  });
});

describe('isLeaseOnlyUpdate', () => {
  const base = {
    sessionId: { S: 's' },
    activeTurnOwner: { S: 'r1' },
    activeTurnStartedAt: { S: '2026-11-01T00:00:00.000Z' },
  };
  const record = (
    eventName: 'MODIFY' | 'INSERT',
    oldImage: Record<string, unknown> | undefined,
    newImage: Record<string, unknown>
  ) => ({ eventName, dynamodb: { OldImage: oldImage, NewImage: newImage } }) as DynamoDBRecord;

  it('is true when only the lease changed, regardless of key order', () => {
    const { sessionId, ...rest } = base;
    expect(
      isLeaseOnlyUpdate(
        record(
          'MODIFY',
          { ...base, activeTurnLeaseUntil: { N: '1' } },
          { ...rest, activeTurnLeaseUntil: { N: '2' }, sessionId }
        )
      )
    ).toBe(true);
  });

  it('is false when anything else changed', () => {
    expect(
      isLeaseOnlyUpdate(
        record(
          'MODIFY',
          { ...base, activeTurnLeaseUntil: { N: '1' } },
          { sessionId: { S: 's' }, title: { S: 'new' } }
        )
      )
    ).toBe(false);
  });

  it('is false for inserts and records without an old image', () => {
    expect(isLeaseOnlyUpdate(record('INSERT', undefined, base))).toBe(false);
    expect(isLeaseOnlyUpdate(record('MODIFY', undefined, base))).toBe(false);
  });
});
