/**
 * Tavily Crawl tool implementation
 *
 * Crawls a website via Tavily API (https://api.tavily.com/crawl) starting from
 * the configured base URL with depth/breadth limits.
 */

import {
  Tool,
  ToolInput,
  ToolResult,
  ToolValidationError,
  logger,
} from '@moca/lambda-tools-shared';
import { tavilyCrawlSchema } from './schemas/tavily-crawl-schema.js';
import { callTavilyApi, normalizeTavilyImage, truncateContent } from './tavily-common.js';
import type { TavilyImage } from './tavily-common.js';

interface TavilyCrawlResponse {
  base_url: string;
  results: Array<{
    url: string;
    raw_content: string;
    // See TavilyImage / normalizeTavilyImage in tavily-common.ts for why this
    // is a union of string | object.
    images?: TavilyImage[];
    favicon?: string;
  }>;
  response_time: number;
  usage?: { credits: number };
  request_id?: string;
}

function formatCrawlResults(response: TavilyCrawlResponse, maxContentLength: number): string {
  const { base_url, results, response_time, usage } = response;

  let output = `🕷️ Tavily Crawl Results\n`;
  output += `Base URL: ${base_url}\n`;
  output += `Processing Time: ${response_time}s\n`;
  output += `Pages Discovered: ${results.length} items\n`;

  if (usage?.credits) {
    output += `Credits Used: ${usage.credits}\n`;
  }

  output += `\n`;

  if (results.length > 0) {
    output += `📄 Crawled Pages:\n\n`;
    results.forEach((result, index) => {
      output += `${index + 1}. **${result.url}**\n`;
      output += `Content:\n${truncateContent(result.raw_content ?? '', maxContentLength)}\n`;
      if (result.images && result.images.length > 0) {
        const normalized = result.images
          .map((img) => normalizeTavilyImage(img))
          .filter((img): img is NonNullable<typeof img> => img !== null)
          .slice(0, 2);
        if (normalized.length > 0) {
          output += `🖼️ Images (${normalized.length} items):\n`;
          normalized.forEach((image, imgIndex) => {
            output += `  ${imgIndex + 1}. ${image.url}`;
            if (image.description) output += ` - ${image.description}`;
            output += `\n`;
          });
        }
      }
      output += `\n`;
    });
  }

  return output.trim();
}

async function handleTavilyCrawl(input: ToolInput): Promise<ToolResult> {
  const parsed = tavilyCrawlSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError(
      `Invalid input for tavily_crawl: ${parsed.error.message}`,
      'tavily_crawl'
    );
  }

  const params = parsed.data;

  const apiParams: Record<string, unknown> = {
    url: params.url,
    max_depth: params.maxDepth,
    max_breadth: params.maxBreadth,
    limit: params.limit,
    allow_external: params.allowExternal,
    extract_depth: params.extractDepth,
    format: params.format,
    include_images: params.includeImages,
    timeout: params.timeout,
  };
  if (params.instructions) {
    apiParams.instructions = params.instructions;
    apiParams.chunks_per_source = params.chunksPerSource;
  }
  if (params.selectPaths?.length) apiParams.select_paths = params.selectPaths;
  if (params.selectDomains?.length) apiParams.select_domains = params.selectDomains;
  if (params.excludePaths?.length) apiParams.exclude_paths = params.excludePaths;
  if (params.excludeDomains?.length) apiParams.exclude_domains = params.excludeDomains;

  const startTime = Date.now();
  const response = await callTavilyApi<TavilyCrawlResponse>('crawl', apiParams);
  const duration = Date.now() - startTime;

  logger.info('TAVILY_CRAWL_SUCCESS', {
    baseUrl: params.url,
    pagesDiscovered: response.results.length,
    durationMs: duration,
  });

  return {
    content: formatCrawlResults(response, params.maxContentLength),
    baseUrl: response.base_url,
    pagesDiscovered: response.results.length,
    executionTimeMs: duration,
  };
}

export const tavilyCrawlTool: Tool = {
  name: 'tavily_crawl',
  handler: handleTavilyCrawl,
  description: 'Crawl a website using Tavily API',
  version: '1.0.0',
  tags: ['web-crawl', 'tavily'],
};

export default tavilyCrawlTool;
