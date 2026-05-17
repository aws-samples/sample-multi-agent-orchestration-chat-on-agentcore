/**
 * Tavily Search tool implementation
 *
 * Executes a web search via Tavily API (https://api.tavily.com/search) and returns
 * a formatted text result along with structured metadata.
 */

import {
  Tool,
  ToolInput,
  ToolResult,
  ToolValidationError,
  logger,
} from '@moca/lambda-tools-shared';
import { tavilySearchSchema } from './schemas/tavily-search-schema.js';
import { callTavilyApi, normalizeTavilyImage, truncateContent } from './tavily-common.js';
import type { TavilyImage } from './tavily-common.js';

interface TavilySearchResponse {
  query: string;
  answer?: string;
  // Tavily returns images either as plain URL strings (default) or as
  // `{url, description}` objects (when include_image_descriptions=true). See
  // TavilyImage / normalizeTavilyImage in tavily-common.ts.
  images?: TavilyImage[];
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    raw_content?: string;
    favicon?: string;
  }>;
  response_time: string;
  auto_parameters?: { topic: string; search_depth: string };
  usage?: { credits: number };
  request_id?: string;
}

function formatSearchResults(response: TavilySearchResponse, maxContentLength: number): string {
  const { query, answer, results, response_time, usage } = response;

  let output = `🔍 Tavily Search Results\n`;
  output += `Search Query: ${query}\n`;
  output += `Execution Time: ${response_time}s\n`;

  if (usage?.credits) {
    output += `Credits Used: ${usage.credits}\n`;
  }

  output += `\n`;

  if (answer) {
    const summaryLimit = Math.max(1500, Math.floor(maxContentLength * 0.5));
    output += `📝 AI Summary Answer:\n${truncateContent(answer, summaryLimit)}\n\n`;
  }

  output += `📋 Search Results (${results.length} items):\n\n`;
  results.forEach((result, index) => {
    output += `${index + 1}. **${result.title}**\n`;
    output += `   URL: ${result.url}\n`;
    output += `   Relevance: ${(result.score * 100).toFixed(1)}%\n`;
    output += `   Content: ${truncateContent(result.content, maxContentLength)}\n\n`;
  });

  if (response.images && response.images.length > 0) {
    const normalized = response.images
      .map((img) => normalizeTavilyImage(img))
      .filter((img): img is NonNullable<typeof img> => img !== null);
    if (normalized.length > 0) {
      output += `🖼️ Related Images (${normalized.length} items):\n`;
      normalized.forEach((image, index) => {
        output += `${index + 1}. ${image.url}\n`;
        if (image.description) {
          output += `   Description: ${image.description}\n`;
        }
      });
      output += `\n`;
    }
  }

  return output.trim();
}

async function handleTavilySearch(input: ToolInput): Promise<ToolResult> {
  const parsed = tavilySearchSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError(
      `Invalid input for tavily_search: ${parsed.error.message}`,
      'tavily_search'
    );
  }

  const params = parsed.data;
  const apiParams: Record<string, unknown> = {
    query: params.query,
    search_depth: params.searchDepth,
    topic: params.topic,
    max_results: params.maxResults,
    include_answer: params.includeAnswer,
    include_images: params.includeImages,
    include_favicon: true,
  };
  if (params.timeRange) apiParams.time_range = params.timeRange;
  if (params.includeDomains?.length) apiParams.include_domains = params.includeDomains;
  if (params.excludeDomains?.length) apiParams.exclude_domains = params.excludeDomains;
  if (params.country && params.topic === 'general') apiParams.country = params.country;

  const startTime = Date.now();
  const response = await callTavilyApi<TavilySearchResponse>('search', apiParams);
  const duration = Date.now() - startTime;

  logger.info('TAVILY_SEARCH_SUCCESS', {
    query: params.query.substring(0, 100),
    resultCount: response.results.length,
    durationMs: duration,
  });

  return {
    content: formatSearchResults(response, params.maxContentLength),
    query: params.query,
    resultCount: response.results.length,
    executionTimeMs: duration,
  };
}

export const tavilySearchTool: Tool = {
  name: 'tavily_search',
  handler: handleTavilySearch,
  description: 'Execute high-quality web search using Tavily API',
  version: '1.0.0',
  tags: ['web-search', 'tavily'],
};

export default tavilySearchTool;
