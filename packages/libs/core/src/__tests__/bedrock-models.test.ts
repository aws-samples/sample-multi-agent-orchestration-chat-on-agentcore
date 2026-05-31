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
});
