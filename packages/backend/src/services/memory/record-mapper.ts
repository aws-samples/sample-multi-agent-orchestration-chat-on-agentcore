/**
 * Long-term memory record mapping — IMPLEMENTATION DETAIL of
 * AgentCoreMemoryService.
 *
 * `listMemoryRecords` and `retrieveMemoryRecords` previously each carried an
 * identical ~25-line block to turn a `MemoryRecordSummary` into the domain
 * {@link MemoryRecord} (content extraction, recordId fallback, ISO stamping).
 * That mapping lives here once so the two call sites can never drift.
 */

import { createLogger } from '../../libs/logger/index.js';

const log = createLogger('AgentCoreMemoryService');

/**
 * Supplements the incomplete AWS SDK type: `memoryRecordSummaries` is not
 * surfaced on the SDK response type, and `content` may be a bare string or a
 * `{ text }` envelope depending on the strategy.
 */
export interface MemoryRecordSummary {
  memoryRecordId?: string;
  content?: string | { text?: string };
  createdAt?: Date;
  namespaces?: string[];
  memoryStrategyId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Long-term memory record (domain shape returned to routes / the UI).
 */
export interface MemoryRecord {
  recordId: string;
  namespace: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Long-term memory record list (domain shape, with pagination token).
 */
export interface MemoryRecordList {
  records: MemoryRecord[];
  nextToken?: string;
}

/** Normalize the polymorphic `content` field to a display string. */
function extractContent(content: MemoryRecordSummary['content']): string {
  if (typeof content === 'object' && content?.text) return content.text;
  if (typeof content === 'string') return content;
  if (content) return JSON.stringify(content);
  return '';
}

/**
 * Map a single AgentCore Memory record summary to the domain {@link MemoryRecord}.
 * Pure except for a warning log when the source record is missing its id (a
 * data-quality signal worth surfacing, but not fatal — the record is still
 * returned with an empty `recordId`).
 *
 * The AWS SDK does not return an `updatedAt`, so it mirrors `createdAt`.
 */
export function mapMemoryRecord(record: MemoryRecordSummary, namespace: string): MemoryRecord {
  const recordId = record.memoryRecordId || '';
  if (!recordId) {
    log.warn({ availableKeys: Object.keys(record) }, 'Memory record summary is missing memoryRecordId');
  }

  const createdAt = record.createdAt?.toISOString() ?? new Date().toISOString();
  return {
    recordId,
    namespace,
    content: extractContent(record.content),
    createdAt,
    updatedAt: createdAt,
  };
}
