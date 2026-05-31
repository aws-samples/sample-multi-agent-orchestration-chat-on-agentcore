/**
 * Backend libs module exports
 * Provider Layer (-1): Cross-cutting concerns accessible from all layers
 */

// Authentication infrastructure
export * from './auth/index.js';

// MCP client infrastructure
export * from './mcp/index.js';

// HTTP response envelope, error codes, and pagination helpers
export * from './http/index.js';
