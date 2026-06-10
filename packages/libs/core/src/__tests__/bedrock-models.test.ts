import { describe, it, expect } from 'vitest';
import {
  BEDROCK_MODEL_DEFINITIONS,
  getMaxOutputTokens,
  getModelRegion,
} from '../bedrock-models.js';

describe('getMaxOutputTokens', () => {
  it('returns the limit for a bare In-Region Qwen id', () => {
    expect(getMaxOutputTokens('qwen.qwen3-coder-next')).toBe(16384);
  });

  it('matches across cross-region inference profile prefixes', () => {
    // Registry stores `global.anthropic.claude-sonnet-4-6`; a `us.`-prefixed
    // id for the same model must resolve to the same limit.
    const expected = getMaxOutputTokens('global.anthropic.claude-sonnet-4-6');
    expect(expected).toBeGreaterThan(0);
    expect(getMaxOutputTokens('us.anthropic.claude-sonnet-4-6')).toBe(expected);
  });

  it('returns undefined for an unknown model id', () => {
    expect(getMaxOutputTokens('does.not.exist-v1:0')).toBeUndefined();
  });
});

describe('getModelRegion', () => {
  it('returns the pinned region for a model with a region override', () => {
    // qwen.qwen3-coder-next is not yet rolled out to every region, so it is
    // pinned to us-east-1 in the registry.
    expect(getModelRegion('qwen.qwen3-coder-next')).toBe('us-east-1');
  });

  it('returns undefined for a model without a region override', () => {
    // Most models are invoked in the deployment region (no pin).
    expect(getModelRegion('global.anthropic.claude-sonnet-4-6')).toBeUndefined();
    expect(getModelRegion('qwen.qwen3-235b-a22b-2507-v1:0')).toBeUndefined();
  });

  it('returns undefined for an unknown model id', () => {
    expect(getModelRegion('does.not.exist-v1:0')).toBeUndefined();
  });
});

describe('BEDROCK_MODEL_DEFINITIONS invariants', () => {
  it('every entry has a positive maxOutputTokens', () => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      expect(m.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('every region override is a non-empty string when present', () => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if ('region' in m && m.region !== undefined) {
        expect(typeof m.region).toBe('string');
        expect(m.region.length).toBeGreaterThan(0);
      }
    }
  });

  it('no Anthropic model advertises more than the Bedrock 128k output ceiling', () => {
    // Bedrock rejects maxTokens > 128000 for current Anthropic models with
    // ValidationException "exceeds the model limit of 128000" (verified live
    // against Fable 5). maxOutputTokens feeds the agent's maxTokens, so an
    // over-advertised limit makes every request fail. This guard would have
    // caught the issue's suggested 131072 for Fable 5 without hitting AWS.
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if (m.provider === 'Anthropic') {
        expect(m.maxOutputTokens).toBeLessThanOrEqual(128000);
      }
    }
  });

  it('registers Claude Opus 4.8 as the default (first) model with the correct limit', () => {
    const first = BEDROCK_MODEL_DEFINITIONS[0];
    expect(first.id).toBe('global.anthropic.claude-opus-4-8');
    expect(first.name).toBe('Claude Opus 4.8');
    expect(first.provider).toBe('Anthropic');
    expect(getMaxOutputTokens('global.anthropic.claude-opus-4-8')).toBe(128000);
  });

  it('does not region-pin the default model (Opus 4.8 must use the deploy region)', () => {
    // The default model must work in any deployment region with no special
    // account setup, so it must not be pinned to a specific region.
    expect(getModelRegion('global.anthropic.claude-opus-4-8')).toBeUndefined();
  });
});
