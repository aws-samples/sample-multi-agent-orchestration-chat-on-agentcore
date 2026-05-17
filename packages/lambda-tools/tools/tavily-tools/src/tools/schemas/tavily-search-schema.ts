import { z } from 'zod';

/**
 * Zod schema for the Tavily Search tool input.
 *
 * The JSON Schema counterpart consumed by AgentCore Gateway is maintained
 * separately in `packages/lambda-tools/tools/tavily-tools/tool-schema.json`.
 */
export const tavilySearchSchema = z.object({
  // min(2): Tavily rejects empty / 1-char queries with an opaque "undefined - undefined"
  // error. Catch that at the edge with a clear Zod message so LLMs can self-correct.
  query: z
    .string()
    .min(2, 'Query must be at least 2 characters')
    .describe('Search query (required, minimum 2 characters)'),
  searchDepth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Search depth. basic uses 1 credit, advanced uses 2 credits'),
  topic: z
    .enum(['general', 'news'])
    .default('general')
    .describe('Search category. news for latest information, general for general search'),
  // max(15): Tavily API caps search results at ~16 regardless of the requested value.
  // Advertising max=20 encourages over-fetching and disappoints LLMs; 15 is an honest
  // upper bound that still covers the typical "broad search" use case.
  maxResults: z
    .number()
    .min(1)
    .max(15)
    .default(5)
    .describe('Maximum number of search results to retrieve (1-15)'),
  includeAnswer: z.boolean().default(true).describe('Include LLM-generated summary answer'),
  timeRange: z
    .enum(['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'])
    .optional()
    .describe('Time range filter (filter by past period)'),
  includeDomains: z.array(z.string()).optional().describe('List of domains to include in search'),
  excludeDomains: z.array(z.string()).optional().describe('List of domains to exclude from search'),
  includeImages: z.boolean().default(false).describe('Retrieve related images'),
  country: z
    .string()
    .optional()
    .describe('Prioritize results from specific country (e.g., japan, united states)'),
  maxContentLength: z
    .number()
    .int()
    .min(500)
    .max(50000)
    .default(5000)
    .describe(
      'Maximum character length per search result content (default: 5000, min: 500, max: 50000). Increase to retrieve more detailed content from each result.'
    ),
});
