/**
 * Webhooks API endpoints
 * Receives external webhook events and forwards them to EventBridge
 */

import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';

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
 */
router.post('/github', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const eventType = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;

  if (!signature || !eventType) {
    logger.warn('Webhook missing required headers');
    return res.status(400).json({ error: 'Missing required GitHub headers' });
  }

  // Verify HMAC signature
  let secret: string;
  try {
    secret = await getWebhookSecret();
  } catch (error) {
    logger.error({ err: error }, 'Failed to retrieve webhook secret:');
    return res.status(500).json({ error: 'Internal server error' });
  }

  const rawBody = JSON.stringify(req.body);
  if (!verifySignature(rawBody, signature, secret)) {
    logger.warn('Webhook signature verification failed (delivery: %s)', deliveryId);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Forward to EventBridge
  try {
    const result = await eventBridgeClient.send(
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

    if (result.FailedEntryCount && result.FailedEntryCount > 0) {
      logger.error({ entry: result.Entries?.[0] }, 'EventBridge PutEvents failed');
      return res.status(500).json({ error: 'Failed to forward event' });
    }

    logger.info(
      'GitHub webhook forwarded to EventBridge (event: %s, delivery: %s)',
      eventType,
      deliveryId
    );
    return res.status(202).json({ message: 'Event accepted' });
  } catch (error) {
    logger.error({ err: error }, 'EventBridge PutEvents error:');
    return res.status(500).json({ error: 'Failed to forward event' });
  }
});

export default router;
