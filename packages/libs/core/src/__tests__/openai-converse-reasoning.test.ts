import { describe, expect, it } from 'vitest';
import {
  getBedrockEndpoint,
  getMaxReasoningDepth,
  getReasoningConfig,
  isReasoningCapable,
  type ReasoningDepth,
} from '../bedrock-models.js';

describe.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('%s Converse reasoning', (model) => {
  it.each(['global.', 'us.', ''])('uses OpenAI fields for the %s profile', (prefix) => {
    const modelId = `${prefix}openai.${model}`;
    expect(isReasoningCapable(modelId)).toBe(true);
    expect(getBedrockEndpoint(modelId)).toBeUndefined();
    expect(getMaxReasoningDepth(modelId)).toBe('high');
    expect(getReasoningConfig(modelId, 'low')).toStrictEqual({
      reasoning: { effort: 'low', summary: 'auto' },
    });
    expect(getReasoningConfig(modelId, 'high')).toStrictEqual({
      reasoning: { effort: 'high', summary: 'auto' },
    });
    expect(getReasoningConfig(modelId, 'max')).toStrictEqual({
      reasoning: { effort: 'high', summary: 'auto' },
    });
  });

  it.each([undefined, 'off', 'xhigh' as ReasoningDepth])(
    'omits reasoning fields for %s',
    (depth) => {
      expect(getReasoningConfig(`global.openai.${model}`, depth)).toBeUndefined();
    }
  );
});
