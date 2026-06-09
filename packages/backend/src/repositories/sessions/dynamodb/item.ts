/**
 * DynamoDB storage mapping for sessions — IMPLEMENTATION DETAIL.
 *
 * Everything that knows the table layout (the primary key marshalling and the
 * stored-row → summary projection) lives here. Callers of the repository never
 * import this module; it exists so the rest of the codebase can stay in terms
 * of the domain {@link SessionData} / {@link SessionSummary}.
 */

import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { IdentityId } from '@moca/core';
import { pick } from '../../../libs/object/index.js';
import type { SessionData, SessionSummary } from '../types.js';

/**
 * The {@link SessionData} fields exposed in a {@link SessionSummary}. A positive
 * allowlist projected with `pick`, typed as `keyof SessionSummary` so it cannot
 * drift from the summary shape — adding a field to SessionSummary forces it to
 * be listed here (or it won't compile), and nothing outside this list can leak.
 */
const SUMMARY_FIELDS: readonly (keyof SessionSummary)[] = [
  'sessionId',
  'title',
  'agentId',
  'storagePath',
  'sessionType',
  'createdAt',
  'updatedAt',
];

/** The single source of truth for a session's primary key. */
export function sessionKey(
  userId: IdentityId,
  sessionId: string
): Record<string, AttributeValue> {
  return marshall({ userId, sessionId });
}

/** Storage row → domain session. */
export function fromItem(item: Record<string, AttributeValue>): SessionData {
  return unmarshall(item) as SessionData;
}

/** Storage row → frontend-facing summary. The only place that decides which fields a list response exposes. */
export function toSummary(item: Record<string, AttributeValue>): SessionSummary {
  return pick(unmarshall(item) as SessionData, SUMMARY_FIELDS);
}
