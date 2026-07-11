/**
 * Invocation request validation middleware
 *
 * Validates the `/invocations` request body — prompt presence and image
 * payload — before any downstream handlers run. Rejects with 400 on
 * failure.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger/index.js';
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
  // treated as "no goal" (dropped), and an over-long goal is clamped so a
  // pathological payload can't bloat the judge prompt. Downstream (agent.ts)
  // enables GoalLoop only when `goal` is a non-empty string.
  if (typeof body.goal === 'string') {
    const trimmed = body.goal.trim();
    body.goal = trimmed ? trimmed.slice(0, MAX_GOAL_LENGTH) : undefined;
  }

  next();
}

/** Upper bound on the goal string (characters). Longer goals are clamped. */
const MAX_GOAL_LENGTH = 4000;
