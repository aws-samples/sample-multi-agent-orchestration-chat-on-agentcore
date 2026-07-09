/**
 * Shared constants and types for the gpt-image generate + edit tools.
 */

export const DEFAULT_MODEL = 'gpt-image-2';
export const MAX_IMAGES = 4;

// gpt-image models accept a fixed set of size strings plus 'auto' (let the model
// pick). Values verified against the live OpenAI Images API; 'auto' defers the
// decision to the model. Kept as constants so error messages and the JSON
// schemas stay in sync with what we actually forward.
export const VALID_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
export const VALID_QUALITIES = ['low', 'medium', 'high', 'auto'];

/**
 * Interceptor-injected context. `identityId` is required — it keys the per-user
 * S3 prefix. Injected by the Gateway Interceptor from the Cognito ID Token.
 */
export interface UserContext {
  identityId: string;
  storagePath: string;
}
