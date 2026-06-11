import { describe, it, expect } from 'vitest';
import {
  BEDROCK_MODEL_DEFINITIONS,
  REASONING_DEPTHS,
  getMaxOutputTokens,
  getModelRegion,
  getReasoningConfig,
  getMaxReasoningDepth,
  isReasoningCapable,
  isReasoningDepth,
  type ReasoningDepth,
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

  it('only reasoning-capable models declare a max-effort cap', () => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if (!m.reasoningCapable) {
        expect(m.reasoningMaxEffort).toBeUndefined();
      } else if (m.reasoningMaxEffort !== undefined) {
        // Only Opus-tier models may go to 'max'; a declared cap is for non-Opus.
        expect(['low', 'high', 'max']).toContain(m.reasoningMaxEffort);
      }
    }
  });

  it('caps Sonnet 4.6 reasoning at high (Bedrock rejects effort:max on non-Opus)', () => {
    expect(getMaxReasoningDepth('global.anthropic.claude-sonnet-4-6')).toBe('high');
  });

  it('allows max reasoning on Opus-tier models', () => {
    expect(getMaxReasoningDepth('global.anthropic.claude-opus-4-8')).toBe('max');
  });

  it('marks Anthropic claude models reasoning-capable and others not', () => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      const expected = m.provider === 'Anthropic' && m.id.includes('claude');
      expect(Boolean(m.reasoningCapable)).toBe(expected);
    }
  });

  it('does not region-pin Claude Fable 5 in the OSS default (invoked in the deploy region)', () => {
    // Fable 5 needs Bedrock Data Retention mode `provider_data_share` in its
    // invocation region, but WHICH region has it is account/deployment-specific.
    // The OSS default therefore ships no pin (Fable 5 runs in the deploy region);
    // operators whose deploy region lacks provider_data_share pin it to another
    // region via the bedrockModels override in environments.ts. Keeping a
    // concrete region out of the source avoids baking one account's setup into
    // the published default.
    expect(getModelRegion('global.anthropic.claude-fable-5')).toBeUndefined();
  });
});

describe('isReasoningCapable', () => {
  it('is true for Anthropic claude models', () => {
    expect(isReasoningCapable('global.anthropic.claude-opus-4-8')).toBe(true);
    expect(isReasoningCapable('global.anthropic.claude-sonnet-4-6')).toBe(true);
  });

  it('matches across cross-region inference profile prefixes', () => {
    expect(isReasoningCapable('us.anthropic.claude-opus-4-8')).toBe(true);
  });

  it('is false for non-capable models and unknown ids', () => {
    expect(isReasoningCapable('global.amazon.nova-2-lite-v1:0')).toBe(false);
    expect(isReasoningCapable('qwen.qwen3-coder-next')).toBe(false);
    expect(isReasoningCapable('does.not.exist-v1:0')).toBe(false);
  });
});

describe('getReasoningConfig', () => {
  it('returns adaptive thinking + effort for a non-off depth', () => {
    expect(getReasoningConfig('global.anthropic.claude-opus-4-8', 'high')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    expect(getReasoningConfig('global.anthropic.claude-opus-4-8', 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' },
    });
  });

  it('clamps effort to the model cap (Sonnet 4.6 max → high)', () => {
    expect(getReasoningConfig('global.anthropic.claude-sonnet-4-6', 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    // Below the cap is untouched.
    expect(getReasoningConfig('global.anthropic.claude-sonnet-4-6', 'low')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    });
  });

  it('matches across cross-region inference profile prefixes', () => {
    expect(getReasoningConfig('us.anthropic.claude-opus-4-8', 'low')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    });
  });

  it('returns undefined for depth off', () => {
    expect(getReasoningConfig('global.anthropic.claude-opus-4-8', 'off')).toBeUndefined();
  });

  it('returns undefined for non-capable and unknown models', () => {
    expect(getReasoningConfig('global.amazon.nova-2-lite-v1:0', 'high')).toBeUndefined();
    expect(getReasoningConfig('qwen.qwen3-coder-next', 'high')).toBeUndefined();
    expect(getReasoningConfig('does.not.exist-v1:0', 'high')).toBeUndefined();
  });

  it('returns undefined for an unknown depth that bypassed the type (no verbatim send)', () => {
    // A caller that defeats the type with `as` must not reach Bedrock with an
    // unrecognized effort — EFFORT_ORDER.indexOf would be -1 and skip the clamp.
    expect(
      getReasoningConfig('global.anthropic.claude-opus-4-8', 'medium' as ReasoningDepth)
    ).toBeUndefined();
    expect(getReasoningConfig('global.anthropic.claude-opus-4-8', '' as ReasoningDepth)).toBeUndefined();
  });
});

describe('getMaxReasoningDepth', () => {
  it('returns max for Opus-tier capable models', () => {
    expect(getMaxReasoningDepth('global.anthropic.claude-opus-4-8')).toBe('max');
    expect(getMaxReasoningDepth('global.anthropic.claude-fable-5')).toBe('max');
  });

  it('returns the declared cap for capped models', () => {
    expect(getMaxReasoningDepth('global.anthropic.claude-sonnet-4-6')).toBe('high');
  });

  it('returns undefined for non-capable and unknown models', () => {
    expect(getMaxReasoningDepth('global.amazon.nova-2-lite-v1:0')).toBeUndefined();
    expect(getMaxReasoningDepth('does.not.exist-v1:0')).toBeUndefined();
  });
});

describe('isReasoningDepth', () => {
  it('accepts every declared depth', () => {
    for (const d of REASONING_DEPTHS) {
      expect(isReasoningDepth(d)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isReasoningDepth('medium')).toBe(false);
    expect(isReasoningDepth('')).toBe(false);
    expect(isReasoningDepth(undefined)).toBe(false);
    expect(isReasoningDepth(2)).toBe(false);
  });
});
