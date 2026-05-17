/**
 * libs/ - Provider Layer: Cross-cutting concerns
 *
 * This module provides utilities, MCP client, request context, and middleware
 * that can be accessed from any core layer.
 *
 * libs/ can only depend on types/ (L0) and config/ (L1).
 */

// Utils
export * from './utils/index.js';

// MCP (Model Context Protocol)
export * from './mcp/index.js';

// Request Context
export * from './context/index.js';

// Middleware
export * from './middleware/index.js';

// Auth
export * from './auth/index.js';
