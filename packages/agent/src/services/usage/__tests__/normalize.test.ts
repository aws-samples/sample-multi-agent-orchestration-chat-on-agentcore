import { describe, expect, it } from '@jest/globals';
import { normalizeUsage, totalInput } from '../normalize.js';

describe('normalizeUsage', () => {
  it('keeps Bedrock Converse input as the uncached part (cache reported separately)', () => {
    const n = normalizeUsage('global.anthropic.claude-sonnet-4-6', {
      inputTokens: 100,
      outputTokens: 7,
      cacheReadInputTokens: 1000,
      cacheWriteInputTokens: 50,
    });
    expect(n).toEqual({
      uncachedInputTokens: 100,
      cacheReadInputTokens: 1000,
      cacheWriteInputTokens: 50,
      outputTokens: 7,
    });
    expect(totalInput(n)).toBe(1150);
  });

  it('subtracts cached tokens for OpenAI-compatible endpoints, which include them in input', () => {
    const n = normalizeUsage('openai.gpt-oss-120b-1:0', {
      inputTokens: 1100,
      outputTokens: 3,
      cacheReadInputTokens: 1000,
    });
    expect(n.uncachedInputTokens).toBe(100);
    expect(totalInput(n)).toBe(1100);
  });

  it('treats missing, negative and fractional values safely', () => {
    expect(normalizeUsage('x.y', { inputTokens: -5, outputTokens: 2.7 })).toEqual({
      uncachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
    });
  });
});
