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
import { config } from '../../config/index.js';
import { isAllowedModelId } from '../utils/allowed-models.js';

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

  // IAM is scoped to the deployment's models, but an unchecked id would still
  // reach metering (and the Backend's usage rows) unvalidated.
  if (body.modelId !== undefined && body.modelId !== null && typeof body.modelId !== 'string') {
    res.status(400).json({ error: 'modelId must be a string' });
    return;
  }
  // '' / null mean "use the default model" (runAgentTurn: body.modelId || BEDROCK_MODEL_ID).
  if (body.modelId && !isAllowedModelId(body.modelId, config.BEDROCK_MODEL_IDS)) {
    res.status(400).json({ error: `Model is not available in this deployment: ${body.modelId}` });
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

  next();
}
