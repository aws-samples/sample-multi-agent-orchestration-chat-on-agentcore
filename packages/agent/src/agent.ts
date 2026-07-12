/**
 * Strands AI Agent Factory for AgentCore Runtime
 *
 * NOTE: This file intentionally lives at `src/agent.ts` as a **public facade**.
 * While it orchestrates Layer 3 (runtime) modules, keeping it at the root
 * provides a clean, discoverable entry point for agent creation:
 *
 *   import { createAgent } from './agent.js';
 *
 * Alternative considered: Moving to `runtime/agent/index.ts` would be
 * more architecturally pure but would require changing all consumers
 * and reduce discoverability. The facade pattern is preferred here.
 *
 * This thin orchestrator delegates each concern to dedicated builder modules
 * under `./runtime/agent/`. See each module for implementation details:
 *
 * - `runtime/agent/types.ts`            — Type definitions
 * - `runtime/agent/mcp-clients-builder.ts` — User-defined MCP client construction
 * - `runtime/agent/tools-builder.ts`       — Tool integration and filtering
 * - `runtime/agent/memory-fetcher.ts`      — Long-term memory retrieval
 * - `runtime/agent/session-loader.ts`      — Session history loading
 */

import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal';
import { isKnownModelId } from '@moca/core';
import {
  config,
  GOAL_LOOP_MAX_ATTEMPTS,
  GOAL_LOOP_TIMEOUT_MS,
  GOAL_LOOP_ATTEMPTS_MIN,
  GOAL_LOOP_ATTEMPTS_MAX,
} from './config/index.js';
import { buildSystemPrompt } from './config/prompts/index.js';
import { createBedrockModel } from './config/index.js';
import { getCurrentContext } from './libs/context/request-context.js';
import { logger } from './libs/logger/index.js';

// Agent building blocks
import { buildUserMCPClients } from './runtime/agent/mcp-clients-builder.js';
import { buildToolSet } from './runtime/agent/tools-builder.js';
import { extractMemoryParams, fetchLongTermMemories } from './runtime/agent/memory-fetcher.js';
import { loadSessionHistory } from './runtime/agent/session-loader.js';
import { buildSkillsPlugin } from './runtime/agent/skills-plugin-builder.js';
import { StreamTerminationRetryStrategy } from './runtime/agent/stream-termination-retry-strategy.js';
import { EmptyTextBlockHook } from './services/session/empty-text-block-hook.js';
import { EmptyReasoningBlockHook } from './services/session/empty-reasoning-block-hook.js';

import type { CreateAgentOptions, CreateAgentResult } from './runtime/agent/types.js';

/**
 * Create Strands Agent for AgentCore Runtime.
 *
 * Orchestrates the following steps:
 * 1. Build user-defined MCP clients
 * 2. Restore session history / fetch Gateway tools / retrieve long-term memories (parallel)
 * 3. Create Bedrock model with prompt caching
 * 4. Generate system prompt
 * 5. Assemble and return the Agent instance
 *
 * @param options - Agent creation options (includes hooks, model, tools, session, memory config)
 */
export async function createAgent(options?: CreateAgentOptions): Promise<CreateAgentResult> {
  // 1. Build user-defined MCP clients
  const userMCPClients = buildUserMCPClients(options?.mcpConfig);

  // 2. Execute in parallel: session history, Gateway tools, long-term memories
  const memoryParams = extractMemoryParams(options);
  const [savedMessages, toolSet, memoryResult] = await Promise.all([
    loadSessionHistory(
      options?.sessionStorage,
      options?.sessionConfig,
      config.CONVERSATION_WINDOW_SIZE
    ),
    buildToolSet(options?.enabledTools, userMCPClients),
    fetchLongTermMemories(memoryParams),
  ]);

  // Build the skills plugin from the pre-synced paths (the caller owns the
  // pull, so this is a synchronous, I/O-free assembly step).
  const skillsPlugin = buildSkillsPlugin(options?.skillsPaths);

  // 3. Create Bedrock model. Prompt cache points are managed by the SDK's
  // auto strategy (see createBedrockModel), so saved history is forwarded
  // to the Agent unmodified.
  const model = createBedrockModel({
    modelId: options?.modelId,
    reasoningEffort: options?.reasoningEffort,
  });

  // 4. Generate system prompt. RequestContext exists by this point (set
  // by requestContextMiddleware) and guarantees a populated storagePath.
  const storagePath = getCurrentContext()!.storagePath;
  const systemPrompt = buildSystemPrompt({
    customPrompt: options?.systemPrompt,
    tools: toolSet.tools,
    storagePath,
    longTermMemories: memoryResult.memories,
  });

  // 5. Assemble Agent
  const conversationManager = new SlidingWindowConversationManager({
    windowSize: config.CONVERSATION_WINDOW_SIZE,
    shouldTruncateResults: true,
  });

  // Forward request-scoped identifiers as `traceAttributes` so they land
  // directly on the Strands SDK's `invoke_agent` span. Setting them here
  // (rather than on a wrapper `agent.invocation` span) is what makes
  // CloudWatch GenAI Observability count tokens at the trace level — the
  // dashboard aggregates from the `invoke_agent` subtree, and any custom
  // span inserted between `POST /invocations` and `invoke_agent` breaks
  // that aggregation.
  const ctx = getCurrentContext();
  const traceAttributes: Record<string, string> = {};
  if (ctx?.userId) traceAttributes['enduser.id'] = ctx.userId;
  if (ctx?.sessionId) traceAttributes['session.id'] = ctx.sessionId;
  if (ctx?.sessionType) traceAttributes['session.type'] = ctx.sessionType;
  if (ctx?.isMachineUser) traceAttributes['enduser.type'] = 'machine';
  if (options?.memoryEnabled) traceAttributes['gen_ai.memory.enabled'] = 'true';

  // Recover from transient mid-stream truncation (Bedrock closing the event
  // stream before `messageStop`) instead of aborting the turn. A fresh
  // instance per agent is required — the strategy holds per-turn backoff state
  // and must not be shared across agents. Kept in a local so it can be returned
  // for post-turn observability (`retryStrategy.retryCount`).
  const retryStrategy = new StreamTerminationRetryStrategy();

  // Build the GoalLoop plugin when this turn carries a non-empty goal. The loop
  // validates each response against a natural-language goal via an internal
  // judge Agent and re-runs with feedback until the goal is met or the finite
  // bounds are hit. Per-message only — nothing is persisted across turns.
  const trimmedGoal = options?.goal?.trim();
  let goalLoop: GoalLoop | undefined;
  if (trimmedGoal) {
    // Fall back to the server default when the requested judge model is absent
    // or not in the registry (an unknown id would fail at invocation with
    // AccessDenied / ValidationException; validating here keeps the judge cheap
    // and predictable).
    const requestedJudge = options?.goalJudgeModelId?.trim();
    const judgeModelId =
      requestedJudge && isKnownModelId(requestedJudge)
        ? requestedJudge
        : config.GOAL_JUDGE_MODEL_ID;
    // Per-request attempt cap. validateInvocationMiddleware already clamps
    // HTTP-supplied values; re-clamp here so direct callers (tests, triggers)
    // get the same bounds.
    const requestedAttempts = options?.goalMaxAttempts;
    const maxAttempts =
      typeof requestedAttempts === 'number' && Number.isInteger(requestedAttempts)
        ? Math.min(Math.max(requestedAttempts, GOAL_LOOP_ATTEMPTS_MIN), GOAL_LOOP_ATTEMPTS_MAX)
        : GOAL_LOOP_MAX_ATTEMPTS;
    logger.info(
      { judgeModelId, maxAttempts, timeoutMs: GOAL_LOOP_TIMEOUT_MS },
      'GoalLoop enabled for this turn'
    );
    goalLoop = new GoalLoop({
      goal: trimmedGoal,
      // Finite bounds are mandatory: the SDK warns (and never terminates) when
      // both maxAttempts and timeout are Infinity.
      maxAttempts,
      timeout: GOAL_LOOP_TIMEOUT_MS,
      judge: { model: createBedrockModel({ modelId: judgeModelId }) },
    });
  }

  const agent = new Agent({
    model,
    systemPrompt,
    tools: [...toolSet.tools, ...toolSet.mcpClients],
    messages: savedMessages,
    // Sanitizer hooks run first so they clean assistant messages before any
    // caller-supplied plugin observes them. Both are harmless no-ops for models
    // that don't emit the offending blocks:
    //   - EmptyTextBlockHook strips the empty leading TextBlock Qwen3 emits
    //     before a toolUse (see empty-text-block-hook.ts).
    //   - EmptyReasoningBlockHook strips the empty-text reasoning block Fable 5
    //     (Mythos-class, adaptive thinking) emits, which the SDK formatter would
    //     otherwise reject on the next turn (see empty-reasoning-block-hook.ts).
    // The skills plugin (when present) injects `<available_skills>` into the
    // system prompt; it sits after the sanitizers and before caller plugins.
    //
    // GoalLoop MUST be last. After* hooks dispatch in reverse-registration
    // (LIFO) order, and when GoalLoop retries it sets `event.resume` on the
    // AfterInvocationEvent. Placing it last means its callback runs FIRST, so
    // SessionPersistenceHook.onAfterInvocation observes the resume flag and
    // skips its early finalize (AGENT_COMPLETE / saveMessages) on intermediate
    // attempts — see the resume guard in session-persistence-hook.ts. Only the
    // final attempt (resume === undefined) finalizes.
    plugins: [
      new EmptyTextBlockHook(),
      new EmptyReasoningBlockHook(),
      ...(skillsPlugin ? [skillsPlugin] : []),
      ...(options?.plugins ?? []),
      ...(goalLoop ? [goalLoop] : []),
    ],
    conversationManager,
    id: options?.agentId,
    traceAttributes,
    retryStrategy,
  });

  // Set storagePath in agent state for sub-agent inheritance.
  // Note: `agent.state` was renamed to `agent.appState` in
  // `@strands-agents/sdk@>=0.7.0` (PR #685).
  if (storagePath) {
    agent.appState.set('storagePath', storagePath);
  }

  return {
    agent,
    retryStrategy,
    goalLoop,
    metadata: {
      loadedMessagesCount: savedMessages.length,
      longTermMemoriesCount: memoryResult.memories.length,
      toolsCount: toolSet.counts.total,
      memoryConditions: memoryResult.conditions,
    },
  };
}
