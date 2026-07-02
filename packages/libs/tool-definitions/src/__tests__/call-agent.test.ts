/**
 * Unit tests for Call Agent tool definition.
 *
 * Focus: the `modelId` validation. It must accept any namespaced Bedrock model
 * id (including OpenAI/Qwen), NOT a hardcoded vendor allowlist — a sub-agent
 * should be able to run on GPT-5.x / GPT-OSS just like Claude/Nova.
 */

import { callAgentDefinition, callAgentSchema } from '../definitions/call-agent';

const modelId = callAgentSchema.shape.modelId;

describe('Call Agent Tool Definition', () => {
  it('should have correct tool name', () => {
    expect(callAgentDefinition.name).toBe('call_agent');
  });

  describe('modelId validation', () => {
    it('accepts OpenAI model ids (gpt-5.x on Mantle, gpt-oss)', () => {
      for (const id of ['openai.gpt-5.5', 'openai.gpt-5.4', 'openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0']) {
        expect(modelId.safeParse(id).success).toBe(true);
      }
    });

    it('still accepts the previously-allowed Anthropic/Amazon ids', () => {
      for (const id of [
        'global.anthropic.claude-sonnet-4-6',
        'global.anthropic.claude-opus-4-8',
        'global.amazon.nova-2-lite-v1:0',
        'us.anthropic.claude-3-haiku',
      ]) {
        expect(modelId.safeParse(id).success).toBe(true);
      }
    });

    it('accepts bare In-Region ids that the old vendor-allowlist regex rejected (Qwen)', () => {
      // qwen.* did not match the old (anthropic|amazon|meta|mistral|cohere) allowlist.
      expect(modelId.safeParse('qwen.qwen3-coder-next').success).toBe(true);
      expect(modelId.safeParse('qwen.qwen3-235b-a22b-2507-v1:0').success).toBe(true);
    });

    it('is optional (defaults to the agent config when omitted)', () => {
      expect(modelId.safeParse(undefined).success).toBe(true);
    });

    it('rejects non-namespaced or empty ids', () => {
      for (const id of ['', 'gpt5', 'claude', 'not a model', '.leadingdot', 'UPPER.vendor']) {
        expect(modelId.safeParse(id).success).toBe(false);
      }
    });
  });

  it('documents OpenAI as a selectable model in the description', () => {
    // The tool description is the LLM's guidance for which ids to pass, so the
    // new provider must be discoverable there.
    expect(modelId.description).toContain('openai.gpt-5.5');
  });

  it('produces a JSON schema for the model consumer', () => {
    expect(callAgentDefinition.jsonSchema).toBeDefined();
    expect(callAgentDefinition.jsonSchema).toHaveProperty('type', 'object');
  });
});
