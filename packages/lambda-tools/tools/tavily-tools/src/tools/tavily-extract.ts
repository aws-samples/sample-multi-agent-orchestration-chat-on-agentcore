/**
 * Tavily Extract tool implementation
 *
 * Extracts content from one or more URLs via Tavily API
 * (https://api.tavily.com/extract).
 */

import {
  Tool,
  ToolInput,
  ToolResult,
  ToolValidationError,
  logger,
} from '@moca/lambda-tools-shared';
import { tavilyExtractSchema } from './schemas/tavily-extract-schema.js';
import { callTavilyApi, normalizeTavilyImage, truncateContent } from './tavily-common.js';
import type { TavilyImage } from './tavily-common.js';

interface TavilyExtractResponse {
  results: Array<{
    url: string;
    raw_content: string;
    // See TavilyImage / normalizeTavilyImage in tavily-common.ts for why this
    // is a union of string | object.
    images?: TavilyImage[];
    favicon?: string;
  }>;
  failed_results: Array<{ url: string; reason: string }>;
  response_time: number;
  usage?: { credits: number };
  request_id?: string;
}

function formatExtractResults(response: TavilyExtractResponse, maxContentLength: number): string {
  const { results, failed_results, response_time, usage } = response;

  let output = `🔍 Tavily Extract Results\n`;
  output += `Processing Time: ${response_time}s\n`;

  if (usage?.credits) {
    output += `Credits Used: ${usage.credits}\n`;
  }

  output += `Success: ${results.length} items, Failed: ${failed_results.length} items\n\n`;

  if (results.length > 0) {
    output += `📄 Extracted Content:\n\n`;
    results.forEach((result, index) => {
      output += `${index + 1}. **${result.url}**\n`;
      output += `Content:\n${truncateContent(result.raw_content ?? '', maxContentLength)}\n`;
      if (result.images && result.images.length > 0) {
        const normalized = result.images
          .map((img) => normalizeTavilyImage(img))
          .filter((img): img is NonNullable<typeof img> => img !== null)
          .slice(0, 3);
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

  if (failed_results.length > 0) {
    output += `❌ URLs that failed extraction:\n\n`;
    failed_results.forEach((failed, index) => {
      output += `${index + 1}. ${failed.url}\n`;
      // Tavily occasionally omits `reason` on 404/network-level failures; surface a
      // generic fallback so consumers always see a non-undefined reason string.
      output += `   Reason: ${failed.reason ?? 'HTTP failure or network error (no detail provided by Tavily)'}\n\n`;
    });
  }

  return output.trim();
}

async function handleTavilyExtract(input: ToolInput): Promise<ToolResult> {
  const parsed = tavilyExtractSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError(
      `Invalid input for tavily_extract: ${parsed.error.message}`,
      'tavily_extract'
    );
  }

  const params = parsed.data;
  const urlArray = params.urls;

  const apiParams: Record<string, unknown> = {
    urls: urlArray,
    extract_depth: params.extractDepth,
    format: params.format,
    include_images: params.includeImages,
    timeout: params.timeout,
  };
  if (params.query) {
    apiParams.query = params.query;
    apiParams.chunks_per_source = params.chunksPerSource;
  }

  const startTime = Date.now();
  const response = await callTavilyApi<TavilyExtractResponse>('extract', apiParams);
  const duration = Date.now() - startTime;

  logger.info('TAVILY_EXTRACT_SUCCESS', {
    urlCount: urlArray.length,
    succeeded: response.results.length,
    failed: response.failed_results.length,
    durationMs: duration,
  });

  return {
    content: formatExtractResults(response, params.maxContentLength),
    urlCount: urlArray.length,
    succeededCount: response.results.length,
    failedCount: response.failed_results.length,
    executionTimeMs: duration,
  };
}

export const tavilyExtractTool: Tool = {
  name: 'tavily_extract',
  handler: handleTavilyExtract,
  description: 'Extract content from specified URLs using Tavily API',
  version: '1.0.0',
  tags: ['web-extract', 'tavily'],
};

export default tavilyExtractTool;
