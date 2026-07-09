/**
 * OpenAI Images API common utilities
 *
 * Lambda-side implementation. The API key is resolved exclusively from Secrets
 * Manager via the OPENAI_API_KEY_SECRET_NAME environment variable and cached for
 * the container lifetime (one Secrets Manager call per cold start).
 *
 * We call the OpenAI native REST API directly (api.openai.com) rather than going
 * through Bedrock: unlike the chat models (gpt-oss / gpt-5.x, which Moca invokes
 * over Bedrock's OpenAI-compatible endpoint with a minted bearer token), image
 * generation uses a plain OpenAI API key. This mirrors the Tavily tools' secret
 * handling pattern.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from '@moca/lambda-tools-shared';

let cachedApiKey: string | null = null;
const secretsClient = new SecretsManagerClient({});

/**
 * Retrieve the OpenAI API key from Secrets Manager.
 * In-process cache is populated on first call per Lambda container.
 */
export async function getOpenAiApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;

  const secretName = process.env.OPENAI_API_KEY_SECRET_NAME;
  if (!secretName) {
    throw new Error('OPENAI_API_KEY_SECRET_NAME environment variable is not set');
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = response.SecretString;
    if (!value) {
      throw new Error(`Secret ${secretName} has no SecretString`);
    }
    cachedApiKey = value.trim();
    logger.info('OPENAI_API_KEY_LOADED', { secretName });
    return cachedApiKey;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('OPENAI_API_KEY_LOAD_ERROR', { secretName, error: message });
    throw new Error(`Failed to retrieve OpenAI API key from Secrets Manager: ${message}`, {
      cause: error,
    });
  }
}

/**
 * Reset the in-process API key cache.
 * Intended for unit/integration tests only.
 */
export function __resetApiKeyCacheForTests(): void {
  cachedApiKey = null;
}

const OPENAI_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Request body for the OpenAI Images generation endpoint. Only the fields Moca
 * forwards are typed; the API accepts more, but we deliberately keep the surface
 * small and let it apply its own defaults for anything omitted.
 */
export interface OpenAiImageRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
}

/** One generated image. gpt-image models return base64 (no hosted URL). */
export interface OpenAiImageDatum {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

export interface OpenAiImageResponse {
  created: number;
  data: OpenAiImageDatum[];
}

/** A source image for an edit request: the raw bytes plus a filename hint so
 *  multipart/form-data carries a sensible content type + extension. */
export interface EditImagePart {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Parameters for an image edit. `images` are the source image(s) to edit or use
 * as references; `mask` is an optional alpha-channel PNG restricting where edits
 * apply (prompt-guided, not pixel-precise per OpenAI docs).
 */
export interface OpenAiImageEditRequest {
  model: string;
  prompt: string;
  images: EditImagePart[];
  mask?: EditImagePart;
  n?: number;
  size?: string;
  quality?: string;
}

/**
 * Call the OpenAI Images generation endpoint with bearer auth and a JSON POST.
 * Throws an Error carrying a readable, provider-formatted reason on non-2xx.
 */
export async function callOpenAiImageApi(body: OpenAiImageRequest): Promise<OpenAiImageResponse> {
  return postJson(OPENAI_GENERATIONS_URL, body);
}

/**
 * Call the OpenAI Images EDIT endpoint. Unlike generations (JSON), edits require
 * multipart/form-data because they carry binary image + mask parts. Multiple
 * source images are sent as repeated `image[]` fields (references / composition).
 */
export async function callOpenAiImageEditApi(
  body: OpenAiImageEditRequest
): Promise<OpenAiImageResponse> {
  const apiKey = await getOpenAiApiKey();

  const form = new FormData();
  form.append('model', body.model);
  form.append('prompt', body.prompt);
  if (body.n !== undefined) form.append('n', String(body.n));
  if (body.size !== undefined) form.append('size', body.size);
  if (body.quality !== undefined) form.append('quality', body.quality);
  for (const img of body.images) {
    form.append('image[]', new Blob([img.bytes], { type: img.contentType }), img.filename);
  }
  if (body.mask) {
    form.append(
      'mask',
      new Blob([body.mask.bytes], { type: body.mask.contentType }),
      body.mask.filename
    );
  }

  // No explicit Content-Type header: fetch derives the multipart boundary from
  // the FormData body. Setting it manually would omit the boundary and break parsing.
  const response = await fetch(OPENAI_EDITS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response));
  }

  return (await response.json()) as OpenAiImageResponse;
}

/**
 * Shared JSON POST + error handling for the generations endpoint.
 */
async function postJson(url: string, body: unknown): Promise<OpenAiImageResponse> {
  const apiKey = await getOpenAiApiKey();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response));
  }

  return (await response.json()) as OpenAiImageResponse;
}

/**
 * Decode a non-2xx response into a readable message, preferring the JSON error
 * body and falling back to status/statusText when the body is not JSON.
 */
async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const errBody = (await response.json()) as unknown;
    return formatOpenAiApiError(response.status, errBody);
  } catch {
    return `OpenAI Images API error (${response.status} ${response.statusText})`;
  }
}

/**
 * Format an OpenAI API error response into a readable string.
 *
 * OpenAI's canonical error shape is `{ error: { message, type, code, param } }`,
 * but proxies / edge cases sometimes return `{ error: "..." }` (string) or a
 * bare `{ message: "..." }`. `pickString` skips non-string values so we fall
 * through to `JSON.stringify(body)` rather than emitting "[object Object]".
 */
export function formatOpenAiApiError(status: number, body: unknown): string {
  const prefix = `OpenAI Images API error (${status})`;

  if (body === null || body === undefined) return `${prefix}: <no response body>`;
  if (typeof body !== 'object') return `${prefix}: ${String(body)}`;

  const data = body as Record<string, unknown>;
  const pickString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const nestedError =
    typeof data.error === 'object' && data.error !== null
      ? (data.error as Record<string, unknown>)
      : null;

  const reason =
    (nestedError && pickString(nestedError.message)) ??
    pickString(data.error) ??
    pickString(data.message) ??
    JSON.stringify(data);

  // Surface content-policy blocks distinctly. Per OpenAI docs these are user
  // errors ("do not automatically retry without modifying the prompt/inputs"),
  // so we flag them so the agent asks the user to revise rather than retrying.
  const code = nestedError && pickString(nestedError.code);
  if (code === 'moderation_blocked') {
    return `${prefix}: content moderation blocked this request (do not retry without changing the prompt/inputs) — ${reason}`;
  }

  return `${prefix}: ${reason}`;
}
