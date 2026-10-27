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
  normalizeReasoningEffort,
  isReasoningAlwaysOn,
  getOffThinkingMode,
  shouldStripPriorReasoning,
  getBedrockEndpoint,
  type ReasoningDepth,
} from '../bedrock-models.js';

describe('Claude Sonnet 5.5', () => {
  const ID = 'global.anthropic.claude-sonnet-5-5';

  it('is registered directly above Sonnet 5 without changing the default', () => {
    expect(BEDROCK_MODEL_DEFINITIONS[0].id).toBe('global.anthropic.claude-opus-5');
    const i = BEDROCK_MODEL_DEFINITIONS.findIndex((m) => m.id === ID);
    expect(i).toBeGreaterThan(0);
    expect(BEDROCK_MODEL_DEFINITIONS[i + 1].id).toBe('global.anthropic.claude-sonnet-5');
    expect(BEDROCK_MODEL_DEFINITIONS[i]).toMatchObject({
      name: 'Claude Sonnet 5.5',
      provider: 'Anthropic',
      reasoningAlwaysOn: true,
      offThinkingMode: 'between_tools',
      stripPriorReasoning: true,
    });
  });

  it.each(['', 'global.'])('resolves metadata for the %s profile prefix', (prefix) => {
    const modelId = `${prefix}anthropic.claude-sonnet-5-5`;
    expect(isReasoningCapable(modelId)).toBe(true);
    expect(isReasoningAlwaysOn(modelId)).toBe(true);
    expect(getMaxOutputTokens(modelId)).toBe(128000);
    expect(getModelRegion(modelId)).toBeUndefined();
    expect(getBedrockEndpoint(modelId)).toBeUndefined();
    expect(getMaxReasoningDepth(modelId)).toBe('max');
    expect(getOffThinkingMode(modelId)).toBe('between_tools');
    expect(shouldStripPriorReasoning(modelId)).toBe(true);
  });

  it('maps depth off to between_tools with no other thinking or effort field', () => {
    expect(getReasoningConfig(ID, 'off')).toStrictEqual({ thinking: { type: 'between_tools' } });
  });

  it('sends adaptive + summarized for low/high/max without clamping', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(getReasoningConfig(ID, effort)).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
      });
    }
  });

  it('leaves off unchanged for every model without offThinkingMode', () => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if (m.offThinkingMode) continue;
      expect(getReasoningConfig(m.id, 'off')).toBeUndefined();
      expect(shouldStripPriorReasoning(m.id)).toBe(false);
    }
  });
});

describe('Claude Haiku 5.5', () => {
  const ID = 'global.anthropic.claude-haiku-5-5';

  it('is opt-in after Sonnet 4.6 without changing the default', () => {
    expect(BEDROCK_MODEL_DEFINITIONS[0].id).toBe('global.anthropic.claude-opus-5');
    const i = BEDROCK_MODEL_DEFINITIONS.findIndex((m) => m.id === ID);
    expect(BEDROCK_MODEL_DEFINITIONS[i - 1].id).toBe('global.anthropic.claude-sonnet-4-6');
    expect(BEDROCK_MODEL_DEFINITIONS[i + 1].id).toBe('global.amazon.nova-2-lite-v1:0');
    expect(BEDROCK_MODEL_DEFINITIONS[i]).toMatchObject({
      name: 'Claude Haiku 5.5',
      provider: 'Anthropic',
      offThinkingMode: 'disabled',
      stripPriorReasoning: true,
    });
    expect(BEDROCK_MODEL_DEFINITIONS[i].reasoningAlwaysOn).toBeUndefined();
  });

  it.each(['', 'global.', 'us.', 'eu.', 'au.', 'jp.'])(
    'resolves metadata for the %s profile prefix',
    (prefix) => {
      const modelId = `${prefix}anthropic.claude-haiku-5-5`;
      expect(isReasoningCapable(modelId)).toBe(true);
      expect(isReasoningAlwaysOn(modelId)).toBe(false);
      expect(getMaxOutputTokens(modelId)).toBe(128000);
      expect(getModelRegion(modelId)).toBeUndefined();
      expect(getBedrockEndpoint(modelId)).toBeUndefined();
      expect(getMaxReasoningDepth(modelId)).toBe('max');
      expect(getOffThinkingMode(modelId)).toBe('disabled');
      expect(shouldStripPriorReasoning(modelId)).toBe(true);
    }
  );

  it('maps depth off to disabled with no effort or display field', () => {
    expect(getReasoningConfig(ID, 'off')).toStrictEqual({ thinking: { type: 'disabled' } });
  });

  it('sends adaptive + summarized for low/high/max without clamping', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(getReasoningConfig(ID, effort)).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort },
      });
    }
  });
});

describe('reasoning value semantics (unset / invalid / off)', () => {
  const HAIKU = 'global.anthropic.claude-haiku-5-5';
  const SONNET_55 = 'global.anthropic.claude-sonnet-5-5';

  it.each([
    ['unset', undefined],
    ['unknown', 'medium' as ReasoningDepth],
    ['unknown', 'xhigh' as ReasoningDepth],
  ])('sends no thinking field for an %s depth on every model', (_label, depth) => {
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      expect(getReasoningConfig(m.id, depth)).toBeUndefined();
    }
  });

  it('only off on an offThinkingMode model differs from unset', () => {
    expect(getReasoningConfig(HAIKU, 'off')).toStrictEqual({ thinking: { type: 'disabled' } });
    expect(getReasoningConfig(SONNET_55, 'off')).toStrictEqual({
      thinking: { type: 'between_tools' },
    });
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if (m.offThinkingMode) continue;
      expect(getReasoningConfig(m.id, 'off')).toBe(getReasoningConfig(m.id, undefined));
    }
  });
});

describe('normalizeReasoningEffort', () => {
  it.each([undefined, null, ''])('treats %p as unset', (value) => {
    expect(normalizeReasoningEffort(value)).toEqual({ depth: undefined, invalid: false });
  });

  it.each(REASONING_DEPTHS)('passes %s through', (depth) => {
    expect(normalizeReasoningEffort(depth)).toEqual({ depth, invalid: false });
  });

  it('matches known depths case-insensitively', () => {
    expect(normalizeReasoningEffort('OFF')).toEqual({ depth: 'off', invalid: false });
    expect(normalizeReasoningEffort('High')).toEqual({ depth: 'high', invalid: false });
  });

  it.each(['medium', 'xhigh', 'none', ' off', 2, true, {}])(
    'flags %p as invalid and leaves it unset (never off)',
    (value) => {
      expect(normalizeReasoningEffort(value)).toEqual({ depth: undefined, invalid: true });
    }
  );
});

describe('Claude Opus 5.5', () => {
  it('is opt-in immediately after Opus 5 without changing the default', () => {
    expect(BEDROCK_MODEL_DEFINITIONS[0].id).toBe('global.anthropic.claude-opus-5');
    expect(BEDROCK_MODEL_DEFINITIONS[1]).toMatchObject({
      id: 'global.anthropic.claude-opus-5-5',
      name: 'Claude Opus 5.5',
      provider: 'Anthropic',
      reasoningAlwaysOn: true,
    });
  });

  it.each(['', 'global.', 'us.', 'eu.', 'au.', 'jp.'])(
    'resolves metadata and effort for the %s profile prefix',
    (prefix) => {
      const modelId = `${prefix}anthropic.claude-opus-5-5`;
      expect(isReasoningCapable(modelId)).toBe(true);
      expect(getMaxOutputTokens(modelId)).toBe(128000);
      expect(getModelRegion(modelId)).toBeUndefined();
      expect(getBedrockEndpoint(modelId)).toBeUndefined();
      expect(getMaxReasoningDepth(modelId)).toBe('max');
      for (const effort of ['low', 'high', 'max'] as const) {
        expect(getReasoningConfig(modelId, effort)).toEqual({
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort },
        });
      }
      const storedOff: ReasoningDepth = 'off';
      expect(getReasoningConfig(modelId, storedOff)).toBeUndefined();
    }
  );
});

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

  it('does not region-pin the gpt-oss models — available in the deploy region', () => {
    // GPT-OSS is available in ap-northeast-1 (default deploy region) and
    // us-east-1/2 + us-west-2, so it is invoked in BEDROCK_REGION with no pin.
    expect(getModelRegion('openai.gpt-oss-120b-1:0')).toBeUndefined();
    expect(getModelRegion('openai.gpt-oss-20b-1:0')).toBeUndefined();
  });

  it('pins the gpt-5.x (Mantle) models to us-east-1', () => {
    // gpt-5.5 exists ONLY in us-east-1 (404 elsewhere); gpt-5.4 is pinned there
    // too so a single Mantle region serves both. The pin must match the CDK
    // DEFAULT_CONFIG entry, or the Mantle invocation targets the wrong region.
    expect(getModelRegion('openai.gpt-5.5')).toBe('us-east-1');
    expect(getModelRegion('openai.gpt-5.4')).toBe('us-east-1');
  });
});

describe('getBedrockEndpoint', () => {
  it('maps gpt-oss to the bedrock-openai (Chat Completions) endpoint', () => {
    expect(getBedrockEndpoint('openai.gpt-oss-120b-1:0')).toBe('bedrock-openai');
    expect(getBedrockEndpoint('openai.gpt-oss-20b-1:0')).toBe('bedrock-openai');
  });

  it('maps gpt-5.x to the mantle (Responses API) endpoint', () => {
    expect(getBedrockEndpoint('openai.gpt-5.5')).toBe('mantle');
    expect(getBedrockEndpoint('openai.gpt-5.4')).toBe('mantle');
  });

  it('returns undefined for Converse-API and unknown models', () => {
    expect(getBedrockEndpoint('global.anthropic.claude-opus-4-8')).toBeUndefined();
    expect(getBedrockEndpoint('qwen.qwen3-coder-next')).toBeUndefined();
    expect(getBedrockEndpoint('does.not.exist-v1:0')).toBeUndefined();
  });

  it('never marks a non-Converse-endpoint model as reasoning-capable (distinct thinking path)', () => {
    // These models don't use the Anthropic-native adaptive-thinking field, so
    // they must not surface the Bedrock reasoning config. Guards against a
    // future edit accidentally setting reasoningCapable on one.
    for (const m of BEDROCK_MODEL_DEFINITIONS) {
      if (m.endpoint) {
        expect(m.reasoningCapable).not.toBe(true);
      }
    }
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

  it('registers Claude Opus 5 as the default (first) model with the correct limit', () => {
    const first = BEDROCK_MODEL_DEFINITIONS[0];
    expect(first.id).toBe('global.anthropic.claude-opus-5');
    expect(first.name).toBe('Claude Opus 5');
    expect(first.provider).toBe('Anthropic');
    expect(getMaxOutputTokens('global.anthropic.claude-opus-5')).toBe(128000);
  });

  it('does not region-pin the default model (Opus 5 must use the deploy region)', () => {
    // The default model must work in any deployment region with no special
    // account setup, so it must not be pinned to a specific region.
    expect(getModelRegion('global.anthropic.claude-opus-5')).toBeUndefined();
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

  it('caps Sonnet 5 reasoning at high (Bedrock rejects effort:max on non-Opus)', () => {
    expect(getMaxReasoningDepth('global.anthropic.claude-sonnet-5')).toBe('high');
  });

  it('registers Sonnet 5 with 128k output tokens', () => {
    expect(getMaxOutputTokens('global.anthropic.claude-sonnet-5')).toBe(128000);
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

  it('registers Claude Fable 5.1 with 128k output tokens, reasoning-capable, no region pin', () => {
    // Fable 5.1 (GA 2026-09-01) is a Covered Model: it needs Bedrock Data
    // Retention mode `aws_review` in its invocation region, but WHICH region has
    // it is account/deployment-specific — so, like Fable 5, the OSS default
    // ships no region pin (invoked in the deploy region). It shares the 128k
    // Bedrock output ceiling and, as a Mythos-class Anthropic model, is
    // reasoning-capable up to `max` (Opus-tier).
    expect(getMaxOutputTokens('global.anthropic.claude-fable-5-1')).toBe(128000);
    expect(getModelRegion('global.anthropic.claude-fable-5-1')).toBeUndefined();
    expect(isReasoningCapable('global.anthropic.claude-fable-5-1')).toBe(true);
    expect(getMaxReasoningDepth('global.anthropic.claude-fable-5-1')).toBe('max');
    // Standard Converse path — not a Mantle/OpenAI transport.
    expect(getBedrockEndpoint('global.anthropic.claude-fable-5-1')).toBeUndefined();
  });

  it('registers GPT-6 Astra on the Converse path (no endpoint), no region pin, non-reasoning', () => {
    // GPT-6 Astra (GA 2026-09-08) is an OpenAI model that — unlike the GPT-5.x
    // Mantle models — supports Converse on bedrock-runtime, so it loads on the
    // standard Converse path with NO endpoint override. Its Global CRIS profile
    // is available in every region (incl. the deploy region), so no region pin.
    // reasoningCapable is intentionally omitted: getReasoningConfig() would send
    // the Anthropic-native thinking shape, which OpenAI rejects over Converse.
    expect(getMaxOutputTokens('global.openai.gpt-6-astra')).toBe(128000);
    expect(getModelRegion('global.openai.gpt-6-astra')).toBeUndefined();
    // Converse transport — not Mantle/bedrock-openai.
    expect(getBedrockEndpoint('global.openai.gpt-6-astra')).toBeUndefined();
    // No depth selector surfaced for this model.
    expect(isReasoningCapable('global.openai.gpt-6-astra')).toBe(false);
  });

  it('registers GPT-6 Sol and Luna on the Converse path with the 131072 Bedrock ceiling', () => {
    // GPT-6 Sol / Luna (GA 2026-09-22) support Converse on bedrock-runtime
    // (verified live), so — like Astra and unlike the GPT-5.x Mantle models —
    // they carry no endpoint override. Their Global CRIS profiles are ACTIVE in
    // the deploy region, so no region pin. Bedrock reports a 131072 output
    // ceiling for both (200000 → "exceeds the model limit of 131072"), so this
    // guard fails if the registry is ever bumped past what Bedrock accepts.
    for (const id of ['global.openai.gpt-6-sol', 'global.openai.gpt-6-luna']) {
      expect(getMaxOutputTokens(id)).toBe(131072);
      expect(getModelRegion(id)).toBeUndefined();
      expect(getBedrockEndpoint(id)).toBeUndefined();
      // Anthropic-native thinking shape is rejected by these models over
      // Converse (unknown_parameter 'output_config'), so no depth selector.
      expect(isReasoningCapable(id)).toBe(false);
    }
  });

  it('registers GPT-6.1 Terra on the Converse path with the 128000 output ceiling', () => {
    // GPT-6.1 Terra (GA 2026-10-26) supports Converse on bedrock-runtime (model
    // card: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-terra.html).
    // Same transport as GPT-6 Astra/Sol/Luna: no `endpoint` override, no region
    // pin. The Global CRIS profile is available from ap-northeast-1 (the default
    // deploy region). maxOutputTokens is 128,000 — NOT 131,072; the model card
    // explicitly lists 128k (same as GPT-6 Astra; GPT-6 Sol/Luna are 131,072).
    const id = 'global.openai.gpt-6.1-terra';
    expect(getMaxOutputTokens(id)).toBe(128000);
    expect(getModelRegion(id)).toBeUndefined();
    expect(getBedrockEndpoint(id)).toBeUndefined();
    // OpenAI model: Anthropic-native thinking shape (output_config.effort) would
    // be rejected over Converse, so reasoningCapable is intentionally omitted.
    // Once PR #151 (OpenAI reasoning summaries) merges, add Terra there.
    expect(isReasoningCapable(id)).toBe(false);
    // No offThinkingMode, no stripPriorReasoning — standard Converse model.
    expect(getOffThinkingMode(id)).toBeUndefined();
    expect(shouldStripPriorReasoning(id)).toBe(false);
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

  it('clamps effort to the model cap (Sonnet 5 max → high)', () => {
    expect(getReasoningConfig('global.anthropic.claude-sonnet-5', 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    });
    // Below the cap is untouched.
    expect(getReasoningConfig('global.anthropic.claude-sonnet-5', 'low')).toEqual({
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
    expect(
      getReasoningConfig('global.anthropic.claude-opus-4-8', '' as ReasoningDepth)
    ).toBeUndefined();
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

describe('GPT-6.1 Terra', () => {
  const ID = 'global.openai.gpt-6.1-terra';

  it('is registered in BEDROCK_MODEL_DEFINITIONS with the correct shape', () => {
    const entry = BEDROCK_MODEL_DEFINITIONS.find((m) => m.id === ID);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: 'global.openai.gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      provider: 'OpenAI',
      maxOutputTokens: 128000,
    });
    // Intentionally omitted — must not be set (would cause Anthropic-native
    // thinking shape to be sent, which OpenAI models reject over Converse).
    expect(entry?.reasoningCapable).toBeUndefined();
    // Standard Converse path: no Mantle/bedrock-openai endpoint.
    expect(entry?.endpoint).toBeUndefined();
    // No region pin: Global CRIS available from the default deploy region.
    expect(entry?.region).toBeUndefined();
    // No caching-related overrides (explicit cachePoint not supported on Converse).
    expect(entry?.offThinkingMode).toBeUndefined();
    expect(entry?.stripPriorReasoning).toBeUndefined();
  });

  it('is positioned immediately after GPT-6 Luna in the registry', () => {
    const lunaIdx = BEDROCK_MODEL_DEFINITIONS.findIndex((m) => m.id === 'global.openai.gpt-6-luna');
    const terraIdx = BEDROCK_MODEL_DEFINITIONS.findIndex((m) => m.id === ID);
    expect(lunaIdx).toBeGreaterThanOrEqual(0);
    expect(terraIdx).toBe(lunaIdx + 1);
  });

  it.each([
    ['global.openai.gpt-6.1-terra', 'full Global CRIS id'],
    ['openai.gpt-6.1-terra', 'bare (In-Region-style) id'],
  ])('findModel resolves metadata for %s (%s)', (modelId) => {
    // PROFILE_PREFIX strips `global.` but leaves the `.1.` in the model name
    // intact, so both forms must resolve to the same registry entry.
    expect(getMaxOutputTokens(modelId)).toBe(128000);
    expect(getModelRegion(modelId)).toBeUndefined();
    expect(getBedrockEndpoint(modelId)).toBeUndefined();
    expect(isReasoningCapable(modelId)).toBe(false);
    expect(getOffThinkingMode(modelId)).toBeUndefined();
    expect(shouldStripPriorReasoning(modelId)).toBe(false);
  });

  it('does not collide with GPT-6.1 Sol (different model name after stripping prefix)', () => {
    // Both live in the openai. vendor space and share `.1.` in the name, but
    // strip to different ids: openai.gpt-6.1-terra vs openai.gpt-6.1-sol.
    // GPT-6.1 Sol is not yet registered here — this guard ensures Terra does not
    // accidentally absorb a future gpt-6.1-sol lookup.
    expect(getMaxOutputTokens('openai.gpt-6.1-terra')).toBe(128000);
    // Terra must not match a non-existent gpt-6.1-sol entry.
    expect(getMaxOutputTokens('openai.gpt-6.1-sol')).toBeUndefined();
  });

  it('does not collide with GPT-5.6 Terra (different version number)', () => {
    // openai.gpt-5.6-terra and openai.gpt-6.1-terra are distinct after prefix
    // stripping; each resolves to its own registry entry.
    expect(getMaxOutputTokens('openai.gpt-5.6-terra')).toBe(128000); // Mantle, 128k
    expect(getBedrockEndpoint('openai.gpt-5.6-terra')).toBe('mantle');
    expect(getBedrockEndpoint('openai.gpt-6.1-terra')).toBeUndefined(); // Converse
  });

  it('routes to Converse/bedrock-runtime — not Mantle nor bedrock-openai', () => {
    // getBedrockEndpoint() returns undefined for Converse models; createBedrockModel()
    // keys off this to build a BedrockModel (Converse) rather than an OpenAIModel.
    expect(getBedrockEndpoint(ID)).toBeUndefined();
    expect(getBedrockEndpoint('openai.gpt-6.1-terra')).toBeUndefined();
  });

  it('does not send cachePoint on Converse (no explicit caching config set)', () => {
    // The model card: explicit prompt caching is supported via Responses API only
    // (NOT cachePoint on Converse). No special caching field in the registry entry
    // means the agent will never inject a cachePoint into the Converse request.
    const entry = BEDROCK_MODEL_DEFINITIONS.find((m) => m.id === ID);
    // Confirm no caching-related keys that could trigger prompt caching on Converse.
    expect(entry).not.toHaveProperty('promptCaching');
    expect(entry).not.toHaveProperty('cachePoint');
  });
});
