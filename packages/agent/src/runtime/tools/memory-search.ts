/**
 * Memory Search Tool - Ad-hoc long-term memory retrieval + session browsing via ToolUse
 *
 * Three modes (all scoped to the current user only):
 *   - 'search' (default): semantic search against AgentCore Memory, complementing
 *     the session-startup memory retrieval embedded in the system prompt.
 *   - 'list_sessions': list the user's past conversation sessions (DynamoDB).
 *   - 'read_session': read the raw transcript of a past session (AgentCore Memory
 *     ListEvents), capped at READ_SESSION_MAX_MESSAGES messages per call.
 *
 * actorId / partition key are resolved from server-side request context (never
 * from tool input), so a user can only ever access their own data.
 */

import { tool } from '@strands-agents/sdk';
import type { Message } from '@strands-agents/sdk';
import type { IdentityId, SessionId } from '@moca/core';
import { memorySearchDefinition, READ_SESSION_MAX_MESSAGES } from '@moca/tool-definitions';
import { retrieveLongTermMemory } from '../../services/session/memory-retriever.js';
import { AgentCoreMemoryStorage } from '../../services/session/index.js';
import { getSessionsService } from '../../services/sessions-service.js';
import { getCurrentContext } from '../../libs/context/request-context.js';
import { createUserScopedBedrockAgentCoreClient } from '../../libs/utils/scoped-credentials.js';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';

/**
 * Render a single Strands message's content blocks into a compact, human/agent
 * readable string for a transcript. Text is shown verbatim; richer blocks
 * (tool use/result, media) are summarised rather than dumped so the transcript
 * stays readable and doesn't leak large binary payloads.
 */
function formatMessageContent(message: Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'textBlock':
        if ('text' in block && block.text.trim()) parts.push(block.text);
        break;
      case 'toolUseBlock':
        parts.push(`[tool_use: ${(block as { name?: string }).name ?? 'unknown'}]`);
        break;
      case 'toolResultBlock':
        parts.push(`[tool_result: ${(block as { status?: string }).status ?? 'unknown'}]`);
        break;
      case 'reasoningBlock':
        parts.push('[reasoning]');
        break;
      case 'imageBlock':
        parts.push('[image]');
        break;
      case 'videoBlock':
        parts.push('[video]');
        break;
      case 'documentBlock':
        parts.push('[document]');
        break;
      default:
        parts.push(`[${block.type}]`);
    }
  }
  return parts.join('\n').trim();
}

/**
 * mode='search': semantic long-term memory retrieval (original behaviour).
 */
async function handleSearch(
  actorId: string,
  query: string | undefined,
  topK: number
): Promise<string> {
  if (!query || !query.trim()) {
    return "mode='search' requires a non-empty 'query'.";
  }

  const memoryId = config.AGENTCORE_MEMORY_ID;
  if (!memoryId) {
    logger.warn('[memory_search] AGENTCORE_MEMORY_ID is not configured');
    return (
      'Long-term memory is not configured for this environment. ' +
      'AGENTCORE_MEMORY_ID is not set. Memory search is unavailable.'
    );
  }

  const strategyId = config.AGENTCORE_SEMANTIC_STRATEGY_ID;
  if (!strategyId) {
    logger.warn('[memory_search] AGENTCORE_SEMANTIC_STRATEGY_ID is not configured');
    return (
      'Long-term memory strategy is not configured for this environment. ' +
      'AGENTCORE_SEMANTIC_STRATEGY_ID is not set. Memory search is unavailable.'
    );
  }

  const client = await createUserScopedBedrockAgentCoreClient(actorId);
  const memories = await retrieveLongTermMemory(memoryId, actorId, strategyId, query, topK, client);

  if (memories.length === 0) {
    logger.info(`[memory_search] No memories found for query: "${query.substring(0, 100)}"`);
    return `No memories found for query: "${query}". The user may not have relevant past interactions on this topic.`;
  }

  const formattedMemories = memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n');
  logger.info(`[memory_search] Retrieved ${memories.length} memories`);

  return (
    `Found ${memories.length} relevant memory record(s) for query "${query}":\n\n` +
    formattedMemories
  );
}

/**
 * mode='list_sessions': list the user's past conversation sessions, newest first.
 */
async function handleListSessions(
  actorId: string,
  limit: number | undefined,
  nextToken: string | undefined
): Promise<string> {
  const service = getSessionsService();
  if (!service.isConfigured()) {
    logger.warn('[memory_search] SESSIONS_TABLE_NAME is not configured');
    return 'Session history is not configured for this environment (SESSIONS_TABLE_NAME is not set).';
  }

  const maxResults = limit ?? 20;
  let result;
  try {
    result = await service.listSessions(actorId, maxResults, nextToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message === 'Invalid pagination token') {
      return 'Invalid nextToken. Omit it to start from the most recent sessions.';
    }
    throw error;
  }

  if (result.sessions.length === 0) {
    return 'No past sessions found for the current user.';
  }

  const lines = result.sessions.map((s, i) => {
    const meta = [
      s.agentId ? `agent=${s.agentId}` : null,
      s.sessionType ? `type=${s.sessionType}` : null,
      `updated=${s.updatedAt}`,
    ]
      .filter(Boolean)
      .join(', ');
    return `${i + 1}. ${s.title || '(untitled)'}\n   sessionId: ${s.sessionId}\n   ${meta}`;
  });

  logger.info(`[memory_search] Listed ${result.sessions.length} sessions`);

  let output = `Found ${result.sessions.length} session(s) (newest first):\n\n${lines.join('\n')}`;
  if (result.nextToken) {
    output +=
      `\n\nMore sessions are available. To fetch the next page, call again with ` +
      `mode='list_sessions' and nextToken='${result.nextToken}'.`;
  }
  return output;
}

/**
 * mode='read_session': read a past session's raw message transcript, paged via range.
 */
async function handleReadSession(
  actorId: string,
  sessionId: string | undefined,
  range: number[] | undefined
): Promise<string> {
  if (!sessionId || !sessionId.trim()) {
    return "mode='read_session' requires a 'sessionId'. Use mode='list_sessions' to discover valid ids.";
  }

  const memoryId = config.AGENTCORE_MEMORY_ID;
  if (!memoryId) {
    logger.warn('[memory_search] AGENTCORE_MEMORY_ID is not configured');
    return (
      'Session transcripts are not configured for this environment. ' +
      'AGENTCORE_MEMORY_ID is not set.'
    );
  }

  const client = await createUserScopedBedrockAgentCoreClient(actorId);
  const storage = new AgentCoreMemoryStorage(memoryId, client);
  // sessionId is an external identifier passed straight through to the
  // AgentCore ListEvents API; cast to the branded type rather than running it
  // through parseSessionId, which would reject valid non-user session ids
  // (e.g. subagent/event sessions) that don't match the 33-char user format.
  const messages = await storage.loadMessages({
    sessionId: sessionId as SessionId,
    actorId: actorId as IdentityId,
  });
  const total = messages.length;

  if (total === 0) {
    return `Session '${sessionId}' has no messages (or does not exist / is not accessible to you).`;
  }

  // Resolve the [startIndex, endIndex) window.
  let start: number;
  let end: number;
  if (range && range.length === 2) {
    start = Math.max(0, Math.min(range[0], total));
    end = Math.max(start, Math.min(range[1], total));
    // Cap the window to at most READ_SESSION_MAX_MESSAGES messages.
    if (end - start > READ_SESSION_MAX_MESSAGES) {
      end = start + READ_SESSION_MAX_MESSAGES;
    }
  } else {
    // No range → most recent READ_SESSION_MAX_MESSAGES messages.
    start = Math.max(0, total - READ_SESSION_MAX_MESSAGES);
    end = total;
  }

  const windowMessages = messages.slice(start, end);
  const transcript = windowMessages
    .map((msg, i) => {
      const idx = start + i;
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
      const body = formatMessageContent(msg) || '(empty)';
      return `[${idx}] ${roleLabel}:\n${body}`;
    })
    .join('\n\n');

  logger.info(
    { sessionId, total, start, end },
    `[memory_search] Read session transcript (${end - start} of ${total} messages)`
  );

  const header =
    `Session '${sessionId}' — showing messages [${start}, ${end}) of ${total} total ` +
    `(0-based, end-exclusive). ` +
    (end < total || start > 0
      ? `Use range=[start, end] to page (max ${READ_SESSION_MAX_MESSAGES} per call).`
      : 'This is the full transcript.');

  return `${header}\n\n${transcript}`;
}

/**
 * Memory Search Tool
 *
 * Resolves actorId from server-side context (not from user input) to ensure
 * users can only access their own memories and sessions.
 */
export const memorySearchTool = tool({
  name: memorySearchDefinition.name,
  description: memorySearchDefinition.description,
  inputSchema: memorySearchDefinition.zodSchema,
  callback: async (input) => runMemorySearch(input),
});

/**
 * Tool body, extracted from the `tool()` wrapper so it can be unit-tested
 * directly. Dispatches on `mode` and never trusts caller-supplied identity:
 * the actorId / DynamoDB partition key are resolved from request context.
 */
export async function runMemorySearch(input: {
  mode?: 'search' | 'list_sessions' | 'read_session';
  query?: string;
  topK?: number;
  limit?: number;
  nextToken?: string;
  sessionId?: string;
  range?: number[];
}): Promise<string> {
  const { mode = 'search', query, topK = 10, limit, nextToken, sessionId, range } = input;

  logger.info({ mode, sessionId }, `memory_search tool invoked:`);

  // Resolve actorId from request context.
  //
  // Memory IAM conditions (`bedrock-agentcore:actorId` / `:namespace`) and the
  // DynamoDB `dynamodb:LeadingKeys` condition are both evaluated against
  // `${cognito-identity.amazonaws.com:sub}` (= identityId), so the actorId
  // MUST be the Identity Pool identityId, NOT the User Pool sub. The identityId
  // is populated on `context` by `assumeUserScopedRole` during handleInvocation,
  // well before any tool is dispatched.
  const context = getCurrentContext();
  const actorId = context?.identityId;
  if (!actorId) {
    logger.warn('[memory_search] Could not resolve identityId from request context');
    return (
      'Could not determine the current user identity. ' +
      'Identity Pool identityId has not been resolved for this request.'
    );
  }

  try {
    switch (mode) {
      case 'list_sessions':
        return await handleListSessions(actorId, limit, nextToken);
      case 'read_session':
        return await handleReadSession(actorId, sessionId, range);
      case 'search':
      default:
        return await handleSearch(actorId, query, topK);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, mode }, `[memory_search] Error (mode=${mode}):`);

    return (
      `An error occurred while accessing memory/session history: ${errorMessage}. ` +
      'You may continue the conversation without this context.'
    );
  }
}
