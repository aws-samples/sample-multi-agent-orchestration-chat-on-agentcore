/**
 * Runtime session self-termination
 *
 * Machine runtime sessions (triggers, workflow steps, workflow callbacks) are
 * fire-and-forget: nobody reads the stream to the end or sends a follow-up on
 * that runtime session, so the microVM would otherwise bill memory until the
 * idle timeout. Once the response has been fully written, the container stops
 * its own runtime session.
 *
 * Stopped over HTTPS with the caller's bearer token, not the SigV4 SDK call: a
 * JWT-authorized Runtime rejects SigV4 ("Authorization method mismatch"), and
 * on V2 the session is pinned to the JWT caller anyway (verified on dev).
 *
 * The endpoint comes from `AGENTCORE_RUNTIME_URL`, which the platform injects
 * (`.../runtimes/<url-encoded-arn>/invocations?qualifier=...`). It cannot come
 * from CDK: the Runtime ARN fed back into its own environment is a cycle.
 */

import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('SessionTerminator');

const STOP_TIMEOUT_MS = 10_000;

/** @returns undefined when the URL is absent (local dev) or not an invocations URL. */
export function resolveStopSessionUrl(
  runtimeUrl: string | undefined = config.AGENTCORE_RUNTIME_URL
): string | undefined {
  if (!runtimeUrl || !/\/runtimes\/[^/]+\/invocations/.test(runtimeUrl)) return undefined;
  return runtimeUrl.replace('/invocations', '/stopruntimesession');
}

/**
 * Stop a runtime session so its microVM is released now instead of at the
 * idle timeout. Best-effort: failures are logged, never thrown.
 *
 * MUST run only after `res.end()`: stopping also cuts any ongoing stream.
 *
 * @param runtimeSessionId the runtime session id (with its kind suffix), not the conversation id
 * @param authorizationHeader `Bearer <token>` of the identity the session is pinned to
 */
export async function stopOwnSession(
  runtimeSessionId: string,
  authorizationHeader: string | undefined
): Promise<void> {
  const url = resolveStopSessionUrl();
  if (!url || !authorizationHeader) {
    log.warn(
      { runtimeSessionId, hasUrl: !!url, hasAuth: !!authorizationHeader },
      'Skipping self-termination: no stop URL or caller token'
    );
    return;
  }

  try {
    log.info({ runtimeSessionId }, 'Stopping own runtime session to release microVM');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorizationHeader,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': runtimeSessionId,
      },
      body: '{}',
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 300);
      log.warn({ runtimeSessionId, status: response.status, body }, 'StopRuntimeSession failed');
      return;
    }
    log.info({ runtimeSessionId }, 'StopRuntimeSession accepted');
  } catch (error) {
    // Non-fatal: the idle timeout still reclaims the microVM.
    log.warn({ err: error, runtimeSessionId }, 'StopRuntimeSession failed (non-fatal)');
  }
}
