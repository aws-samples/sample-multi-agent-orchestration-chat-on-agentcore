/**
 * mapMemoryRecord — long-term memory summary → domain MemoryRecord.
 *
 * This is the single mapping shared by `listMemoryRecords` and
 * `retrieveMemoryRecords`; testing it directly (it is pure) removes the need to
 * mock the AWS SDK to exercise the content-extraction / fallback rules.
 */

import { describe, it, expect } from '@jest/globals';
import { mapMemoryRecord } from '../record-mapper.js';

const NS = '/strategies/strat-1/actors/actor-1';

describe('mapMemoryRecord', () => {
  it('extracts text from an object content ({ text })', () => {
    const rec = mapMemoryRecord(
      { memoryRecordId: 'r1', content: { text: 'hello' }, createdAt: new Date('2024-01-01T00:00:00Z') },
      NS
    );
    expect(rec).toEqual({
      recordId: 'r1',
      namespace: NS,
      content: 'hello',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('passes through string content unchanged', () => {
    const rec = mapMemoryRecord({ memoryRecordId: 'r2', content: 'plain' }, NS);
    expect(rec.content).toBe('plain');
  });

  it('JSON-stringifies non-string, non-{text} content', () => {
    const rec = mapMemoryRecord({ memoryRecordId: 'r3', content: { foo: 1 } as never }, NS);
    expect(rec.content).toBe('{"foo":1}');
  });

  it('defaults content to empty string when absent', () => {
    const rec = mapMemoryRecord({ memoryRecordId: 'r4' }, NS);
    expect(rec.content).toBe('');
  });

  it('falls back to an empty recordId when memoryRecordId is missing', () => {
    const rec = mapMemoryRecord({ content: 'x' }, NS);
    expect(rec.recordId).toBe('');
  });

  it('stamps the supplied namespace', () => {
    const rec = mapMemoryRecord({ memoryRecordId: 'r5' }, NS);
    expect(rec.namespace).toBe(NS);
  });
});
