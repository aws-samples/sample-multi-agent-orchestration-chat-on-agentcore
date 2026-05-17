/**
 * Session Stream Handler Lambda
 *
 * Processes DynamoDB Streams events from the Sessions table
 * and publishes them to AppSync Events API for real-time updates.
 */
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import https from 'https';
import { URL } from 'url';
import { createLogger } from './libs/logger/index.js';

const log = createLogger('SessionStreamHandler');

/**
 * Session type
 */
type SessionType = 'user' | 'event' | 'subagent';

/**
 * Session event to publish
 */
interface SessionEvent {
  type: 'INSERT' | 'MODIFY' | 'REMOVE';
  sessionId: string;
  title?: string;
  agentId?: string;
  sessionType?: SessionType;
  updatedAt?: string;
  createdAt?: string;
  /**
   * Cognito User Pool sub (UUID, no colons) stored at session creation time.
   * Used to build the AppSync channel path instead of the identityId partition
   * key (REGION:UUID format) which AppSync rejects due to the colon character.
   */
  channelUserId?: string;
}

/**
 * HTTP response
 */
interface HttpResponse {
  statusCode: number;
  body: string;
}

/**
 * Parse DynamoDB Streams record to session event
 */
function parseRecord(record: DynamoDBRecord): SessionEvent | null {
  const eventName = record.eventName as 'INSERT' | 'MODIFY' | 'REMOVE';
  const image = record.dynamodb?.NewImage || record.dynamodb?.OldImage;

  if (!image) {
    return null;
  }

  return {
    type: eventName,
    sessionId: (image.sessionId as { S: string })?.S || '',
    title: (image.title as { S: string })?.S,
    agentId: (image.agentId as { S: string })?.S,
    sessionType: (image.sessionType as { S: string })?.S as SessionType | undefined,
    updatedAt: (image.updatedAt as { S: string })?.S,
    createdAt: (image.createdAt as { S: string })?.S,
    channelUserId: (image.channelUserId as { S: string })?.S,
  };
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
 * Publish event to AppSync Events API
 */
async function publishToAppSync(userId: string, event: SessionEvent): Promise<void> {
  const endpoint = process.env.APPSYNC_HTTP_ENDPOINT;
  const region = process.env.AWS_REGION || 'ap-northeast-1';

  if (!endpoint) {
    log.error('APPSYNC_HTTP_ENDPOINT not configured');
    return;
  }

  const channel = `/sessions/${userId}`;
  const url = new URL(endpoint);

  const body = JSON.stringify({
    channel,
    events: [JSON.stringify(event)],
  });

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
}

/**
 * Lambda handler for DynamoDB Streams
 */
export const handler = async (
  event: DynamoDBStreamEvent
): Promise<{ statusCode: number; body: string }> => {
  let publishedCount = 0;

  for (const record of event.Records) {
    try {
      const userId = (record.dynamodb?.Keys?.userId as { S: string })?.S;
      if (!userId) {
        log.warn('No userId in record, skipping');
        continue;
      }

      const sessionEvent = parseRecord(record);
      if (!sessionEvent) {
        log.warn('Could not parse record, skipping');
        continue;
      }

      // Use the Cognito User Pool sub (UUID, no colons) for the AppSync channel
      // path. The DynamoDB partition key `userId` is actually the identityId
      // (REGION:UUID format) which AppSync rejects due to the colon character.
      // `channelUserId` is written to every session record at creation time.
      const { channelUserId } = sessionEvent;
      if (!channelUserId) {
        log.warn('No channelUserId in record, skipping');
        continue;
      }
      await publishToAppSync(channelUserId, sessionEvent);
      publishedCount++;
    } catch (error) {
      log.error({ err: error }, 'Failed to process record');
      // Don't throw - continue processing other records
    }
  }

  if (publishedCount > 0) {
    log.info({ publishedCount }, 'Published session events');
  }

  return { statusCode: 200, body: 'OK' };
};
