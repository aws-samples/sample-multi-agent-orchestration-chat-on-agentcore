/**
 * Session MODIFY events must carry the running-turn marker so an open UI
 * learns when a turn it did not start (or lost the stream of) begins and ends.
 */

import { describe, it, expect } from '@jest/globals';
import type { DynamoDBRecord } from 'aws-lambda';
import { parseRecord } from '../index.js';

function modify(newImage: Record<string, { S: string }>): DynamoDBRecord {
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
});
