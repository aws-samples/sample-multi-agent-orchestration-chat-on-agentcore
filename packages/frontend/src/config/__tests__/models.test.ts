import { describe, it, expect } from 'vitest';
import { AVAILABLE_MODELS, getModelById, getModelDisplayName } from '../models';

describe('AVAILABLE_MODELS fallback (derived from @moca/core BEDROCK_MODEL_DEFINITIONS)', () => {
  it('includes the OpenAI models (gpt-5.x + gpt-oss) so the selector can offer them', () => {
    const openai = AVAILABLE_MODELS.filter((m) => m.provider === 'OpenAI');
    const ids = openai.map((m) => m.id);
    expect(ids).toContain('openai.gpt-5.5');
    expect(ids).toContain('openai.gpt-5.4');
    expect(ids).toContain('openai.gpt-oss-120b-1:0');
    expect(ids).toContain('openai.gpt-oss-20b-1:0');
  });

  it('exposes GPT-5.5 with a display name and OpenAI provider', () => {
    const model = getModelById('openai.gpt-5.5');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('OpenAI');
    expect(model?.name).toBe('GPT-5.5');
  });

  it('exposes GPT-OSS with a display name and OpenAI provider', () => {
    const model = getModelById('openai.gpt-oss-120b-1:0');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('OpenAI');
    expect(model?.name).toBe('GPT-OSS 120B');
  });

  it('renders a display label for a GPT-OSS id', () => {
    // getModelDisplayName drives the selector trigger label.
    expect(getModelDisplayName('openai.gpt-oss-20b-1:0')).toContain('GPT-OSS 20B');
  });

  it('includes GPT-6.1 Terra with the correct provider and display name', () => {
    // GPT-6.1 Terra (GA 2026-10-26) must appear in the AVAILABLE_MODELS fallback
    // (derived from BEDROCK_MODEL_DEFINITIONS) so the frontend model selector can
    // offer it when no VITE_BEDROCK_MODELS env var is set.
    const model = getModelById('global.openai.gpt-6.1-terra');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('OpenAI');
    expect(model?.name).toBe('GPT-6.1 Terra');
    expect(getModelDisplayName('global.openai.gpt-6.1-terra')).toContain('GPT-6.1 Terra');
    expect(getModelDisplayName('global.openai.gpt-6.1-terra')).toContain('OpenAI');
  });
});
