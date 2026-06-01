/**
 * Shared Zod schemas for request validation.
 *
 * Branded-ID schemas wrap the `is*` guards from `@moca/core` so a validated
 * value is both runtime-checked AND carries the branded type, letting route
 * handlers drop the manual `isXxxId(...) ? parseXxxId(...) : undefined` dance.
 * Validation failures are turned into an `AppError(VALIDATION_ERROR)` with
 * structured `fieldViolations` by the `validate` middleware.
 */

import { z } from 'zod';
import {
  isAgentId,
  isSessionId,
  isTriggerId,
  isUserId,
  type AgentId,
  type SessionId,
  type TriggerId,
  type UserId,
} from '@moca/core';

/** A Zod schema that accepts a string and narrows it to a branded id. */
export const zAgentId = z.string().refine(isAgentId, {
  message: 'must be a valid agentId (UUID)',
}) as unknown as z.ZodType<AgentId>;

export const zUserId = z.string().refine(isUserId, {
  message: 'must be a valid userId (UUID)',
}) as unknown as z.ZodType<UserId>;

export const zSessionId = z.string().refine(isSessionId, {
  message: 'must be a valid sessionId (33 alphanumeric characters)',
}) as unknown as z.ZodType<SessionId>;

export const zTriggerId = z.string().refine(isTriggerId, {
  message: 'must be a valid triggerId (UUID)',
}) as unknown as z.ZodType<TriggerId>;
