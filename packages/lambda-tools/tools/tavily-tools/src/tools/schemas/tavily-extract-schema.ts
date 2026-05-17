import { z } from 'zod';

/**
 * Zod schema for the Tavily Extract tool input.
 *
 * The JSON Schema counterpart consumed by AgentCore Gateway is maintained
 * separately in `packages/lambda-tools/tools/tavily-tools/tool-schema.json`.
 */
export const tavilyExtractSchema = z.object({
  // AgentCore Gateway's SchemaDefinitionProperty does not support JSON Schema `oneOf`/`union`,
  // so this must be a single-type field. Always pass a single URL as a 1-element array.
  urls: z
    .array(z.string())
    .min(1)
    .describe(
      'Array of URLs to extract content from (single URL should be passed as a 1-element array)'
    ),
  query: z
    .string()
    .optional()
    .describe('Query for reranking. When specified, prioritizes more relevant content'),
  extractDepth: z
    .enum(['basic', 'advanced'])
    .default('basic')
    .describe('Extraction depth. basic: 1 credit/5 URLs, advanced: 2 credits/5 URLs'),
  format: z
    .enum(['markdown', 'text'])
    .default('markdown')
    .describe('Output format. markdown or text'),
  chunksPerSource: z
    .number()
    .min(1)
    .max(5)
    .default(3)
    .describe('Number of chunks per source (1-5, only effective when query is specified)'),
  includeImages: z.boolean().default(false).describe('Whether to include image information'),
  timeout: z.number().min(1).max(60).default(30).describe('Timeout in seconds (1-60)'),
  maxContentLength: z
    .number()
    .int()
    .min(1000)
    .max(100000)
    .default(20000)
    .describe(
      'Maximum character length per extracted content (default: 20000, min: 1000, max: 100000). Increase to retrieve full page content.'
    ),
});
