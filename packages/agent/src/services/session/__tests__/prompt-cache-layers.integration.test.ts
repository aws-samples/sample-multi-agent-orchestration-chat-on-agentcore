/**
 * Prompt Cache Layers Integration Tests
 *
 * End-to-end verification that `createBedrockModel({ cacheConfig: { strategy: 'auto' } })`
 * actually causes Bedrock to read cached tokens for each of the three Anthropic
 * cache layers when used through the Strands SDK Agent:
 *
 *   1. system   — long system prompt is cached and re-read across turns
 *   2. tools    — large tool catalog is cached and re-read across turns
 *   3. messages — long user message from turn 1 is cached and re-read on turn 2
 *
 * Strategy: subscribe to `agent.stream()` events and pick up
 * `modelMetadataEvent`s, which carry the Bedrock `usage` block with
 * `cacheWriteInputTokens` / `cacheReadInputTokens`. Turn 2's read counter
 * should be > 0 for the layer under test.
 *
 * Run: cd packages/agent && npm run test:integration -- prompt-cache-layers
 */

import { describe, it, expect } from '@jest/globals';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { createBedrockModel } from '../../../config/bedrock.js';

interface UsageWithCache {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/**
 * Run a single agent turn and collect every `modelMetadataEvent.usage` payload.
 * Each agent turn produces exactly one such event from Bedrock per model call.
 */
async function chatAndCollectUsage(agent: Agent, prompt: string): Promise<UsageWithCache[]> {
  const usages: UsageWithCache[] = [];
  for await (const event of agent.stream(prompt)) {
    if ((event as { type?: string }).type !== 'modelStreamUpdateEvent') continue;
    const inner = (event as { event?: { type?: string; usage?: UsageWithCache } }).event;
    if (inner?.type === 'modelMetadataEvent' && inner.usage) {
      usages.push(inner.usage);
    }
  }
  return usages;
}

/** A long system prompt (~3000+ tokens) — well above Anthropic's 1024-token cache threshold. */
function longSystemPrompt(): string {
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
  return (
    paragraph.repeat(20) +
    'However, when asked a simple arithmetic question, respond with only the number.'
  );
}

/** A long passage to embed in a user message so the messages cache point has enough tokens to cache. */
function longUserPassage(): string {
  const passage =
    'Background context for our discussion: ' +
    'In the early 20th century, electrical engineers developed transmission line theory. ' +
    'Heaviside introduced the telegrapher equations describing voltage and current. ' +
    'Maxwell unified electricity, magnetism, and optics into a single framework. ' +
    'Ohm formalized the relationship between voltage, current, and resistance. ' +
    'Kirchhoff stated his node and loop laws, foundational to circuit analysis. ' +
    'Tesla and Edison championed competing AC and DC distribution systems. ' +
    'These foundations underlie every electronic device manufactured today. ';
  return passage.repeat(40);
}

/**
 * Generate a large tool catalog so the `tools` cache point has > 1024 tokens
 * worth of definitions to cache.
 */
function buildLargeToolCatalog() {
  const detailedDescription =
    'This tool performs a domain-specific calculation. It accepts a numeric value and ' +
    'returns the result of applying a fixed transformation. The transformation is well ' +
    'defined and deterministic. Use this tool when you need a precise numeric output ' +
    'derived from a single input. Inputs must be finite real numbers. Outputs are also ' +
    'finite real numbers. Edge cases include zero, negative numbers, and very large ' +
    'magnitudes. The tool will raise an error if the input is not a finite number. ' +
    'Latency is typically under one millisecond. The tool is safe to call repeatedly ' +
    'and produces no side effects. Recommended for arithmetic-heavy workflows. ';

  const tools = [];
  for (let i = 0; i < 30; i++) {
    tools.push(
      tool({
        name: `transform_v${i}`,
        description: `${detailedDescription} (variant ${i})`,
        inputSchema: z.object({ value: z.number().describe('Input numeric value') }),
        callback: async ({ value }: { value: number }) => String(value * (i + 1)),
      })
    );
  }
  return tools;
}

describe('Prompt cache layers (system / messages / tools) — Strands SDK end-to-end', () => {
  // ---------------------------------------------------------------------
  // system layer — long system prompt should be cached and read on turn 2
  // ---------------------------------------------------------------------
  describe('system layer', () => {
    it('reads cached system prompt tokens on the second turn', async () => {
      const agent = new Agent({
        model: createBedrockModel(),
        systemPrompt: longSystemPrompt(),
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      const turn1 = await chatAndCollectUsage(agent, 'What is 1+1? Just the number.');
      const turn2 = await chatAndCollectUsage(agent, 'What is 4+5? Just the number.');

      expect(turn1.length).toBeGreaterThan(0);
      expect(turn2.length).toBeGreaterThan(0);

      const turn1Total = sumCache(turn1);
      const turn2Total = sumCache(turn2);

      // Turn 1 must have either written or read the system cache.
      expect(turn1Total.write + turn1Total.read).toBeGreaterThan(0);
      // Turn 2 must read from the system cache (guaranteed populated by turn 1).
      expect(turn2Total.read).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------
  // tools layer — long tool catalog should be cached and read on turn 2
  // ---------------------------------------------------------------------
  describe('tools layer', () => {
    it('reads cached tool definition tokens on the second turn', async () => {
      const agent = new Agent({
        model: createBedrockModel(),
        // Keep system prompt short so cache hits we observe come from tools[].
        systemPrompt: 'Be brief. Answer arithmetic with just the number.',
        tools: buildLargeToolCatalog(),
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      const turn1 = await chatAndCollectUsage(agent, 'What is 2+2? Just the number.');
      const turn2 = await chatAndCollectUsage(agent, 'What is 3+3? Just the number.');

      expect(turn1.length).toBeGreaterThan(0);
      expect(turn2.length).toBeGreaterThan(0);

      const turn1Total = sumCache(turn1);
      const turn2Total = sumCache(turn2);

      // Turn 1 must have written or read the tools cache.
      expect(turn1Total.write + turn1Total.read).toBeGreaterThan(0);
      // Turn 2 must read from cache. The tool catalog dominates the cached
      // bytes here because the system prompt is short.
      expect(turn2Total.read).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------
  // messages layer — turn-1 user passage cached and read on turn 2
  // ---------------------------------------------------------------------
  describe('messages layer', () => {
    it('reads cached message tokens on the second turn after a long user message', async () => {
      const agent = new Agent({
        model: createBedrockModel(),
        // Short system prompt + no tools so observable cache reads on turn 2
        // come from the message history rather than the system or tools layers.
        systemPrompt: 'Be brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      // Turn 1: send a long user message. SDK auto strategy will inject a
      // cachePoint after the last user message, causing Bedrock to write the
      // message cache.
      const turn1 = await chatAndCollectUsage(
        agent,
        `${longUserPassage()}\n\nQuestion: What is 2+2? Just the number.`
      );
      // Turn 2: send a small follow-up. Bedrock should read the cached
      // turn-1 user message + assistant response prefix.
      const turn2 = await chatAndCollectUsage(agent, 'What is 5+5? Just the number.');

      expect(turn1.length).toBeGreaterThan(0);
      expect(turn2.length).toBeGreaterThan(0);

      const turn1Total = sumCache(turn1);
      const turn2Total = sumCache(turn2);

      // Turn 1 must have written or read the messages cache.
      expect(turn1Total.write + turn1Total.read).toBeGreaterThan(0);
      // Turn 2 must read prior messages from cache.
      expect(turn2Total.read).toBeGreaterThan(0);
    });
  });
});

/** Sum cache read/write tokens across all metadata events of a single turn. */
function sumCache(usages: UsageWithCache[]): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const u of usages) {
    read += u.cacheReadInputTokens ?? 0;
    write += u.cacheWriteInputTokens ?? 0;
  }
  return { read, write };
}
