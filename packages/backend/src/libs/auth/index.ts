/**
 * Authentication infrastructure module exports
 */

export { hydrateJWKS, verifyJWT, verifyIdToken, extractJWTFromHeader } from './jwks.js';
export { resolveIdentityId } from './identity-resolver.js';
export { createAgentCoreClient, createScopedS3Client } from './scoped-credentials.js';
