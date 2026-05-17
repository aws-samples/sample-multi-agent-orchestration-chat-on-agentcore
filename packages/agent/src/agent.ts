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
import { config } from './config/index.js';
import { buildSystemPrompt } from './config/prompts/index.js';
import { createBedrockModel, getPromptCachingSupport } from './config/index.js';
import { CachePointAppender } from './services/session/cache-point-appender.js';
import { getCurrentContext } from './libs/context/request-context.js';

// Agent building blocks
import { buildUserMCPClients } from './runtime/agent/mcp-clients-builder.js';
import { buildToolSet } from './runtime/agent/tools-builder.js';
import { extractMemoryParams, fetchLongTermMemories } from './runtime/agent/memory-fetcher.js';
import { loadSessionHistory } from './runtime/agent/session-loader.js';

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

  // 3. Create Bedrock model and apply cache points to history
  const modelId = options?.modelId || config.BEDROCK_MODEL_ID;
  const model = createBedrockModel({ modelId: options?.modelId });
  const cachingSupport = getPromptCachingSupport(modelId);
  const messagesWithCache = new CachePointAppender(cachingSupport).apply(savedMessages);

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

  const agent = new Agent({
    model,
    systemPrompt,
    tools: [...toolSet.tools, ...toolSet.mcpClients],
    messages: messagesWithCache,
    hooks: options?.hooks,
    conversationManager,
  });

  // Set storagePath in agent state for sub-agent inheritance
  if (storagePath) {
    agent.state.set('storagePath', storagePath);
  }

  return {
    agent,
    metadata: {
      loadedMessagesCount: savedMessages.length,
      longTermMemoriesCount: memoryResult.memories.length,
      toolsCount: toolSet.counts.total,
      memoryConditions: memoryResult.conditions,
    },
  };
}
