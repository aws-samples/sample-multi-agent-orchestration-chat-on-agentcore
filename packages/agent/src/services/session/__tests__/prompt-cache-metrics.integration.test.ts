/**
 * Prompt Cache Metrics Integration Tests
 *
 * Verifies that Bedrock ConverseStream API returns cache token metrics
 * (cacheWriteInputTokens / cacheReadInputTokens) when prompt caching is enabled.
 *
 * Uses @aws-sdk/client-bedrock-runtime directly because the Strands SDK
 * does not expose cache metrics in its stream events.
 *
 * Run: cd packages/agent && npm run test:integration -- prompt-cache-metrics
 */

import { describe, it, expect } from '@jest/globals';
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message as BedrockMessage,
  type SystemContentBlock,
  type ContentBlock,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

/** Collect all stream events from a ConverseStream response. */
async function collectStreamEvents(
  stream: AsyncIterable<ConverseStreamOutput>
): Promise<ConverseStreamOutput[]> {
  const events: ConverseStreamOutput[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Build a long system prompt that exceeds Bedrock's minimum cache threshold (~1024 tokens). */
function buildLongSystemPrompt(): string {
  const paragraph =
    'You are an expert financial analyst assistant specializing in global markets. ' +
    'You analyze stock markets, bonds, derivatives, commodities, and complex financial instruments. ' +
    'You provide detailed analysis with precise numbers, percentages, and statistical measures. ' +
    'Always respond in a structured format. Use professional financial terminology throughout. ' +
    'When discussing risk, categorize it as Very Low, Low, Medium, High, or Critical. ' +
    'Always include relevant market data points and historical context for comparison. ' +
    'Format all currency values with appropriate symbols and two decimal places. ' +
    'Include year-over-year and quarter-over-quarter comparisons when available. ' +
    'Provide both bull case and bear case scenarios for any investment thesis discussed. ';
  // Repeat 10 times to ensure >2048 tokens (well above cache threshold)
  return (
    paragraph.repeat(10) +
    'However, when asked a simple arithmetic question, respond with only the number.'
  );
}

describe('Prompt Cache Metrics (raw Bedrock API)', () => {
  // Use US cross-region inference profile for on-demand access.
  const modelId = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
  const region = 'us-east-1';

  const client = new BedrockRuntimeClient({ region });

  const systemPrompt = buildLongSystemPrompt();
  const system: SystemContentBlock[] = [
    { text: systemPrompt },
    { cachePoint: { type: 'default' } },
  ];

  it('returns cache token metrics (write or read) when cachePoint is set', async () => {
    // Arrange — two sequential requests with the same system prompt + cache point.
    // Turn 1 may produce either cacheWrite (fresh) or cacheRead (if cache exists from prior run).
    // Turn 2 should always produce cacheRead since Turn 1 ensures the cache is populated.

    // Act — Turn 1: populate or reuse cache
    const turn1Messages: BedrockMessage[] = [
      { role: 'user', content: [{ text: 'What is 1+1? Just the number.' }] as ContentBlock[] },
    ];
    const turn1Command = new ConverseStreamCommand({
      modelId,
      system,
      messages: turn1Messages,
      inferenceConfig: { maxTokens: 32 },
    });
    const turn1Response = await client.send(turn1Command);
    const turn1Events = await collectStreamEvents(turn1Response.stream!);

    // Act — Turn 2: should always read from cache
    const turn2Messages: BedrockMessage[] = [
      { role: 'user', content: [{ text: 'What is 4+5? Just the number.' }] as ContentBlock[] },
    ];
    const turn2Command = new ConverseStreamCommand({
      modelId,
      system,
      messages: turn2Messages,
      inferenceConfig: { maxTokens: 32 },
    });
    const turn2Response = await client.send(turn2Command);
    const turn2Events = await collectStreamEvents(turn2Response.stream!);

    // Assert — Turn 1: should have either cacheWrite or cacheRead > 0
    const turn1Metadata = turn1Events.find((e) => e.metadata?.usage);
    expect(turn1Metadata).toBeDefined();
    const turn1Usage = turn1Metadata!.metadata!.usage!;
    const turn1CacheWrite = turn1Usage.cacheWriteInputTokens ?? 0;
    const turn1CacheRead = turn1Usage.cacheReadInputTokens ?? 0;
    expect(turn1CacheWrite + turn1CacheRead).toBeGreaterThan(0);

    // Assert — Turn 2: cacheReadInputTokens > 0 (cache is guaranteed to exist)
    const turn2Metadata = turn2Events.find((e) => e.metadata?.usage);
    expect(turn2Metadata).toBeDefined();
    const turn2Usage = turn2Metadata!.metadata!.usage!;
    expect(turn2Usage.cacheReadInputTokens).toBeDefined();
    expect(turn2Usage.cacheReadInputTokens).toBeGreaterThan(0);
  });

  it('does not return cache tokens when cachePoint is omitted', async () => {
    // Arrange — same system prompt but WITHOUT cachePoint
    const systemWithoutCache: SystemContentBlock[] = [{ text: systemPrompt }];
    const messages: BedrockMessage[] = [
      { role: 'user', content: [{ text: 'What is 7+8? Just the number.' }] as ContentBlock[] },
    ];

    // Act
    const command = new ConverseStreamCommand({
      modelId,
      system: systemWithoutCache,
      messages,
      inferenceConfig: { maxTokens: 32 },
    });
    const response = await client.send(command);
    const events = await collectStreamEvents(response.stream!);

    // Assert — no cache tokens in usage
    const metadataEvent = events.find((e) => e.metadata?.usage);
    expect(metadataEvent).toBeDefined();

    const usage = metadataEvent!.metadata!.usage!;
    // Without cache point, these fields should be 0 or undefined
    const cacheWrite = usage.cacheWriteInputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    expect(cacheWrite).toBe(0);
    expect(cacheRead).toBe(0);
  });
});
