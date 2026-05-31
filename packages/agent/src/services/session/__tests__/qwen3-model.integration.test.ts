/**
 * Qwen3 Model Integration Tests
 *
 * Verifies that the agent actually works end-to-end against Bedrock when
 * configured with an In-Region-only Qwen3 model. These call the real
 * Bedrock Converse / ConverseStream API, so they require:
 *   - AWS credentials with `bedrock:InvokeModel` on the Qwen3 foundation models
 *   - Qwen3 enabled in BEDROCK_REGION (Qwen3 has NO cross-region inference
 *     profile, so it must be available In-Region; default us-east-1)
 *
 * The suite is OPT-IN: set RUN_BEDROCK_QWEN_INTEGRATION=1 to run it. Without
 * the flag it is skipped (so CI / restricted roles do not fail).
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_QWEN_INTEGRATION=1 BEDROCK_REGION=us-east-1 \
 *     npm run test:integration -- qwen3-model
 *
 * Verified model IDs (ACTIVE on Bedrock, 2026-05; no "instruct" token):
 *   - qwen.qwen3-235b-a22b-2507-v1:0
 *   - qwen.qwen3-coder-480b-a35b-v1:0
 */

import { it, expect } from '@jest/globals';
import { z } from 'zod';
import { Agent, SlidingWindowConversationManager, tool } from '@strands-agents/sdk';
import { createBedrockModel } from '../../../config/bedrock.js';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

const QWEN3_235B = 'qwen.qwen3-235b-a22b-2507-v1:0';
const QWEN3_CODER_480B = 'qwen.qwen3-coder-480b-a35b-v1:0';

const describeQwen3 = describeIfEnv(['RUN_BEDROCK_QWEN_INTEGRATION'], 'Qwen3 Bedrock integration');

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

describeQwen3('Qwen3 235B A22B (qwen.qwen3-235b-a22b-2507-v1:0)', () => {
  it('follows the system prompt (PING -> PONG)', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: QWEN3_235B }),
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
      model: createBedrockModel({ modelId: QWEN3_235B }),
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
      model: createBedrockModel({ modelId: QWEN3_235B }),
      systemPrompt: 'Be very brief.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'My name is Alice.');
    await streamAll(agent, 'What is my name?');

    expect(agent.messages).toHaveLength(4);
    expect(textOf(agent.messages[3]).toLowerCase()).toContain('alice');
  }, 120_000);

  it('invokes a tool and uses its result (agentic tool use)', async () => {
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
      model: createBedrockModel({ modelId: QWEN3_235B }),
      systemPrompt:
        'You are a weather assistant. Use the get_weather tool to answer weather questions, then report the result.',
      tools: [getWeather],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(agent, 'What is the weather in Sapporo right now?');

    // The model must have actually invoked the tool...
    expect(called).toBeGreaterThanOrEqual(1);
    // ...and incorporated the tool result into its final answer.
    const finalText = textOf(agent.messages[agent.messages.length - 1]).toLowerCase();
    expect(finalText).toMatch(/snow|7|seven/);
  }, 120_000);
});

describeQwen3('Qwen3 Coder 480B A35B (qwen.qwen3-coder-480b-a35b-v1:0)', () => {
  it('produces a working code snippet', async () => {
    const agent = new Agent({
      model: createBedrockModel({ modelId: QWEN3_CODER_480B }),
      systemPrompt: 'You are a coding assistant. Output only code, no prose.',
      tools: [],
      conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
    });

    await streamAll(
      agent,
      'Write a Python one-liner function add(a, b) that returns their sum. Just the function.'
    );

    const answer = textOf(agent.messages[1]);
    expect(answer).toMatch(/def\s+add\s*\(/);
  }, 120_000);
});
