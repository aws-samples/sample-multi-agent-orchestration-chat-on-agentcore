/**
 * AppSync Events Publisher
 *
 * Publishes message events to AppSync Events API for real-time updates.
 * This enables cross-tab/cross-device synchronization and recovery after page reload.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import https from 'https';
import { URL } from 'url';
import { config } from '../config/index.js';
import { logger } from '../libs/logger/index.js';
/**
 * Message event types
 */
export type MessageEventType = 'MESSAGE_ADDED' | 'AGENT_COMPLETE' | 'AGENT_ERROR';

/**
 * Message event to publish
 */
export interface MessageEvent {
  type: MessageEventType;
  sessionId: string;
  message?: {
    role: 'user' | 'assistant';
    content: unknown[]; // ContentBlock array from agent SDK
    timestamp: string;
  };
  error?: string;
  requestId?: string;
}

/**
 * HTTP response
 */
interface HttpResponse {
  statusCode: number;
  body: string;
}

/**
 * Make HTTPS request with signed headers
 */
async function makeRequest(
  url: string,
  options: https.RequestOptions,
  body: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Publish message event to AppSync Events API
 *
 * @param userId - User ID for channel routing
 * @param sessionId - Session ID for channel routing
 * @param event - Message event to publish
 */
export async function publishMessageEvent(
  userId: string,
  sessionId: string,
  event: MessageEvent
): Promise<void> {
  const endpoint = config.APPSYNC_HTTP_ENDPOINT;
  const region = config.AWS_REGION;

  if (!endpoint) {
    // Silently skip if not configured (optional feature)
    logger.debug('APPSYNC_HTTP_ENDPOINT not configured, skipping publish');
    return;
  }

  const channel = `/messages/${userId}/${sessionId}`;
  const url = new URL(endpoint);

  const body = JSON.stringify({
    channel,
    events: [JSON.stringify(event)],
  });

  try {
    // Create signer
    const signer = new SignatureV4({
      service: 'appsync',
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });

    // Create request to sign
    const request = {
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : 443,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        host: url.hostname,
      },
      body,
    };

    // Sign the request
    const signedRequest = await signer.sign(request);

    // Make the request
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: signedRequest.headers,
    };

    await makeRequest(url.href, options, body);
    logger.debug({ type: event.type }, `Published message event to ${channel}`);
  } catch (error) {
    // Log detailed error information for debugging
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Unknown',
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : undefined,
      channel,
      type: event.type,
    };
    logger.warn({ err: errorDetails }, 'Failed to publish message event to AppSync Events:');
  }
}
