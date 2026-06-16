/**
 * Event-driven session self-termination
 *
 * Event-driven (trigger) invocations are fire-and-forget: the Trigger Lambda
 * sends the request and returns immediately without consuming the NDJSON
 * stream. Once the agent finishes processing, nothing on the client side
 * tells AgentCore Runtime that the session is done, so the microVM is only
 * reclaimed after the idle timeout (default 900s) elapses — billing memory
 * the whole time.
 *
 * Interactive (chat) invocations don't have this problem: the frontend reads
 * the stream to completion and the session naturally goes Idle, and we WANT
 * the microVM to stay warm so follow-up turns reuse the same context.
 *
 * For the event path there is no follow-up turn, so as soon as the response
 * has been fully written we proactively call `StopRuntimeSession` on our own
 * session. AgentCore's docs state this "instantly terminates the specified
 * session and stops any ongoing streaming responses" — so it MUST run only
 * after `res.end()`, otherwise it would cut off the response we just sent.
 *
 * ## Obtaining our own Runtime ARN
 *
 * `StopRuntimeSession` requires the runtime ARN. We cannot inject it via a
 * CDK environment variable because `runtime.agentRuntimeArn` is a CloudFormation
 * `GetAtt` on the same resource — feeding it back into that resource's own
 * `environmentVariables` creates a circular dependency. Instead we recover it
 * from `AGENTCORE_RUNTIME_URL`, which the AgentCore platform injects at runtime
 * (not via the CDK resource definition, so no cycle). Its path segment carries
 * the URL-encoded ARN:
 *
 *   https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<url-encoded-arn>/invocations
 */

import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config/index.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('SessionTerminator');

/**
 * Extract this container's own Runtime ARN from `AGENTCORE_RUNTIME_URL`.
 *
 * @returns the decoded ARN, or `undefined` if the env var is absent or
 *          does not contain a `/runtimes/<arn>/invocations` segment (e.g.
 *          in local development where the platform var is not injected).
 */
export function resolveOwnRuntimeArn(
  runtimeUrl: string | undefined = config.AGENTCORE_RUNTIME_URL
): string | undefined {
  if (!runtimeUrl) {
    return undefined;
  }

  // The ARN sits between `/runtimes/` and the trailing `/invocations`. It is
  // percent-encoded (colons and slashes → %3A / %2F), so decode after capture.
  const match = runtimeUrl.match(/\/runtimes\/([^/]+)\/invocations/);
  if (!match) {
    return undefined;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding — treat as unresolvable rather than throw.
    return undefined;
  }
}

let cachedClient: BedrockAgentCoreClient | undefined;

function getClient(): BedrockAgentCoreClient {
  if (!cachedClient) {
    cachedClient = new BedrockAgentCoreClient({ region: config.AWS_REGION });
  }
  return cachedClient;
}

/**
 * Stop the current event-driven session so its microVM is released promptly
 * instead of lingering until the idle timeout.
 *
 * Best-effort: any failure (missing ARN, missing IAM permission, throttling)
 * is logged and swallowed. The `idleRuntimeSessionTimeout` configured on the
 * Runtime is the defense-in-depth backstop that reclaims the container if this
 * call doesn't land.
 *
 * MUST be called only after the response has been fully written (`res.end()`),
 * because stopping the session also stops any ongoing streaming response.
 *
 * @param sessionId the runtime session id to stop (from the request context)
 */
export async function stopOwnSession(sessionId: string): Promise<void> {
  const runtimeArn = resolveOwnRuntimeArn();
  if (!runtimeArn) {
    log.warn(
      'Skipping self-termination: could not resolve own Runtime ARN from AGENTCORE_RUNTIME_URL'
    );
    return;
  }

  try {
    log.info({ sessionId }, 'Stopping event-driven session to release microVM');
    await getClient().send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: runtimeArn,
        runtimeSessionId: sessionId,
      })
    );
    log.info({ sessionId }, 'StopRuntimeSession accepted');
  } catch (error) {
    // Non-fatal: the idle timeout will still reclaim the container.
    log.warn({ err: error, sessionId }, 'StopRuntimeSession failed (non-fatal)');
  }
}
