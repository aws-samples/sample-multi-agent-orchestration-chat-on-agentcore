/**
 * Session configuration helper
 *
 * Creates a per-request session storage instance scoped to the authenticated
 * user's Cognito Identity Pool credentials. This is required so that
 * CreateEvent / ListEvents / DeleteEvent on AgentCore Memory are evaluated
 * under the `bedrock-agentcore:actorId = identityId` condition on the
 * Authenticated Role — a shared execution-role client would bypass that check.
 */

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import type { IdentityId, SessionId } from '@moca/core';

import { SessionPersistenceHook } from './session-persistence-hook.js';
import { FileSessionStorage } from './file-session-storage.js';
import { AgentCoreMemoryStorage } from './agentcore-memory-storage.js';
import type { SessionConfig, SessionStorage, SessionType } from './types.js';
import type { SessionPersistenceDeps } from '../../types/session-persistence-deps.js';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';
import { createUserScopedBedrockAgentCoreClient } from '../../libs/utils/scoped-credentials.js';

/**
 * Result of session setup
 */
export interface SessionSetupResult {
  config: SessionConfig;
  hook: SessionPersistenceHook;
  storage: SessionStorage;
}

/**
 * Options for session setup
 */
export interface SessionSetupOptions {
  /**
   * identityId (Cognito Identity Pool sub, "REGION:UUID") — used as the
   * AgentCore Memory actorId, the DynamoDB partition key, AND the credential
   * cache key when building the user-scoped BedrockAgentCoreClient.
   *
   * Must already be resolved by the caller (e.g. via `getIdentityId` in
   * `handleInvocation`) before calling `setupSession`.
   */
  actorId: IdentityId;
  /**
   * Required. Callers must guard sessionless mode themselves — do not pass
   * `undefined` hoping the helper will short-circuit. This keeps the
   * function's name and behaviour aligned and makes "we hit AgentCore
   * Memory / DynamoDB only when there is a session" visible at the call
   * site.
   */
  sessionId: SessionId;
  sessionType?: SessionType;
  agentId?: string;
  storagePath?: string;
  deps: SessionPersistenceDeps;
  /**
   * Optional pre-built SessionStorage — bypasses user-scoped client creation.
   * Primarily used by sub-agent flows that construct the storage themselves.
   */
  storageOverride?: SessionStorage;
}

/**
 * Build a per-request SessionStorage.
 *
 * In production (AGENTCORE_MEMORY_ID set), this creates an AgentCoreMemoryStorage
 * backed by a user-scoped BedrockAgentCoreClient. Without a memory id, falls
 * back to FileSessionStorage (local dev only).
 */
async function buildSessionStorage(identityId: IdentityId): Promise<SessionStorage> {
  const memoryId = config.AGENTCORE_MEMORY_ID;

  if (!memoryId) {
    logger.warn(
      '[SessionStorage] AGENTCORE_MEMORY_ID is not set, falling back to FileSessionStorage'
    );
    return new FileSessionStorage();
  }

  const client: BedrockAgentCoreClient = await createUserScopedBedrockAgentCoreClient(identityId);
  return new AgentCoreMemoryStorage(memoryId, client);
}

/**
 * Setup session configuration and persistence hook.
 *
 * Assumes the caller has already decided a session is required — guard
 * sessionless mode at the call site so the "we hit AgentCore Memory /
 * DynamoDB" side effects are visible there.
 *
 * @param options Session setup options
 * @returns Session configuration, hook, and storage.
 */
export async function setupSession(options: SessionSetupOptions): Promise<SessionSetupResult> {
  const storage: SessionStorage =
    options.storageOverride ?? (await buildSessionStorage(options.actorId));

  const sessionConfig: SessionConfig = {
    actorId: options.actorId,
    sessionId: options.sessionId,
    sessionType: options.sessionType,
  };
  const hook = new SessionPersistenceHook(
    storage,
    sessionConfig,
    options.deps,
    options.agentId,
    options.storagePath
  );

  return { config: sessionConfig, hook, storage };
}
