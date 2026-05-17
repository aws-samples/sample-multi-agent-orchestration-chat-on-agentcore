/**
 * Tavily API common utilities
 *
 * Lambda-side implementation. API key is resolved exclusively from Secrets Manager
 * via the TAVILY_API_KEY_SECRET_NAME environment variable. The resolved key is cached
 * for the container lifetime to minimize Secrets Manager calls (one per cold start).
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from '@moca/lambda-tools-shared';

/**
 * Truncate content to a safe size limit.
 */
export function truncateContent(content: string, maxLength: number): string {
  if (maxLength <= 0) {
    throw new RangeError(`maxLength must be > 0, got ${maxLength}`);
  }
  if (content.length <= maxLength) {
    return content;
  }
  const truncated = content.substring(0, maxLength);
  return `${truncated}... (Content truncated due to length. Original length: ${content.length} characters)`;
}

let cachedApiKey: string | null = null;
const secretsClient = new SecretsManagerClient({});

/**
 * Retrieve Tavily API Key from Secrets Manager.
 * In-process cache is populated on first call per Lambda container.
 */
export async function getTavilyApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  const secretName = process.env.TAVILY_API_KEY_SECRET_NAME;
  if (!secretName) {
    throw new Error('TAVILY_API_KEY_SECRET_NAME environment variable is not set');
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = response.SecretString;
    if (!value) {
      throw new Error(`Secret ${secretName} has no SecretString`);
    }
    cachedApiKey = value;
    logger.info('TAVILY_API_KEY_LOADED', { secretName });
    return cachedApiKey;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('TAVILY_API_KEY_LOAD_ERROR', { secretName, error: message });
    throw new Error(`Failed to retrieve Tavily API key from Secrets Manager: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Reset the in-process API key cache.
 * Intended for unit tests only.
 */
export function __resetApiKeyCacheForTests(): void {
  cachedApiKey = null;
}

/**
 * Supported Tavily API endpoints. Shared between `callTavilyApi` and
 * `formatTavilyApiError` so that endpoint identifiers stay in sync.
 */
export type TavilyEndpoint = 'search' | 'extract' | 'crawl';

/**
 * Raw image entry returned by Tavily. The concrete shape depends on whether
 * `include_image_descriptions: true` was sent:
 *   - `true`  → `{ url, description? }` object
 *   - `false` or omitted → plain URL string
 *
 * Our tools currently do not request descriptions, so responses typically arrive
 * as strings. Assuming only the object shape (as the initial implementation did)
 * caused `image.url` to be `undefined` and leaked the literal "undefined" into
 * the formatted output.
 */
export type TavilyImage = string | { url?: string; description?: string };

export interface NormalizedTavilyImage {
  url: string;
  description?: string;
}

/**
 * Normalize a Tavily image entry into `{ url, description? }`.
 *
 * Returns `null` for entries that cannot yield a usable URL (plain string was
 * empty, object was missing `url`, or the entry itself was null/undefined) so
 * callers can silently skip them rather than emit "undefined" rows.
 */
export function normalizeTavilyImage(
  img: TavilyImage | undefined | null
): NormalizedTavilyImage | null {
  if (img == null) return null;
  if (typeof img === 'string') {
    return img.length > 0 ? { url: img } : null;
  }
  if (typeof img === 'object' && typeof img.url === 'string' && img.url.length > 0) {
    return { url: img.url, description: img.description };
  }
  return null;
}

const TAVILY_API_BASE_URL = 'https://api.tavily.com';

/**
 * Call a Tavily API endpoint using the shared bearer-auth + JSON POST contract.
 *
 * All three Tavily endpoints (search / extract / crawl) share the same request
 * shape and error-payload conventions; only the URL path and the response type
 * differ. This helper centralizes the HTTP concerns (auth header injection,
 * error body decoding, status handling) so the per-tool modules only need to
 * assemble request parameters and format the decoded response.
 */
export async function callTavilyApi<T>(
  endpoint: TavilyEndpoint,
  params: Record<string, unknown>
): Promise<T> {
  const apiKey = await getTavilyApiKey();
  const response = await fetch(`${TAVILY_API_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    // See formatTavilyApiError below for rationale on the various Tavily error
    // payload shapes and how we pick a readable reason.
    let errorMessage = `Tavily ${endpoint} API error (${response.status} ${response.statusText})`;
    try {
      const body = (await response.json()) as unknown;
      errorMessage = formatTavilyApiError(endpoint, response.status, body);
    } catch {
      // Response body was not JSON; keep the status/statusText-only message
    }
    throw new Error(errorMessage);
  }

  return (await response.json()) as T;
}

/**
 * Format a Tavily API error response into a readable string.
 *
 * Tavily returns error payloads in several shapes depending on the failure mode:
 *   { error: "message" }                  — most common explicit API errors
 *   { error: { code, message, details } } — some 4xx validation errors (nested object)
 *   { detail: "message" }                 — FastAPI-style validation errors
 *   { message: "message" }                — rate-limit / quota errors
 *   { code: "ERR_CODE" }                  — short machine-readable error codes
 *
 * Earlier versions picked the first non-undefined field, which inadvertently
 * emitted `[object Object]` when the top-level `error` was a nested object.
 * `pickString` skips non-string values so we fall through to the full
 * `JSON.stringify(body)` rather than stringifying an opaque object directly.
 */
export function formatTavilyApiError(
  endpoint: TavilyEndpoint,
  status: number,
  body: unknown
): string {
  const prefix = `Tavily ${endpoint} API error (${status})`;

  if (body === null || body === undefined) return `${prefix}: <no response body>`;
  if (typeof body !== 'object') return `${prefix}: ${String(body)}`;

  const data = body as Record<string, unknown>;
  const pickString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const reason =
    pickString(data.error) ??
    pickString(data.detail) ??
    pickString(data.message) ??
    pickString(data.code) ??
    JSON.stringify(data);

  return `${prefix}: ${reason}`;
}
