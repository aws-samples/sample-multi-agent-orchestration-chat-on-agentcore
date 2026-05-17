import { authService, NotAuthenticatedError as AuthNotAuthenticatedError } from '../../lib/auth';
import type { AuthTokens } from '../../lib/auth';
import { ApiError, AuthenticationError } from '../../types/errors';
import { logger } from '../../utils/logger';

// Re-export error classes for backward compatibility with existing consumers.
export { ApiError, AuthenticationError };

/**
 * Enables verbose API logging.
 *
 * WHY a runtime toggle (not just `import.meta.env.DEV`): operators sometimes
 * need to flip API debug logs on in a deployed build via
 * `VITE_API_DEBUG=true` without rebuilding in DEV mode.
 */
function isDebugEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_API_DEBUG === 'true';
}

function buildHeaders(tokens: AuthTokens, extra?: HeadersInit): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
    // Forwarded to AgentCore Runtime so it can exchange the id token for
    // Identity Pool temporary credentials scoped to the caller.
    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': tokens.idToken,
    ...((extra as Record<string, string>) ?? {}),
  };
}

/**
 * Base API Client
 *
 * Handles authenticated HTTP requests with a single 401 retry path:
 *   1. On 401, call `authService.getTokens({ forceRefresh: true })` so
 *      Amplify *always* performs the refresh-token exchange (no clock-based
 *      shortcut that could hand back the same token the server just
 *      rejected).
 *   2. Pass the freshly returned tokens directly to a new `fetch()`. We do
 *      not recurse back through this method; doing so would cause a second
 *      `getTokens()` call and reopen a race between cross-tab refreshes.
 *
 * The 401 toast + logout are owned by `AuthProvider` (via Amplify Hub).
 * This layer just throws `ApiError`/`AuthenticationError` upward.
 */
export class BaseApiClient {
  protected readonly clientName: string;

  constructor(clientName: string) {
    this.clientName = clientName;
  }

  /**
   * Authenticated fetch with exactly one 401-triggered refresh + retry.
   *
   * On a 401 response:
   *   1. Force Amplify to exchange the refresh token.
   *   2. Use the freshly returned tokens to issue a single retry with a
   *      direct `fetch()` (no recursion back through this method, which
   *      would have fetched tokens a second time and re-opened the race).
   *   3. If the retry also returns 401 — or the refresh itself fails —
   *      throw an `ApiError`/`AuthenticationError`. We do NOT call a global
   *      logout here; Amplify's Hub emits `tokenRefresh_failure` on its own
   *      and the central `AuthProvider` listener handles session-ended UX.
   */
  protected async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const method = options.method || 'GET';

    try {
      this.logStart(method, url);

      let tokens: AuthTokens;
      try {
        tokens = await authService.getTokens();
      } catch (err) {
        if (err instanceof AuthNotAuthenticatedError) {
          throw new AuthenticationError(err.message);
        }
        throw err;
      }

      const response = await fetch(url, {
        ...options,
        headers: buildHeaders(tokens, options.headers),
      });

      if (response.status !== 401) {
        this.logSuccess(method, url, response.status);
        return response;
      }

      // --- 401 retry path ---
      logger.warn(
        '[%s] 401 on %s %s — forcing token refresh and retrying once',
        this.clientName,
        method,
        url
      );

      let refreshed: AuthTokens;
      try {
        refreshed = await authService.getTokens({ forceRefresh: true });
      } catch (refreshErr) {
        // Refresh failed: Amplify already emitted `tokenRefresh_failure`,
        // which AuthProvider consumes to clear the session and inform the
        // user via a single toast. We just translate the failure into an
        // ApiError for call-site error handling.
        logger.warn('[%s] Token refresh failed after 401: %s', this.clientName, refreshErr);
        throw new ApiError('Unauthorized', 401, 'Unauthorized');
      }

      const retryResponse = await fetch(url, {
        ...options,
        headers: buildHeaders(refreshed, options.headers),
      });

      if (retryResponse.status === 401) {
        logger.warn(
          '[%s] Retry after refresh still returned 401 for %s %s',
          this.clientName,
          method,
          url
        );
        throw new ApiError('Unauthorized', 401, 'Unauthorized');
      }

      this.logSuccess(method, url, retryResponse.status);
      return retryResponse;
    } catch (error) {
      this.logError(method, url, error);
      throw error;
    }
  }

  /**
   * Parse an error response into a typed {@link ApiError}.
   *
   * Intentionally never attempts to parse on 401 — those are produced
   * directly above with a stable message/shape.
   */
  protected async handleErrorResponse(response: Response): Promise<never> {
    const errorData = await response.json().catch(() => ({}));

    throw new ApiError(
      errorData.message || errorData.error || 'Unknown error',
      response.status,
      response.statusText,
      errorData
    );
  }

  // --- Debug Logging ---

  private logStart(method: string, url: string): void {
    if (isDebugEnabled()) {
      logger.log('[%s] %s %s', this.clientName, method, url);
    }
  }

  private logSuccess(method: string, url: string, status: number): void {
    if (isDebugEnabled()) {
      logger.log('[%s] %s %s -> %d', this.clientName, method, url, status);
    }
  }

  private logError(method: string, url: string, error: unknown): void {
    if (isDebugEnabled()) {
      logger.error('[%s] %s %s failed:', this.clientName, method, url, error);
    }
  }
}

/**
 * Normalize base URL by removing trailing slashes.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}
