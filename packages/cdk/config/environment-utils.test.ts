import {
  deriveBedrockIamResources,
  hasBedrockOpenAiModel,
  hasMantleModel,
  validateBedrockModelsForTest,
} from './environment-utils';

const REGION = 'us-east-1';
const ACCOUNT = '123456789012';

describe('deriveBedrockIamResources', () => {
  // ── ARN format helpers ──────────────────────────────────────────────────────

  it('generates an inference-profile ARN with the given region and account', () => {
    const models = [
      { id: 'global.anthropic.claude-sonnet-4-6', name: 'Claude', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-4-6`
    );
  });

  it('generates a foundation-model ARN without an account segment (arn:aws:bedrock:*::foundation-model/...)', () => {
    const models = [
      { id: 'global.anthropic.claude-sonnet-4-6', name: 'Claude', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    const foundationModelArns = result.filter((r) => r.includes('::foundation-model/'));
    expect(foundationModelArns.length).toBeGreaterThan(0);
    // No account ID should appear in foundation-model ARNs
    foundationModelArns.forEach((arn) => {
      expect(arn).not.toContain(ACCOUNT);
    });
  });

  // ── Prefix stripping ────────────────────────────────────────────────────────

  it('strips the "global." prefix when building the foundation-model ARN', () => {
    const models = [
      {
        id: 'global.anthropic.claude-3-5-sonnet-v2',
        name: 'Claude 3.5',
        provider: 'Anthropic' as const,
      },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-v2*');
  });

  it('strips the "us." prefix when building the foundation-model ARN', () => {
    const models = [
      { id: 'us.amazon.nova-pro-v1:0', name: 'Nova Pro', provider: 'Amazon' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0*');
  });

  it('strips the "eu." prefix when building the foundation-model ARN', () => {
    const models = [
      { id: 'eu.anthropic.claude-3-haiku', name: 'Haiku', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku*');
  });

  it('strips the "apac." prefix when building the foundation-model ARN', () => {
    const models = [
      { id: 'apac.anthropic.claude-3-opus', name: 'Opus', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-3-opus*');
  });

  it('strips the "jp." prefix when building the foundation-model ARN', () => {
    const models = [
      { id: 'jp.amazon.nova-lite-v1:0', name: 'Nova Lite', provider: 'Amazon' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0*');
  });

  it('does not strip unknown prefixes — model ID is used as-is in foundation-model ARN', () => {
    const models = [
      { id: 'anthropic.claude-3-sonnet', name: 'Sonnet', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-3-sonnet*');
  });

  // ── In-Region (no CRIS prefix) models, e.g. Qwen3 ──────────────────────────

  it('skips the inference-profile ARN for a bare In-Region model id (Qwen3)', () => {
    const models = [
      {
        id: 'qwen.qwen3-235b-a22b-2507-v1:0',
        name: 'Qwen3 235B',
        provider: 'Qwen' as const,
      },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    // Only the foundation-model ARN is produced (no inference-profile ARN).
    expect(result).toEqual(['arn:aws:bedrock:*::foundation-model/qwen.qwen3-235b-a22b-2507-v1:0*']);
    expect(result.some((r) => r.includes('inference-profile'))).toBe(false);
  });

  it('still emits an inference-profile ARN for CRIS-prefixed models alongside bare ones', () => {
    const models = [
      {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude',
        provider: 'Anthropic' as const,
      },
      {
        id: 'qwen.qwen3-coder-480b-a35b-v1:0',
        name: 'Qwen3 Coder',
        provider: 'Qwen' as const,
      },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    // Claude → 2 ARNs (inference-profile + foundation-model); Qwen3 → 1 (foundation-model only).
    expect(result).toHaveLength(3);
    expect(result).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-4-6`
    );
    expect(result).toContain(
      'arn:aws:bedrock:*::foundation-model/qwen.qwen3-coder-480b-a35b-v1:0*'
    );
  });

  // ── Multiple models ─────────────────────────────────────────────────────────

  it('produces two ARNs (inference-profile + foundation-model) per model', () => {
    const models = [
      {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet',
        provider: 'Anthropic' as const,
      },
      { id: 'global.amazon.nova-lite-v1:0', name: 'Nova Lite', provider: 'Amazon' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    // 2 models × 2 ARNs each = 4 total (assuming no deduplication)
    expect(result).toHaveLength(4);
  });

  it('includes all model ARNs when multiple models are provided', () => {
    const models = [
      {
        id: 'global.anthropic.claude-opus-4-6',
        name: 'Claude Opus',
        provider: 'Anthropic' as const,
      },
      { id: 'us.amazon.nova-pro-v1:0', name: 'Nova Pro', provider: 'Amazon' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(result).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/global.anthropic.claude-opus-4-6`
    );
    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-6*');
    expect(result).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/us.amazon.nova-pro-v1:0`
    );
    expect(result).toContain('arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0*');
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  it('deduplicates ARNs when the same model ID appears multiple times', () => {
    const model = {
      id: 'global.anthropic.claude-sonnet-4-6',
      name: 'Claude',
      provider: 'Anthropic' as const,
    };
    const result = deriveBedrockIamResources([model, model], REGION, ACCOUNT);

    // Should dedupe to 2 unique ARNs (one inference-profile + one foundation-model)
    expect(result).toHaveLength(2);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it('deduplicates when two different prefixes resolve to the same base model ID', () => {
    // 'global.anthropic.claude-3' and 'us.anthropic.claude-3' both strip to 'anthropic.claude-3'
    const models = [
      { id: 'global.anthropic.claude-3', name: 'Claude Global', provider: 'Anthropic' as const },
      { id: 'us.anthropic.claude-3', name: 'Claude US', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    // 2 inference-profile ARNs (different full IDs) + 1 foundation-model ARN (deduped)
    expect(result).toHaveLength(3);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('returns an empty array when given no models', () => {
    const result = deriveBedrockIamResources([], REGION, ACCOUNT);
    expect(result).toEqual([]);
  });

  it('returns an array of strings', () => {
    const models = [
      { id: 'global.amazon.nova-micro-v1:0', name: 'Nova Micro', provider: 'Amazon' as const },
    ];
    const result = deriveBedrockIamResources(models, REGION, ACCOUNT);

    expect(Array.isArray(result)).toBe(true);
    result.forEach((arn) => expect(typeof arn).toBe('string'));
  });

  it('embeds the correct region in inference-profile ARNs when a non-default region is used', () => {
    const models = [
      { id: 'eu.anthropic.claude-3-haiku', name: 'Haiku', provider: 'Anthropic' as const },
    ];
    const result = deriveBedrockIamResources(models, 'eu-west-1', '999888777666');

    expect(result).toContain(
      'arn:aws:bedrock:eu-west-1:999888777666:inference-profile/eu.anthropic.claude-3-haiku'
    );
  });

  it('embeds the correct account in inference-profile ARNs', () => {
    const models = [
      { id: 'global.amazon.nova-pro-v1:0', name: 'Nova Pro', provider: 'Amazon' as const },
    ];
    const customAccount = '111222333444';
    const result = deriveBedrockIamResources(models, REGION, customAccount);

    expect(result.find((r) => r.includes('inference-profile'))).toContain(customAccount);
  });

  // ── Per-model region pin ─────────────────────────────────────────────────────
  //
  // A model may pin its invocation region (BedrockModelConfig.region). The agent
  // invokes that model in the pinned region (via @moca/core getModelRegion), so
  // the inference-profile ARN MUST be scoped to the pinned region — not the
  // deployment region — or bedrock:InvokeModelWithResponseStream is AccessDenied.
  // Regression for the Fable 5 us-east-1 pin vs ap-northeast-1 deploy mismatch.

  it('scopes the inference-profile ARN to a model.region pin instead of the deploy region', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
        region: 'us-east-1',
      },
    ];
    // Deploy region is ap-northeast-1, but the model is pinned to us-east-1.
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    expect(result).toContain(
      `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/global.anthropic.claude-fable-5`
    );
    // The deploy-region ARN must NOT be produced — it would not match the call
    // and the pinned-region ARN above is the only one the agent uses.
    expect(result).not.toContain(
      `arn:aws:bedrock:ap-northeast-1:${ACCOUNT}:inference-profile/global.anthropic.claude-fable-5`
    );
  });

  it('falls back to the deploy region for the inference-profile ARN when no region pin is set', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
      },
    ];
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    expect(result).toContain(
      `arn:aws:bedrock:ap-northeast-1:${ACCOUNT}:inference-profile/global.anthropic.claude-fable-5`
    );
  });

  it('keeps the foundation-model ARN region-wildcarded regardless of a region pin', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
        region: 'us-east-1',
      },
    ];
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    expect(result).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-fable-5*');
  });

  // ── OpenAI (gpt-oss) models ───────────────────────────────────────────────────
  //
  // OpenAI ids (openai.gpt-oss-120b-1:0) carry no cross-region inference-profile
  // prefix, so — like Qwen — only a foundation-model ARN is produced. IAM auth
  // for these models rides on the region-wildcarded foundation-model ARN plus
  // bedrock:CallWithBearerToken (the OpenAI Chat Completions endpoint region is
  // applied at the agent layer, not via an inference-profile ARN).

  it('emits only a foundation-model ARN for an OpenAI (gpt-oss) model id', () => {
    const models = [
      {
        id: 'openai.gpt-oss-120b-1:0',
        name: 'GPT-OSS 120B',
        provider: 'OpenAI' as const,
      },
    ];
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    expect(result).toEqual(['arn:aws:bedrock:*::foundation-model/openai.gpt-oss-120b-1:0*']);
    expect(result.some((r) => r.includes('inference-profile'))).toBe(false);
  });

  it('emits only a foundation-model ARN for a gpt-5.x (Mantle) model id, region pin notwithstanding', () => {
    const models = [
      {
        id: 'openai.gpt-5.5',
        name: 'GPT-5.5',
        provider: 'OpenAI' as const,
        region: 'us-east-1',
      },
    ];
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    // No inference-profile prefix on bare openai.* ids, so the region pin does
    // not scope any ARN here; the wildcard foundation-model ARN + bearer-token
    // action carry auth.
    expect(result).toEqual(['arn:aws:bedrock:*::foundation-model/openai.gpt-5.5*']);
    expect(result.some((r) => r.includes('inference-profile'))).toBe(false);
  });

  it('uses each model’s own region pin when models pin different regions', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
        region: 'us-east-1',
      },
      {
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'Anthropic' as const,
        region: 'us-west-2',
      },
    ];
    const result = deriveBedrockIamResources(models, 'ap-northeast-1', ACCOUNT);

    expect(result).toContain(
      `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/global.anthropic.claude-fable-5`
    );
    expect(result).toContain(
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/global.anthropic.claude-sonnet-4-6`
    );
  });
});

// Region-format validation surfaces at synth time via getEnvironmentConfig →
// resolveConfig → validateBedrockModels. A malformed region pin should throw.
describe('validateBedrockModels — region pin format', () => {
  it('rejects a model whose region is not a valid AWS region token', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
        region: 'US-East-1', // wrong: uppercase / not a region token
      },
    ];
    expect(() => deriveBedrockIamResources(models, REGION, ACCOUNT)).not.toThrow();
    // Validation lives on the config path; assert there via the exported guard.
    expect(() => validateBedrockModelsForTest(models)).toThrow(/region/i);
  });

  it('accepts a model with a well-formed region pin', () => {
    const models = [
      {
        id: 'global.anthropic.claude-fable-5',
        name: 'Claude Fable 5',
        provider: 'Anthropic' as const,
        region: 'ap-northeast-1',
      },
    ];
    expect(() => validateBedrockModelsForTest(models)).not.toThrow();
  });

  it('accepts the OpenAI provider', () => {
    const models = [
      {
        id: 'openai.gpt-oss-120b-1:0',
        name: 'GPT-OSS 120B',
        provider: 'OpenAI' as const,
      },
    ];
    expect(() => validateBedrockModelsForTest(models)).not.toThrow();
  });
});

// The two non-Converse endpoints gate DIFFERENT IAM: bedrock-openai (gpt-oss) →
// bedrock:CallWithBearerToken; mantle (gpt-5.x) → the separate bedrock-mantle:
// service statements. Each helper must match only its endpoint.
describe('hasBedrockOpenAiModel', () => {
  it('is true only when a bedrock-openai (gpt-oss) model is configured', () => {
    expect(
      hasBedrockOpenAiModel([
        { id: 'openai.gpt-oss-20b-1:0', name: 'GPT-OSS 20B', provider: 'OpenAI', endpoint: 'bedrock-openai' },
      ])
    ).toBe(true);
  });

  it('is false when only a mantle (gpt-5.x) model is configured', () => {
    expect(
      hasBedrockOpenAiModel([
        { id: 'openai.gpt-5.5', name: 'GPT-5.5', provider: 'OpenAI', region: 'us-east-1', endpoint: 'mantle' },
      ])
    ).toBe(false);
  });

  it('is false for Converse models and empty lists', () => {
    expect(
      hasBedrockOpenAiModel([
        { id: 'qwen.qwen3-coder-next', name: 'Qwen3', provider: 'Qwen' },
      ])
    ).toBe(false);
    expect(hasBedrockOpenAiModel([])).toBe(false);
  });
});

describe('hasMantleModel', () => {
  it('is true only when a mantle (gpt-5.x) model is configured', () => {
    expect(
      hasMantleModel([
        { id: 'openai.gpt-5.4', name: 'GPT-5.4', provider: 'OpenAI', region: 'us-east-1', endpoint: 'mantle' },
      ])
    ).toBe(true);
  });

  it('is false when only a bedrock-openai (gpt-oss) model is configured', () => {
    expect(
      hasMantleModel([
        { id: 'openai.gpt-oss-20b-1:0', name: 'GPT-OSS 20B', provider: 'OpenAI', endpoint: 'bedrock-openai' },
      ])
    ).toBe(false);
  });

  it('is false for Converse models and empty lists', () => {
    expect(
      hasMantleModel([
        { id: 'global.anthropic.claude-opus-4-8', name: 'Opus', provider: 'Anthropic' },
      ])
    ).toBe(false);
    expect(hasMantleModel([])).toBe(false);
  });
});
