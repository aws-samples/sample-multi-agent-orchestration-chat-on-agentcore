import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { BedrockRuntimeClient, type ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { Agent, ReasoningBlock } from '@strands-agents/sdk';
import { contentBlockToWire, wireToContentBlock } from '../../libs/codec/content-block-codec.js';

jest.unstable_mockModule('../index.js', () => ({
  config: { BEDROCK_REGION: 'us-east-1', ENABLE_PROMPT_CACHING: false },
}));
const { createBedrockModel } = await import('../bedrock.js');

afterEach(() => jest.restoreAllMocks());

describe('OpenAI Converse reasoning stream', () => {
  it('sends provider fields and round-trips a streamed summary through session storage', async () => {
    const send = jest.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({
      stream: (async function* () {
        yield { messageStart: { role: 'assistant' } };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { text: 'Summary of the calculation.' } },
          },
        };
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { reasoningContent: { signature: 'summary-signature' } },
          },
        };
        yield { contentBlockStop: { contentBlockIndex: 0 } };
        yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: '42' } } };
        yield { contentBlockStop: { contentBlockIndex: 1 } };
        yield { messageStop: { stopReason: 'end_turn' } };
        yield {
          metadata: {
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            metrics: { latencyMs: 1 },
          },
        };
      })(),
    } as never);

    const agent = new Agent({
      model: createBedrockModel({ modelId: 'global.openai.gpt-6-sol', reasoningEffort: 'high' }),
      tools: [],
    });
    await agent.invoke('What is 6 times 7?');

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as ConverseStreamCommand;
    expect(command.input.additionalModelRequestFields).toStrictEqual({
      reasoning: { effort: 'high', summary: 'auto' },
    });
    const summary = agent.messages.at(-1)?.content.find((block) => block.type === 'reasoningBlock');
    expect(summary).toBeInstanceOf(ReasoningBlock);
    const restored = wireToContentBlock(JSON.parse(JSON.stringify(contentBlockToWire(summary!))));
    expect(restored).toMatchObject({
      type: 'reasoningBlock',
      text: 'Summary of the calculation.',
      signature: 'summary-signature',
    });
  });
});
