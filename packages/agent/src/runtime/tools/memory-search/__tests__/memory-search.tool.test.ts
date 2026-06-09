import { describe, it, expect } from '@jest/globals';
import { config } from '../../../../config/index.js';
import { createRequestContext, runWithContext } from '../../../../libs/context/request-context.js';
import { memorySearchTool } from '../index.js';

/**
 * Behavior tests for the memory_search handler.
 *
 * memory_search carries heavy AWS dependencies (user-scoped credential exchange
 * + AgentCore Memory retrieval), so these tests exercise the *pre-AWS* guidance
 * branches only — they never reach `createUserScopedBedrockAgentCoreClient`.
 *
 * Which branch is reached depends on environment configuration parsed once at
 * import time:
 *   - If AGENTCORE_MEMORY_ID is unset, the handler short-circuits with the
 *     "memory not configured" guidance before resolving identity.
 *   - If AGENTCORE_SEMANTIC_STRATEGY_ID is unset, the strategy guidance is
 *     returned next.
 *   - Otherwise the handler resolves identity via `requireIdentityId()`; absent
 *     identityId, its `ToolContextError` is surfaced verbatim by `defineTool`.
 *
 * Each assertion is keyed off `config` so it stays deterministic whether or not
 * a developer `.env` populates the memory variables.
 */

const MEMORY_NOT_CONFIGURED =
  'Long-term memory is not configured for this environment. ' +
  'AGENTCORE_MEMORY_ID is not set. Memory search is unavailable.';

const STRATEGY_NOT_CONFIGURED =
  'Long-term memory strategy is not configured for this environment. ' +
  'AGENTCORE_SEMANTIC_STRATEGY_ID is not set. Memory search is unavailable.';

const IDENTITY_GUIDANCE =
  'Could not determine the current user identity. ' +
  'Identity Pool identityId has not been resolved for this request.';

/**
 * Resolve the guidance string the handler is expected to return when no
 * identityId is present, given the import-time `config`.
 */
function expectedGuidance(): string {
  if (!config.AGENTCORE_MEMORY_ID) return MEMORY_NOT_CONFIGURED;
  if (!config.AGENTCORE_SEMANTIC_STRATEGY_ID) return STRATEGY_NOT_CONFIGURED;
  return IDENTITY_GUIDANCE;
}

describe('memorySearchTool', () => {
  it('returns a deterministic guidance string (never throws) with no request context', async () => {
    // No AsyncLocalStorage scope at all → getCurrentContext() is undefined.
    const result = await memorySearchTool.invoke({ query: 'preferred language', topK: 10 });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(expectedGuidance());
  });

  it('returns the identity guidance via requireIdentityId when context lacks identityId', async () => {
    // A request context exists but identityId was never resolved. When memory
    // config is present this exercises requireIdentityId() -> ToolContextError
    // -> defineTool surfacing the message verbatim; when memory config is
    // absent it short-circuits earlier. Either way the result is a non-empty
    // guidance string and the call does not throw.
    const result = await runWithContext(
      { ...createRequestContext(), userId: 'u' as never },
      () => memorySearchTool.invoke({ query: 'past projects', topK: 5 })
    );

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe(expectedGuidance());
  });

  it('does not leak the generic defineTool error prefix on the guidance paths', async () => {
    const result = await memorySearchTool.invoke({ query: 'communication style', topK: 1 });

    // None of the pre-AWS guidance branches should be reported as an unexpected
    // throw routed through `An error occurred while running memory_search:`.
    expect(result).not.toContain('An error occurred while running memory_search:');
  });
});
