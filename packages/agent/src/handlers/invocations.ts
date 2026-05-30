/**
 * Agent invocation endpoint handler
 *
 * Thin orchestrator that assumes request-scoped state has already been
 * validated and enriched by the middleware chain (see `app.ts`):
 *
 *   requestContextMiddleware
 *     → validateInvocationMiddleware (prompt / images → 400 on failure)
 *     → authResolverMiddleware       (ctx.userId as UserId)
 *     → identityResolverMiddleware   (ctx.identityId as IdentityId)
 *     → handleInvocation             (this module)
 *
 * The `requireUserId()` / `requireIdentityId()` helpers surface the
 * branded types populated by the middleware chain, so downstream calls
 * to data-access sites (DynamoDB, S3, AgentCore Memory) are type-checked
 * to receive `IdentityId` rather than raw strings.
 *
 * Tracing happens inside the Strands SDK's own `invoke_agent` span,
 * which `agent.ts` decorates with custom `traceAttributes`
 * (`enduser.id`, `session.id`, …). No wrapper span is created here —
 * AgentCore Observability's trace-level aggregator only attributes
 * tokens correctly when the canonical
 * `POST → invoke_agent → execute_event_loop_cycle → chat` hierarchy
 * is preserved.
 *
 * Unhandled errors are caught by `errorHandlerMiddleware` via the
 * `asyncHandler` wrapper.
 */

import type { Request, Response } from 'express';
import type { InvocationRequest } from '../types/index.js';
import { createAgent } from '../agent.js';
import {
  getCurrentContext,
  requireIdentityId,
  requireUserId,
} from '../libs/context/request-context.js';
import { setupSession } from '../services/session/session-helper.js';

import { initializeWorkspaceSync } from '../services/workspace-sync-helper.js';
import { createSessionPersistenceDeps } from '../services/session-persistence-deps-factory.js';
import { logger } from '../libs/logger/index.js';
import { streamAgentResponse } from './stream-handler.js';

/**
 * Agent invocation endpoint (with streaming support).
 * Creates an Agent per session and persists history.
 */
export async function handleInvocation(req: Request, res: Response): Promise<void> {
  const body = req.body as InvocationRequest;
  const context = getCurrentContext()!;
  const userId = requireUserId(); // UserId — populated by authResolverMiddleware
  const identityId = requireIdentityId(); // IdentityId — populated by identityResolverMiddleware
  const { sessionId, sessionType, requestId } = context;

  logger.info(
    {
      requestId,
      prompt: body.prompt,
      userId,
      identityId,
      sessionId: sessionId || 'none (sessionless mode)',
    },
    'Request received:'
  );

  // 1. Initialize workspace sync only when a storagePath is provided.
  //    Keeping the storagePath branch at the call site (rather than inside
  //    the helper) makes the side-effect boundary explicit here and mirrors
  //    the pattern used for `setupSession` below.
  const workspaceSyncResult = body.storagePath
    ? initializeWorkspaceSync(userId, body.storagePath, context)
    : null;

  // 2. Setup session only when the request carries a sessionId.
  //    Sessionless invocations skip AgentCore Memory / DynamoDB entirely —
  //    the side-effect boundary is expressed at this call site.
  //    `identityId` is passed as the actorId because AgentCore Memory and
  //    DynamoDB are both keyed on the Identity Pool sub ("REGION:uuid"),
  //    which the branded type guarantees we have here.
  const sessionResult = sessionId
    ? await setupSession({
        actorId: identityId,
        sessionId,
        sessionType,
        agentId: body.agentId,
        storagePath: body.storagePath,
        deps: createSessionPersistenceDeps(),
      })
    : null;

  // 3. Create and stream agent response. The Strands SDK opens its own
  // `invoke_agent` span (with `traceAttributes` injected by `agent.ts`),
  // so we don't add a wrapper span here.
  const { agent, metadata, retryStrategy } = await createAgent({
    plugins: [
      ...(sessionResult ? [sessionResult.hook] : []),
      ...(workspaceSyncResult ? [workspaceSyncResult.hook] : []),
    ],
    modelId: body.modelId,
    enabledTools: body.enabledTools,
    systemPrompt: body.systemPrompt,
    memoryEnabled: body.memoryEnabled,
    memoryContext: body.memoryEnabled ? body.prompt : undefined,
    actorId: body.memoryEnabled ? identityId : undefined,
    memoryTopK: body.memoryTopK,
    mcpConfig: body.mcpConfig,
    sessionStorage: sessionResult?.storage,
    sessionConfig: sessionResult?.config,
    agentId: body.agentId,
  });

  logger.info(
    {
      requestId,
      loadedMessages: metadata.loadedMessagesCount,
      longTermMemories: metadata.longTermMemoriesCount,
      tools: metadata.toolsCount,
    },
    'Agent creation completed:'
  );

  await streamAgentResponse(agent, body.prompt, body.images, res, {
    metadata,
    retryStrategy,
    sessionStorage: sessionResult?.storage,
    sessionConfig: sessionResult?.config,
  });
}
