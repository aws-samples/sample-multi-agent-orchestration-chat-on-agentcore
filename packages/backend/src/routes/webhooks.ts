/**
 * Webhooks API endpoints
 * Receives external webhook events and forwards them to EventBridge
 */

import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { AppError, ErrorCode } from '../libs/http/index.js';

const router = Router();
const secretsClient = new SecretsManagerClient({});
const eventBridgeClient = new EventBridgeClient({});

// Cache webhook secret in memory
let cachedSecret: string | undefined;

async function getWebhookSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const secretName = config.GITHUB_WEBHOOK_SECRET_NAME;
  if (!secretName) {
    throw new Error('GITHUB_WEBHOOK_SECRET_NAME environment variable not configured');
  }

  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!result.SecretString) {
    throw new Error('Webhook secret is empty');
  }

  cachedSecret = result.SecretString;
  return cachedSecret;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * GitHub Webhook receiver
 * POST /webhooks/github
 *
 * No JWT auth - security is via HMAC-SHA256 signature verification.
 * Forwards events to EventBridge with source "github.com" and
 * detail-type from the x-github-event header.
 *
 * GitHub is the consumer (not the SPA), so this handler keeps the original HTTP
 * status codes and a custom `202 { message, deliveryId }` success shape rather
 * than the canonical `ok()` envelope. Failures throw `AppError`; the global
 * error handler maps them to the expected status codes.
 */
router.post(
  '/github',
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const eventType = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!signature || !eventType) {
      logger.warn('Webhook missing required headers');
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Missing required GitHub headers');
    }

    // Verify HMAC signature
    let secret: string;
    try {
      secret = await getWebhookSecret();
    } catch (error) {
      // Do not leak the underlying Secrets Manager error to the caller.
      logger.error({ err: error }, 'Failed to retrieve webhook secret:');
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to process webhook');
    }

    const rawBody = JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature, secret)) {
      logger.warn('Webhook signature verification failed (delivery: %s)', deliveryId);
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Invalid signature');
    }

    // Forward to EventBridge
    let result;
    try {
      result = await eventBridgeClient.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: 'github.com',
              DetailType: eventType,
              Detail: rawBody,
              EventBusName: 'default',
            },
          ],
        })
      );
    } catch (error) {
      logger.error({ err: error }, 'EventBridge PutEvents error:');
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to forward event');
    }

    if (result.FailedEntryCount && result.FailedEntryCount > 0) {
      logger.error({ entry: result.Entries?.[0] }, 'EventBridge PutEvents failed');
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to forward event');
    }

    logger.info(
      'GitHub webhook forwarded to EventBridge (event: %s, delivery: %s)',
      eventType,
      deliveryId
    );
    res.status(202).json({ message: 'Event accepted', deliveryId });
  })
);

export default router;
