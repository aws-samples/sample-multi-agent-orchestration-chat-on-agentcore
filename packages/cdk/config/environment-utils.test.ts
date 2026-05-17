import { deriveBedrockIamResources } from './environment-utils';

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
});
