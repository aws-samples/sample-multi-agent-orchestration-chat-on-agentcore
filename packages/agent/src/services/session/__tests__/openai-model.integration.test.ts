/**
 * OpenAI on Bedrock — Integration Tests
 *
 * Verifies the agent works end-to-end against both Bedrock OpenAI-compatible
 * endpoint families. Unlike every other model in this repo, these do NOT use
 * the Converse API — createBedrockModel() routes them to a Strands `OpenAIModel`
 * pointed at the matching endpoint with a locally-minted bearer token (see
 * config/bedrock-openai-model.ts):
 *   - gpt-oss  → bedrock-runtime.{region}.amazonaws.com/openai/v1, Chat Completions
 *   - gpt-5.x  → bedrock-mantle.{region}.api.aws/openai/v1, Responses API
 *
 * Requirements:
 *   - AWS credentials with `bedrock:InvokeModel` +
 *     `bedrock:InvokeModelWithResponseStream` on the OpenAI foundation models AND
 *     `bedrock:CallWithBearerToken` (the bearer-token auth path is gated on it —
 *     without it, InvokeModel is denied under default-deny).
 *   - gpt-oss available in BEDROCK_REGION (ap-northeast-1 + us-east-1/2 + us-west-2,
 *     no pin). gpt-5.x is registry-pinned to us-east-1 regardless of BEDROCK_REGION.
 *
 * The suite is OPT-IN: set RUN_BEDROCK_OPENAI_INTEGRATION=1 to run it. Without
 * the flag it is skipped (so CI / restricted roles do not fail).
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_OPENAI_INTEGRATION=1 BEDROCK_REGION=us-east-1 \
 *     npm run test:integration -- openai-model
 */

import { it, expect } from '@jest/globals';
import { z } from 'zod';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { createBedrockModel } from '../../../config/bedrock.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const GPT_OSS_120B = 'openai.gpt-oss-120b-1:0';
const GPT_OSS_20B = 'openai.gpt-oss-20b-1:0';
const GPT_5_5 = 'openai.gpt-5.5';
const GPT_5_4 = 'openai.gpt-5.4';

const describeOpenAI = describeIfEnv(
  ['RUN_BEDROCK_OPENAI_INTEGRATION'],
  'OpenAI on Bedrock integration'
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

describeOpenAI('GPT-OSS 120B (openai.gpt-oss-120b-1:0)', () => {
  it('follows the system prompt (PING -> PONG)', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_OSS_120B }),
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
      model: createBedrockModel({ modelId: GPT_OSS_120B }),
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

  it('remembers context across turns (stateless Chat Completions — Moca owns history)', async () => {
    // Chat Completions is always stateless, so conversation memory must come
    // from Moca's own message history (SlidingWindowConversationManager), NOT
    // any server-side state. This proves that wiring.
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_OSS_120B }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'My name is Alice.');
    await streamAll(agent, 'What is my name?');

    expect(agent.messages).toHaveLength(4);
    expect(textOf(agent.messages[3]).toLowerCase()).toContain('alice');
  }, 120_000);

  it('invokes a tool and uses its result (agentic tool use across the OpenAI API)', async () => {
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
      model: createBedrockModel({ modelId: GPT_OSS_120B }),
      systemPrompt:
        'You are a weather assistant. Use the get_weather tool to answer weather questions, then report the result.',
      tools: [getWeather],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'What is the weather in Sapporo right now?');

    // The model must have actually invoked the tool (proves the SDK's Chat
    // adapter round-trips OpenAI function-calling <-> Strands toolUse/toolResult)...
    expect(called).toBeGreaterThanOrEqual(1);
    // ...and incorporated the tool result into its final answer.
    const finalText = textOf(agent.messages[agent.messages.length - 1]).toLowerCase();
    expect(finalText).toMatch(/snow|7|seven/);
  }, 120_000);
});

describeOpenAI('GPT-OSS 20B (openai.gpt-oss-20b-1:0)', () => {
  it('streams events and answers a factual question', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_OSS_20B }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    const events = await streamAll(agent, 'What is the capital of Japan? One word.');

    expect(events.length).toBeGreaterThan(0);
    expect(agent.messages).toHaveLength(2);
    expect(textOf(agent.messages[1]).toLowerCase()).toContain('tokyo');
  }, 90_000);
});

describeOpenAI('GPT-5.5 (openai.gpt-5.5 — Mantle Responses API)', () => {
  it('follows the system prompt (PING -> PONG)', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_5_5 }),
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
      model: createBedrockModel({ modelId: GPT_5_5 }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    const events = await streamAll(agent, 'What is the capital of Japan? One word.');

    expect(events.length).toBeGreaterThan(0);
    expect(agent.messages).toHaveLength(2);
    expect(textOf(agent.messages[1]).toLowerCase()).toContain('tokyo');
  }, 90_000);

  it('remembers context across turns (stateless Responses — Moca owns history)', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_5_5 }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'My name is Alice.');
    await streamAll(agent, 'What is my name?');

    expect(agent.messages).toHaveLength(4);
    expect(textOf(agent.messages[3]).toLowerCase()).toContain('alice');
  }, 120_000);

  it('invokes a tool and uses its result (agentic tool use over the Responses API)', async () => {
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
      model: createBedrockModel({ modelId: GPT_5_5 }),
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

describeOpenAI('GPT-5.4 (openai.gpt-5.4 — Mantle Responses API)', () => {
  it('streams events and answers a factual question', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: GPT_5_4 }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    const events = await streamAll(agent, 'What is the capital of Japan? One word.');

    expect(events.length).toBeGreaterThan(0);
    expect(agent.messages).toHaveLength(2);
    expect(textOf(agent.messages[1]).toLowerCase()).toContain('tokyo');
  }, 90_000);
});
