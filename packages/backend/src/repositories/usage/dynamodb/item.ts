import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { UserId } from '@moca/core';
import type { MonthlyModelUsage } from '../types.js';

/** Rows outlive their month by ~13 months so a year-over-year view stays possible. */
const RETENTION_DAYS_AFTER_MONTH = 400;

export function usageSortKey(month: string, modelKey: string): string {
  return `M#${month}#${modelKey}`;
}

export function monthPrefix(month: string): string {
  return `M#${month}#`;
}

/** Batch markers only need to outlive the Runtime's retries (seconds); a day is plenty. */
export const BATCH_MARKER_TTL_SECONDS = 86_400;

export function batchMarkerKey(userId: UserId, batchId: string): Record<string, AttributeValue> {
  return { userId: { S: userId }, sk: { S: `B#${batchId}` } };
}

export function ttlForMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  const monthEnd = Date.UTC(y, m, 1); // first instant of the next month (UTC)
  return Math.floor(monthEnd / 1000) + RETENTION_DAYS_AFTER_MONTH * 86_400;
}

export function keyAttr(
  userId: UserId,
  month: string,
  modelKey: string
): Record<string, AttributeValue> {
  return { userId: { S: userId }, sk: { S: usageSortKey(month, modelKey) } };
}

const num = (item: Record<string, AttributeValue>, name: string): number =>
  item[name]?.N !== undefined ? Number(item[name].N) : 0;

export function fromItemAttr(item: Record<string, AttributeValue>): MonthlyModelUsage {
  const sk = item.sk?.S ?? '';
  // sk = M#YYYY-MM#<modelKey>; model ids never contain '#'.
  const modelKey = sk.split('#').slice(2).join('#');
  return {
    modelKey,
    inputTokens: num(item, 'inputTokens'),
    outputTokens: num(item, 'outputTokens'),
    uncachedInputTokens: num(item, 'uncachedInputTokens'),
    cacheReadInputTokens: num(item, 'cacheReadInputTokens'),
    cacheWriteInputTokens: num(item, 'cacheWriteInputTokens'),
    calls: num(item, 'calls'),
  };
}
