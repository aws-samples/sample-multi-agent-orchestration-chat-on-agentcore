/**
 * Invocation request validation middleware
 *
 * Validates the `/invocations` request body — prompt presence and image
 * payload — before any downstream handlers run. Rejects with 400 on
 * failure.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
import { GOAL_LOOP_ATTEMPTS_MIN, GOAL_LOOP_ATTEMPTS_MAX } from '../../config/index.js';
import { validateImageData } from '../../types/index.js';
import type { InvocationRequest } from '../../types/invocation-types.js';

/**
 * Express middleware that validates `InvocationRequest` body.
 * On validation failure responds with 400 and short-circuits the chain.
 */
export function validateInvocationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const body = req.body as InvocationRequest | undefined;

  if (!body) {
    res.status(400).json({ error: 'Request body is required' });
    return;
  }

  // Validate prompt (allow empty prompt if images are provided)
  const hasImages = body.images && body.images.length > 0;
  if (!body.prompt?.trim() && !hasImages) {
    res.status(400).json({ error: 'Empty prompt provided' });
    return;
  }

  // Validate images
  if (body.images && body.images.length > 0) {
    const validation = validateImageData(body.images);
    if (!validation.valid) {
      logger.warn({ error: validation.error }, 'Image validation failed:');
      res.status(400).json({ error: validation.error });
      return;
    }
  }

  // Normalize the optional GoalLoop goal in place: a whitespace-only goal is
  // treated as "no goal" (dropped). An over-long goal is REJECTED (not
  // clamped): a goal is a natural-language criterion, and cutting it
  // mid-string can invert its meaning (e.g. truncating just before a
  // negation), making the judge grade against a corrupted criterion with no
  // signal to the user. Rejecting keeps this middleware's fail-loud contract
  // consistent with the prompt/image checks above.
  if (typeof body.goal === 'string') {
    const trimmed = body.goal.trim();
    if (trimmed.length > MAX_GOAL_LENGTH) {
      res.status(400).json({
        error: `Goal is too long (${trimmed.length} chars). Maximum is ${MAX_GOAL_LENGTH} characters.`,
      });
      return;
    }
    body.goal = trimmed || undefined;
  }

  // Normalize the optional GoalLoop attempt cap: non-numbers / non-integers
  // are dropped (agent falls back to GOAL_LOOP_MAX_ATTEMPTS), out-of-range
  // integers are clamped so a pathological payload can't spin the loop.
  if (body.goalMaxAttempts !== undefined) {
    const n = body.goalMaxAttempts;
    body.goalMaxAttempts =
      typeof n === 'number' && Number.isInteger(n)
        ? Math.min(Math.max(n, GOAL_LOOP_ATTEMPTS_MIN), GOAL_LOOP_ATTEMPTS_MAX)
        : undefined;
  }

  next();
}

/** Upper bound on the goal string (characters). Longer goals are rejected with 400. */
const MAX_GOAL_LENGTH = 4000;
