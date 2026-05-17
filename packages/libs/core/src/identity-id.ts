/**
 * IdentityId — Branded Type + Validator
 *
 * Represents a Cognito Identity Pool identity ID.
 * Format: "REGION:UUID" (e.g. "us-east-1:d7a41aa8-8031-70e8-4916-4c302e63588a")
 *
 * The identityId is the canonical key for per-user storage (S3 prefix,
 * DynamoDB partition key) because the IAM policy variable
 * ${cognito-identity.amazonaws.com:sub} — which expands to this value — is
 * the only variable correctly expanded in BOTH Resource ARNs and Condition
 * blocks when credentials come from GetCredentialsForIdentity.
 *
 * By branding this as `IdentityId`, the compiler prevents accidental swaps
 * with other string identifiers such as `UserId` (User Pool sub UUID).
 */

import type { Brand } from './branded.js';

// ---------------------------------------------------------------------------
// Branded Type
// ---------------------------------------------------------------------------

export type IdentityId = Brand<string, 'IdentityId'>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cognito Identity Pool identity ID pattern.
 * Format: "<region>:<uuid-v4>"
 * Example: "us-east-1:d7a41aa8-8031-70e8-4916-4c302e63588a"
 */
export const IDENTITY_ID_PATTERN =
  /^[a-z]{2}-(?:(?:gov-)?[a-z]+-\d):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

export function isIdentityId(value: string): value is IdentityId {
  return IDENTITY_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseIdentityId(value: string): IdentityId {
  if (!isIdentityId(value)) {
    throw new Error(
      `Invalid identityId: must match "<region>:<uuid>" format (e.g. "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"), got "${value}"`
    );
  }
  return value;
}
