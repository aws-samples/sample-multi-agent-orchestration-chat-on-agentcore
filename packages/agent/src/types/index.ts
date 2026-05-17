/**
 * types/ - Layer 0: Type Definitions, Schemas, Validation
 *
 * This module exports all type definitions, Zod schemas, and validation logic.
 * It is the foundational layer that all other layers depend on.
 */

// Session types
export * from './session-types.js';
export type { SessionType } from './session-types.js';

// Workspace sync types
export * from './workspace-sync-types.js';

// Agent types
export * from './agent-types.js';

// Session persistence deps types
export * from './session-persistence-deps.js';

// Invocation request types
export * from './invocation-types.js';

// Schema types and converters
export * from './schemas/types.js';
export * from './schemas/zod-converter.js';

// Validation utilities
export {
  validateImageData,
  IMAGE_VALIDATION_CONFIG,
  type ImageData,
  type ValidationResult,
} from './validation/image-validator.js';
