/**
 * System IDs — Well-known Identifiers for Default Agents
 *
 * Default agents are owned by a dedicated "system" user whose ID is a
 * well-known UUID that will never collide with Cognito-issued `sub` values.
 *
 * These agents are stored in DynamoDB with normal UUID v7 agentIds and
 * `isShared: 'true'`, so they appear in the shared-agents list alongside
 * user-shared agents without any special-case branching.
 */

import { parseUserId } from './user-id.js';
import type { UserId } from './user-id.js';

/**
 * Well-known UUID for the system user that owns default agents.
 *
 * - Valid UUID format → passes `isUserId()` / `parseUserId()`
 * - Reserved prefix `00000000-` never appears in Cognito `sub` values
 * - Stored as DynamoDB partition key alongside regular user IDs
 */
export const SYSTEM_USER_ID: UserId = parseUserId('00000000-0000-7000-0000-000000000000');
