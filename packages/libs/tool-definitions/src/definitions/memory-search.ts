import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

/**
 * Maximum number of messages returned by a single `read_session` call.
 * The model pages through longer transcripts using the `range` parameter.
 */
export const READ_SESSION_MAX_MESSAGES = 20;

export const memorySearchSchema = z.object({
  mode: z
    .enum(['search', 'list_sessions', 'read_session'])
    .default('search')
    .describe(
      "Operation mode. 'search' (default): semantic search over long-term memory. " +
        "'list_sessions': list the current user's past conversation sessions, newest first. " +
        "'read_session': read the raw message transcript of a specific past session."
    ),

  // ── mode: 'search' ──
  query: z
    .string()
    .optional()
    .describe(
      "Semantic search query (required when mode='search'). " +
        'Examples: "preferred programming language", "past projects", "communication style preferences"'
    ),
  topK: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe("(mode='search') Maximum number of memory records to retrieve (1-50, default: 10)"),

  // ── mode: 'list_sessions' ──
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "(mode='list_sessions') Maximum number of sessions to return per page (1-100, default: 20)"
    ),
  nextToken: z
    .string()
    .optional()
    .describe(
      "(mode='list_sessions') Opaque pagination token returned by a previous list_sessions call to fetch the next page"
    ),

  // ── mode: 'read_session' ──
  sessionId: z
    .string()
    .optional()
    .describe(
      "(mode='read_session', required) The id of the session to read. Obtain valid ids via mode='list_sessions'."
    ),
  range: z
    .array(z.number().int().min(0))
    .length(2)
    .optional()
    .describe(
      "(mode='read_session') Two-element [startIndex, endIndex] window into the chronological message list: " +
        '0-based, end-exclusive (e.g. [0, 20] returns the first 20 messages). ' +
        `At most ${READ_SESSION_MAX_MESSAGES} messages are returned per call. ` +
        `When omitted, the most recent ${READ_SESSION_MAX_MESSAGES} messages are returned along with the total message count.`
    ),
});

export const memorySearchDefinition: ToolDefinition<typeof memorySearchSchema> = {
  name: 'memory_search',
  description:
    'Search long-term memory and browse the current user\'s past conversations. ' +
    'Scoped to the current user only — you cannot access other users\' data.\n\n' +
    '**Modes:**\n' +
    "- `search` (default): Semantic search over long-term memory (preferences, habits, past context). " +
    'Provide `query`. Use mid-conversation to recall user-specific information not in the current context. ' +
    '(Note: some memories are already loaded at session start in the system prompt.)\n' +
    "- `list_sessions`: List the user's past conversation sessions, newest first. " +
    'Returns sessionId, title, timestamps. Supports `limit` and `nextToken` pagination.\n' +
    "- `read_session`: Read the raw message transcript of a past session. Provide `sessionId` " +
    `(from list_sessions). Returns at most ${READ_SESSION_MAX_MESSAGES} messages per call; page through ` +
    'longer transcripts with `range=[startIndex, endIndex]` (0-based, chronological, end-exclusive). ' +
    `When \`range\` is omitted, returns the most recent ${READ_SESSION_MAX_MESSAGES} messages plus the total count.`,
  zodSchema: memorySearchSchema,
  jsonSchema: zodToJsonSchema(memorySearchSchema),
};

