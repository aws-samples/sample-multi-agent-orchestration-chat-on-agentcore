/**
 * GPT-6 on Bedrock (Converse path) — Integration Tests
 *
 * The GPT-6 family is the one OpenAI family on Bedrock that speaks the plain
 * Converse API, so createBedrockModel() builds a Strands `BedrockModel` for it —
 * NOT the `OpenAIModel` used for gpt-oss / gpt-5.x (those are covered by
 * openai-model.integration.test.ts). This suite exists to prove that routing:
 * an accidental `endpoint` in the registry would send these models down the
 * bearer-token OpenAI path and fail here.
 *
 * Why the global. CRIS prefix is mandatory: in-Region invocation of the bare id
 * is rejected ("Invocation of model ID openai.gpt-6-sol with on-demand
 * throughput isn't supported"). The Global profile is ACTIVE in every region
 * these models ship in, so no region pin is needed.
 *
 * Requirements:
 *   - AWS credentials with `bedrock:InvokeModel` +
 *     `bedrock:InvokeModelWithResponseStream` on the GPT-6 inference profiles and
 *     foundation models. No `bedrock:CallWithBearerToken` — that is only for the
 *     OpenAI-compatible endpoints.
 *   - Model access granted for the GPT-6 models in BEDROCK_REGION.
 *
 * The suite is OPT-IN: set RUN_BEDROCK_GPT6_INTEGRATION=1 to run it. Without the
 * flag it is skipped (so CI / restricted roles do not fail).
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_GPT6_INTEGRATION=1 BEDROCK_REGION=ap-northeast-1 \
 *     npm run test:integration -- gpt6-converse
 */

import { it, expect } from '@jest/globals';
import { z } from 'zod';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk';
import { createBedrockModel } from '../../../config/bedrock.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const GPT_6_SOL = 'global.openai.gpt-6-sol';
const GPT_6_LUNA = 'global.openai.gpt-6-luna';

const describeGpt6 = describeIfEnv(
  ['RUN_BEDROCK_GPT6_INTEGRATION'],
  'GPT-6 on Bedrock (Converse) integration'
);

/** Extract text from a message's content blocks. */
function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

/** Drive the agent via streaming and collect all emitted events. */
async function streamAll(agent: Agent, prompt: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of agent.stream(prompt)) {
    events.push(event);
  }
  return events;
}

for (const [label, modelId] of [
  ['GPT-6 Sol', GPT_6_SOL],
  ['GPT-6 Luna', GPT_6_LUNA],
] as const) {
  describeGpt6(`${label} (${modelId})`, () => {
    it('is routed to the Converse BedrockModel, not the OpenAI endpoint path', () => {
      // Transport assertion — no network call. Guards the registry decision:
      // if someone adds `endpoint: 'mantle'`, this becomes an OpenAIModel.
      expect(createBedrockModel({ modelId })).toBeInstanceOf(BedrockModel);
    });

    it('follows the system prompt (PING -> PONG)', async () => {
      const agent = new Agent({
        model: createBedrockModel({ modelId }),
        systemPrompt:
          'Always respond with exactly the word "PONG" when the user says "PING". No other text.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      await streamAll(agent, 'PING');

      expect(textOf(agent.messages[agent.messages.length - 1]).toUpperCase()).toContain('PONG');
    }, 90_000);

    it('streams events and answers a factual question', async () => {
      const agent = new Agent({
        model: createBedrockModel({ modelId }),
        systemPrompt: 'Be very brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      const events = await streamAll(agent, 'What is the capital of Japan? One word.');

      expect(events.length).toBeGreaterThan(0);
      expect(agent.messages).toHaveLength(2);
      expect(agent.messages[0].role).toBe('user');
      expect(agent.messages[1].role).toBe('assistant');
      expect(textOf(agent.messages[1]).toLowerCase()).toContain('tokyo');
    }, 90_000);

    it('remembers context across turns', async () => {
      const agent = new Agent({
        model: createBedrockModel({ modelId }),
        systemPrompt: 'Be very brief.',
        tools: [],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      await streamAll(agent, 'My name is Alice.');
      await streamAll(agent, 'What is my name?');

      expect(agent.messages).toHaveLength(4);
      expect(textOf(agent.messages[3]).toLowerCase()).toContain('alice');
    }, 120_000);

    it('invokes a tool and uses its result', async () => {
      let called = 0;
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get the current weather for a city. Always call this for weather questions.',
        inputSchema: z.object({ city: z.string().describe('City name') }),
        callback: async ({ city }) => {
          called += 1;
          return `The weather in ${city} is 7 degrees Celsius and snowing.`;
        },
      });

      const agent = new Agent({
        model: createBedrockModel({ modelId }),
        systemPrompt:
          'You are a weather assistant. Use the get_weather tool to answer weather questions, then report the result.',
        tools: [getWeather],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      await streamAll(agent, 'What is the weather in Sapporo right now?');

      expect(called).toBeGreaterThanOrEqual(1);
      const finalText = textOf(agent.messages[agent.messages.length - 1]).toLowerCase();
      expect(finalText).toMatch(/snow|7|seven/);
    }, 120_000);
  });
}
