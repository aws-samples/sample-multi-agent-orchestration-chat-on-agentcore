/**
 * HTTP helper barrel.
 * Shared error codes, success envelope, request-validation schemas, and
 * pagination utilities used by routers and the middleware layer.
 *
 * Errors are signalled by throwing {@link AppError}; the single
 * `errorHandlerMiddleware` renders the envelope. `sendError` is the low-level
 * writer it uses and is not normally called from route handlers.
 */

export {
  ErrorCode,
  ERROR_CODE_REASON,
  ERROR_CODE_STATUS,
  AppError,
} from './error-codes.js';

export {
  type ErrorBody,
  type ResponseMetadata,
  buildMetadata,
  ok,
  sendError,
} from './responses.js';

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseLimit,
  decodePageToken,
  encodePageToken,
  queryString,
} from './pagination.js';

export { zAgentId, zUserId, zSessionId, zTriggerId } from './schemas.js';
