/**
 * Monthly token limits — end-to-end against real Bedrock.
 *
 * A real Strands Agent (Bedrock model, real tool calls, real streaming and
 * prompt caching) runs with TokenLimitHook + TurnBudgetHook, metering against
 * an in-process fake of the Backend's /usage API. The fake applies the same
 * @moca/core limit logic as the Backend, so these tests observe what actually
 * reaches the Backend and how the turn behaves around the limit.
 *
 * Opt-in (calls Bedrock, a few cents per run):
 *   cd packages/agent
 *   RUN_BEDROCK_TOKEN_LIMIT_INTEGRATION=1 npm run test:integration -- token-limits
 * Add RUN_BEDROCK_OPENAI_INTEGRATION=1 for the gpt-oss (OpenAI-compatible) case.
 */

import { afterAll, beforeAll, beforeEach, expect, it, jest } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  modelUsageKey,
  usageMonthResetsAt,
  usageStatus,
  type ModelUsage,
  type UsageSummary,
} from '@moca/core';
import { describeIfEnv } from '../../../tests/integration-helpers.js';

jest.setTimeout(240_000);

const HAIKU = 'global.anthropic.claude-haiku-5-5';
const SONNET = 'global.anthropic.claude-sonnet-4-6';
const GPT_OSS = 'openai.gpt-oss-120b-1:0';
const GPT_5_5 = 'openai.gpt-5.5';
const SONNET_5_5 = 'global.anthropic.claude-sonnet-5-5';
const OPUS_5_5 = 'global.anthropic.claude-opus-5-5';
const USER = '11111111-2222-4333-8444-555555555555';

// ─── Fake Backend /usage ────────────────────────────────────────────────────

interface Row {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  calls: number;
}
interface FakeBackend {
  rows: Map<string, Row>;
  limits: Map<string, { input: number | null; output: number | null }>;
  /** Force a status for an endpoint (e.g. 401, 429, 500); `once` resets after one use. */
  fail: { me?: number; records?: number; recordsOnce?: number };
  /** Apply the next records POST, but answer only after this many ms (client timeout is 5 s). */
  slowRecordsOnceMs?: number;
  batches: Set<string>;
  posts: { records: number; at: number }[];
  gets: number;
}
const backend: FakeBackend = {
  rows: new Map(),
  limits: new Map(),
  fail: {},
  posts: [],
  gets: 0,
  batches: new Set(),
};

const inputOf = (r: Row) =>
  r.uncachedInputTokens + r.cacheReadInputTokens + r.cacheWriteInputTokens;

function summary(): UsageSummary {
  const models: ModelUsage[] = [];
  for (const key of new Set([...backend.rows.keys(), ...backend.limits.keys()])) {
    const row = backend.rows.get(key);
    const lim = backend.limits.get(key) ?? { input: null, output: null };
    const input = { used: row ? inputOf(row) : 0, limit: lim.input };
    const output = { used: row?.outputTokens ?? 0, limit: lim.output };
    models.push({ modelKey: key, input, output, status: usageStatus(input, output) });
  }
  return {
    enabled: true,
    period: {
      month: '2026-11',
      timezone: 'Asia/Tokyo',
      resetsAt: usageMonthResetsAt('2999-11', 'Asia/Tokyo'),
    },
    groups: [],
    models,
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

let server: Server;

async function startBackend(): Promise<string> {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/usage/me' && req.method === 'GET') {
      backend.gets++;
      if (backend.fail.me) return res.writeHead(backend.fail.me).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(summary()));
    }
    if (req.url === '/usage/records' && req.method === 'POST') {
      const status = backend.fail.recordsOnce ?? backend.fail.records;
      backend.fail.recordsOnce = undefined;
      if (status) return res.writeHead(status).end();
      const { batchId, records } = JSON.parse(body) as {
        batchId: string;
        records: (Row & { modelId: string })[];
      };
      backend.posts.push({ records: records.length, at: Date.now() });
      // Same contract as the Backend: a batch is applied at most once.
      if (backend.batches.has(batchId)) return res.writeHead(204).end();
      backend.batches.add(batchId);
      const delay = backend.slowRecordsOnceMs;
      backend.slowRecordsOnceMs = undefined;
      for (const r of records) {
        const key = modelUsageKey(r.modelId);
        const row = backend.rows.get(key) ?? {
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          calls: 0,
        };
        row.uncachedInputTokens += r.uncachedInputTokens;
        row.cacheReadInputTokens += r.cacheReadInputTokens;
        row.cacheWriteInputTokens += r.cacheWriteInputTokens;
        row.outputTokens += r.outputTokens;
        row.calls += 1;
        backend.rows.set(key, row);
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The config module reads BACKEND_API_URL at import time, so the fake backend
// must be listening before anything that imports config is loaded.
process.env.BACKEND_API_URL = await startBackend();
process.env.TOKEN_LIMITS_ENABLED = 'true';

const { Agent, SlidingWindowConversationManager, tool } = await import('@strands-agents/sdk');
const { createBedrockModel } = await import('../../../config/bedrock.js');
const { runWithContext } = await import('../../../libs/context/request-context.js');
const {
  TokenLimitHook,
  GRACE_MAX_OUTPUT_TOKENS,
  REASONING_GRACE_MAX_OUTPUT_TOKENS,
  reasoningActive,
} = await import('../token-limit-hook.js');
const { TurnBudgetHook, MAIN_TURN_BUDGET, GRACE_MODEL_CALLS } =
  await import('../turn-budget-hook.js');
const { drainUsage } = await import('../../usage/usage-recorder.js');
const { clearSummaryCacheForTest } = await import('../../usage/usage-client.js');
const { normalizeUsage, totalInput } = await import('../../usage/normalize.js');

// ─── Harness ────────────────────────────────────────────────────────────────

const lookupCalls: string[] = [];
/** Order of tool runs and limit notices within a turn. */
const timeline: string[] = [];
const lookupTool = tool({
  name: 'lookup',
  description: 'Look up a fact about a city. Returns one short sentence.',
  inputSchema: z.object({ city: z.string() }),
  callback: async ({ city }) => {
    lookupCalls.push(city);
    timeline.push('lookup');
    return `${city} is a city. (fact #${lookupCalls.length})`;
  },
});

interface TurnObservation {
  text: string;
  /** SDK-reported usage per model call, as the Runtime normalizes it. */
  calls: ReturnType<typeof normalizeUsage>[];
  clientEvents: Record<string, unknown>[];
  toolResults: string[];
  error?: unknown;
}

function makeAgent(
  modelId: string,
  systemPrompt = 'Be brief. Follow instructions exactly.',
  reasoningEffort?: 'off' | 'low' | 'high' | 'max',
  maxTokens?: number
) {
  return new Agent({
    model: createBedrockModel({
      modelId,
      ...(reasoningEffort && { reasoningEffort }),
      ...(maxTokens && { maxTokens }),
    }),
    systemPrompt,
    tools: [lookupTool],
    plugins: [new TurnBudgetHook(MAIN_TURN_BUDGET), new TokenLimitHook(modelId)],
    conversationManager: new SlidingWindowConversationManager({ windowSize: 40 }),
    printer: false,
  });
}

async function runTurn(
  agent: InstanceType<typeof Agent>,
  modelId: string,
  prompt: string
): Promise<TurnObservation> {
  const obs: TurnObservation = { text: '', calls: [], clientEvents: [], toolResults: [] };
  const ctx = {
    requestId: `it-${Date.now()}`,
    startTime: new Date(),
    isMachineUser: false,
    userId: USER,
    authorizationHeader: 'Bearer integration-test',
    storagePath: '/',
    emitClientEvent: (e: Record<string, unknown>) => {
      obs.clientEvents.push(e);
      timeline.push(`event:${(e.warning as { code?: string })?.code ?? e.type}`);
    },
  } as never;
  await runWithContext(ctx, async () => {
    try {
      for await (const event of agent.stream(prompt)) {
        const e = event as { type?: string; event?: { type?: string; usage?: object } };
        if (
          e.type === 'modelStreamUpdateEvent' &&
          e.event?.type === 'modelMetadataEvent' &&
          e.event.usage
        ) {
          obs.calls.push(normalizeUsage(modelId, e.event.usage));
        }
      }
    } catch (err) {
      obs.error = err;
    }
  });
  const last = agent.messages[agent.messages.length - 1];
  obs.text = last.content
    .filter((b) => b.type === 'textBlock')
    .map((b) => (b as { text: string }).text)
    .join('');
  for (const m of agent.messages) {
    for (const b of m.content) {
      if (b.type === 'toolResultBlock') {
        obs.toolResults.push(JSON.stringify((b as { content: unknown }).content));
      }
    }
  }
  await drainUsage(15_000);
  // One line per turn, for reading what the model and the hook actually did.
  process.stdout.write(
    `[observe] ${JSON.stringify({
      test: expect.getState().currentTestName,
      modelCalls: obs.calls.length,
      outputPerCall: obs.calls.map((c) => c.outputTokens),
      inputPerCall: obs.calls.map((c) => totalInput(c)),
      lookups: [...lookupCalls],
      events: obs.clientEvents.map((e) => (e.warning as { code?: string })?.code ?? e.type),
      refusedTools: obs.toolResults.filter((r) => r.includes('limit') || r.includes('Refused'))
        .length,
      reported: backend.rows.get(modelUsageKey(modelId)) ?? null,
      text: obs.text.slice(0, 160),
      error: obs.error ? String(obs.error) : undefined,
    })}\n`
  );
  return obs;
}

const reported = (modelId: string) => backend.rows.get(modelUsageKey(modelId));
const sum = (calls: TurnObservation['calls']) =>
  calls.reduce(
    (a, c) => ({
      input: a.input + totalInput(c),
      output: a.output + c.outputTokens,
      cacheRead: a.cacheRead + c.cacheReadInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0 }
  );
const warnings = (o: TurnObservation, code: string) =>
  o.clientEvents.filter(
    (e) => e.type === 'serverWarningEvent' && (e.warning as { code?: string }).code === code
  );

/** The near-limit output cap the hook applies to this agent's calls. */
const capFor = (modelId: string, agent: InstanceType<typeof Agent>) => {
  const floor = reasoningActive(modelId, agent.model)
    ? REASONING_GRACE_MAX_OUTPUT_TOKENS
    : GRACE_MAX_OUTPUT_TOKENS;
  const configured = (agent.model.getConfig() as { maxTokens?: number }).maxTokens;
  return configured === undefined ? floor : Math.min(configured, floor);
};
/** Small configured maxTokens so the cap (min(configured, floor)) is always hit by a long answer. */
const SMALL_MAX_TOKENS = 1000;
/** Neutral system prompt for long-answer tests ("Be brief" makes models cut answers short). */
const NEUTRAL = "Follow the user's instructions fully.";
const LONG_ESSAY =
  'Write a 6000-word essay on the history of Rome, in full detail. Do not summarize or stop early.';

const SEQUENTIAL_LOOKUPS =
  'Call the lookup tool for each of these cities, ONE call per response, in this order: ' +
  'Paris, Rome, Oslo, Lima, Cairo, Delhi, Quito, Seoul. After all of them, reply "DONE".';

const describeBedrock = describeIfEnv(
  ['RUN_BEDROCK_TOKEN_LIMIT_INTEGRATION'],
  'token limits (real Bedrock)'
);

beforeEach(() => {
  backend.rows.clear();
  backend.limits.clear();
  backend.fail = {};
  backend.posts = [];
  backend.gets = 0;
  backend.batches.clear();
  backend.slowRecordsOnceMs = undefined;
  lookupCalls.length = 0;
  timeline.length = 0;
  clearSummaryCacheForTest();
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeAll(() => {
  // Keep logs readable: the agent's pino logger is noisy at info.
  process.env.LOG_LEVEL ??= 'warn';
});

describeBedrock('token limits with real Bedrock', () => {
  it('reports exactly what the model consumed, one record per model call', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    const agent = makeAgent(HAIKU);
    const o = await runTurn(
      agent,
      HAIKU,
      'Call lookup for Tokyo, then answer in one word: what did it say the city is?'
    );

    expect(o.error).toBeUndefined();
    expect(lookupCalls).toEqual(['Tokyo']);
    expect(o.calls.length).toBeGreaterThanOrEqual(2);
    const row = reported(HAIKU)!;
    const sdk = sum(o.calls);
    expect(row.calls).toBe(o.calls.length);
    expect(inputOf(row)).toBe(sdk.input);
    expect(row.outputTokens).toBe(sdk.output);
    expect(warnings(o, 'tokenLimitReached')).toHaveLength(0);
  });

  it('counts cache reads as input (Bedrock reports them outside inputTokens)', async () => {
    backend.limits.set(modelUsageKey(SONNET), { input: 10_000_000, output: 1_000_000 });
    // Long enough to be cached (Sonnet 4.6 caches prefixes of 1024+ tokens).
    const longPrompt = `Be brief.\n${'Reference: the quick brown fox jumps over the lazy dog. '.repeat(400)}`;
    const agent = makeAgent(SONNET, longPrompt);
    const first = await runTurn(agent, SONNET, 'Say OK.');
    const second = await runTurn(agent, SONNET, 'Say OK again.');

    const cacheRead = sum([...first.calls, ...second.calls]).cacheRead;
    expect(cacheRead).toBeGreaterThan(1000);
    const row = reported(SONNET)!;
    expect(row.cacheReadInputTokens).toBe(cacheRead);
    expect(inputOf(row)).toBe(sum([...first.calls, ...second.calls]).input);
    expect(inputOf(row)).toBeGreaterThan(row.uncachedInputTokens + 1000);
  });

  it('winds down a turn that crosses the limit and leaves a history Bedrock accepts', async () => {
    // Output is small per tool-calling response; a 250-token cap is crossed mid-loop.
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 250 });
    const agent = makeAgent(HAIKU);
    const configuredMax = (agent.model.getConfig() as { maxTokens?: number }).maxTokens;
    const o = await runTurn(agent, HAIKU, SEQUENTIAL_LOOKUPS);

    expect(o.error).toBeUndefined();
    // The grace cap is lifted again once the turn is over.
    expect((agent.model.getConfig() as { maxTokens?: number }).maxTokens).toBe(configuredMax);
    const reached = warnings(o, 'tokenLimitReached');
    expect(reached).toHaveLength(1);
    expect(reached[0].warning).toMatchObject({ dimension: 'output', limit: 250 });
    // Stopped well before finishing all eight lookups.
    expect(lookupCalls.length).toBeLessThan(8);
    // Model calls after exhaustion are bounded by the grace allowance.
    const exhaustedAt = o.calls.findIndex(
      (_c, i) => o.calls.slice(0, i).reduce((a, x) => a + x.outputTokens, 0) >= 250
    );
    expect(o.calls.length - exhaustedAt).toBeLessThanOrEqual(GRACE_MODEL_CALLS);
    // Everything the model consumed was reported, including after the limit.
    expect(reported(HAIKU)!.outputTokens).toBe(sum(o.calls).output);

    // The next turn on the same agent must replay this history without a
    // Bedrock ValidationException (toolUse/toolResult pairing, alternation).
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    clearSummaryCacheForTest();
    const next = await runTurn(agent, HAIKU, 'Reply with the single word OK.');
    expect(next.error).toBeUndefined();
    expect(next.text.toUpperCase()).toContain('OK');
  });

  it('bounds the overshoot: near the output limit every call is capped', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 200 });
    const agent = makeAgent(HAIKU);
    const o = await runTurn(
      agent,
      HAIKU,
      'Call lookup for Paris, then for Rome, one call per response. After that, write a detailed essay of about 1500 words on both cities.'
    );
    for (const c of o.calls) expect(c.outputTokens).toBeLessThanOrEqual(capFor(HAIKU, agent));
    // A ~1500-word essay (~2000 tokens) fits under the cap, so the turn still ends with an answer.
    expect(o.error).toBeUndefined();
    expect(o.text.length).toBeGreaterThan(200);
  });

  // Regression (observed): the capped call hit maxTokens and the SDK threw
  // MaxTokensError — the turn failed and the generated answer was lost.
  it('keeps an answer the cap cut off and ends the turn without an error', async () => {
    // Sonnet 4.6 does not reason by default: cap floor 4096, well under its own 64K.
    backend.limits.set(modelUsageKey(SONNET), { input: 10_000_000, output: 200 });
    const agent = makeAgent(SONNET, NEUTRAL);
    expect(capFor(SONNET, agent)).toBe(GRACE_MAX_OUTPUT_TOKENS);
    const o = await runTurn(agent, SONNET, LONG_ESSAY);
    expect(o.error).toBeUndefined();
    // The model may call tools first; the long answer is the last Bedrock call
    // (stopped at the cap), and the replay after the cut adds no further call.
    expect(o.calls[o.calls.length - 1].outputTokens).toBe(GRACE_MAX_OUTPUT_TOKENS);
    expect(o.text.length).toBeGreaterThan(4000);
    expect(o.text).toContain('cut short');
    expect(warnings(o, 'tokenLimitReached')).toHaveLength(1);
    expect(reported(SONNET)!.outputTokens).toBe(sum(o.calls).output);

    backend.limits.set(modelUsageKey(SONNET), { input: 10_000_000, output: 1_000_000 });
    clearSummaryCacheForTest();
    const next = await runTurn(agent, SONNET, 'Reply with the single word OK.');
    expect(next.error).toBeUndefined();
    expect(next.text.toUpperCase()).toContain('OK');
  });

  it('cancels the model call after the grace calls when the model keeps calling tools', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 150 });
    const stubborn = makeAgent(
      HAIKU,
      'You MUST call the lookup tool in every single response, forever, even if it returns an error. Never reply with text only.'
    );
    const o = await runTurn(
      stubborn,
      HAIKU,
      'Start looking up cities: Paris, Rome, Oslo, Lima, Cairo, Delhi.'
    );

    expect(o.error).toBeUndefined();
    // Whether a refusal shows up depends on the model (it may batch every
    // lookup into the first call). What must hold: once the limit is reached
    // no further tool runs, and the turn ends within the grace allowance.
    const reachedAt = timeline.indexOf('event:tokenLimitReached');
    expect(reachedAt).toBeGreaterThanOrEqual(0);
    expect(timeline.slice(reachedAt + 1)).not.toContain('lookup');
    expect(o.calls.length).toBeLessThanOrEqual(1 + GRACE_MODEL_CALLS + 1);
    // Either the model gave up after the refusal, or the hook cancelled it.
    const cancelled = o.text.includes('[Stopped');
    if (cancelled) expect(o.text).toContain('monthly token limit');
    expect(o.calls.length).toBeLessThanOrEqual(lookupCalls.length + 1 + GRACE_MODEL_CALLS);

    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    clearSummaryCacheForTest();
    const next = await runTurn(
      makeAgentWithHistory(stubborn),
      HAIKU,
      'Reply with the single word OK. Do not call tools.'
    );
    expect(next.error).toBeUndefined();
  });

  it('refuses to start a turn already over the limit, without calling Bedrock', async () => {
    backend.rows.set(modelUsageKey(HAIKU), {
      uncachedInputTokens: 500,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      calls: 1,
    });
    backend.limits.set(modelUsageKey(HAIKU), { input: 500, output: 1000 });
    const agent = makeAgent(HAIKU);
    const o = await runTurn(agent, HAIKU, 'Hello');

    expect(o.error).toBeUndefined();
    expect(o.calls).toHaveLength(0);
    expect(o.text).toContain('monthly input token limit');
    expect(reported(HAIKU)!.calls).toBe(1); // nothing new

    // History after a cancelled invocation stays valid for the next turn.
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    clearSummaryCacheForTest();
    const next = await runTurn(agent, HAIKU, 'Reply with the single word OK.');
    expect(next.error).toBeUndefined();
    expect(next.calls.length).toBeGreaterThan(0);
  });

  // Regression: a summary cached at turn 1's start used to let turn 2 (within
  // 60 s) start although turn 1 had already used up the limit.
  it('refuses the next turn right after one that used up the limit', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 40 });
    const agent = makeAgent(HAIKU);
    await runTurn(agent, HAIKU, 'Write two sentences about the sea.'); // well over 40 output tokens
    expect(reported(HAIKU)!.outputTokens).toBeGreaterThan(40);
    const second = await runTurn(agent, HAIKU, 'Write one more sentence.');
    expect(second.calls).toHaveLength(0);
    expect(second.text).toContain('monthly output token limit');
  });

  it('stops a turn once the Backend keeps rejecting the caller (401)', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    backend.fail = { me: 401, records: 401 };
    const agent = makeAgent(HAIKU);
    const o = await runTurn(agent, HAIKU, SEQUENTIAL_LOOKUPS);

    expect(o.error).toBeUndefined();
    expect(warnings(o, 'usageMeteringUnavailable')).toHaveLength(1);
    expect(lookupCalls.length).toBeLessThan(8);
  });

  it('fails open when the Backend is down (5xx): the turn completes', async () => {
    backend.fail = { me: 503, records: 503 };
    const agent = makeAgent(HAIKU);
    const o = await runTurn(agent, HAIKU, 'Call lookup for Paris and Rome, then reply DONE.');

    expect(o.error).toBeUndefined();
    expect(lookupCalls.sort()).toEqual(['Paris', 'Rome']);
    expect(o.clientEvents).toHaveLength(0);
  });

  // Regression: every call with an output limit counted as "capped", so a
  // model's own maxTokens stop far from the limit was reported as the limit.
  it('keeps a normal MaxTokensError when the stop is not caused by the limit', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 10_000_000 });
    const agent = makeAgent(HAIKU, NEUTRAL, 'off', SMALL_MAX_TOKENS);
    const o = await runTurn(agent, HAIKU, LONG_ESSAY);
    expect((o.error as Error | undefined)?.name).toBe('MaxTokensError');
    expect(warnings(o, 'tokenLimitReached')).toHaveLength(0);
    // The call was still metered.
    expect(reported(HAIKU)!.outputTokens).toBe(SMALL_MAX_TOKENS);
  });

  // Regression: a report applied by the Backend but answered after the
  // client's 5 s timeout was retried and counted again.
  it('does not double count when the Backend answers a report too late', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    backend.slowRecordsOnceMs = 6_000;
    const agent = makeAgent(HAIKU);
    const o = await runTurn(agent, HAIKU, 'Reply with the single word OK.');
    expect(backend.posts.length).toBeGreaterThanOrEqual(2); // the client retried
    expect(reported(HAIKU)!.outputTokens).toBe(sum(o.calls).output); // once
    expect(reported(HAIKU)!.calls).toBe(o.calls.length);
  });

  it('re-sends usage the Backend throttled (429) instead of losing it', async () => {
    backend.limits.set(modelUsageKey(HAIKU), { input: 10_000_000, output: 1_000_000 });
    backend.fail = { recordsOnce: 429 };
    const agent = makeAgent(HAIKU);
    const o = await runTurn(agent, HAIKU, 'Reply with the single word OK.');
    // The throttled batch is retried after THROTTLE_RETRY_MS (10 s).
    const deadline = Date.now() + 20_000;
    while (!reported(HAIKU) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    expect(reported(HAIKU)!.outputTokens).toBe(sum(o.calls).output);
  });
});

describeBedrock('token limits with reasoning models', () => {
  // Reasoning tokens count against maxTokens. Under the near-limit cap a model
  // that thinks long may spend it all on reasoning and return no answer text.
  it('observe: capped call with reasoning depth high', async () => {
    backend.limits.set(modelUsageKey(SONNET_5_5), { input: 10_000_000, output: 200 });
    const agent = makeAgent(SONNET_5_5, 'Think carefully before answering.', 'high');
    const o = await runTurn(
      agent,
      SONNET_5_5,
      'Prove that there are infinitely many primes, then write a 3000-word essay on the history of number theory.'
    );
    const reasoningChars = agent.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'reasoningBlock').length;
    process.stdout.write(
      `[observe-reasoning] ${JSON.stringify({ error: o.error ? String(o.error) : null, textLen: o.text.length, head: o.text.slice(0, 120), tail: o.text.slice(-160), calls: o.calls.map((c) => c.outputTokens), reasoningBlocks: reasoningChars, events: warnings(o, 'tokenLimitReached').length })}\n`
    );
    expect(o.error).toBeUndefined();
    for (const c of o.calls) expect(c.outputTokens).toBeLessThanOrEqual(capFor(SONNET_5_5, agent));
  });
});

const describeMantle = describeIfEnv(
  ['RUN_BEDROCK_TOKEN_LIMIT_INTEGRATION', 'RUN_BEDROCK_OPENAI_INTEGRATION'],
  'token limits on the Responses API'
);

describeBedrock('token limits with visible reasoning (Opus 5.5, max)', () => {
  it('observe: reasoning that consumes most of the capped budget', async () => {
    backend.limits.set(modelUsageKey(OPUS_5_5), { input: 10_000_000, output: 200 });
    const agent = makeAgent(OPUS_5_5, 'Think very thoroughly before answering.', 'max');
    const o = await runTurn(
      agent,
      OPUS_5_5,
      'Find all integer solutions of x^3 + y^3 + z^3 = 42 with |x|,|y|,|z| < 10^17, reasoning step by step, then write 60 numbered sections (250 words each) explaining your method.'
    );
    const blocks = agent.messages.flatMap((m) => m.content.map((b) => b.type));
    process.stdout.write(
      `[observe-opus] ${JSON.stringify({ error: o.error ? String(o.error) : null, textLen: o.text.length, tail: o.text.slice(-200), calls: o.calls.map((c) => c.outputTokens), blocks })}\n`
    );
    expect(o.error).toBeUndefined();
    for (const c of o.calls)
      expect(c.outputTokens).toBeLessThanOrEqual(REASONING_GRACE_MAX_OUTPUT_TOKENS);
    // Either an answer made it under the larger reasoning floor, or the note says why not.
    expect(
      o.text.replace(/\[Stopped:[^\]]*\]/, '').trim().length > 0 ||
        o.text.includes('before an answer was written')
    ).toBe(true);
  });
});

describeMantle('token limits on the Responses API (gpt-5.5, Mantle)', () => {
  it('observe: the cap reaches max_output_tokens and a cut-off answer is kept', async () => {
    backend.limits.set(modelUsageKey(GPT_5_5), { input: 10_000_000, output: 200 });
    const agent = makeAgent(GPT_5_5);
    const o = await runTurn(
      agent,
      GPT_5_5,
      'Write 60 numbered sections about the history of Rome, sections 1 through 60, each about 250 words. Write every section in full; never summarize, skip or stop early.'
    );
    process.stdout.write(
      `[observe-mantle] ${JSON.stringify({ error: o.error ? String(o.error) : null, textLen: o.text.length, tail: o.text.slice(-160), calls: o.calls, reported: reported(GPT_5_5) })}\n`
    );
    expect(o.error).toBeUndefined();
    for (const c of o.calls) expect(c.outputTokens).toBeLessThanOrEqual(capFor(GPT_5_5, agent));
    expect(reported(GPT_5_5)!.outputTokens).toBe(sum(o.calls).output);
  });
});

/** A new Agent instance that carries over another agent's message history. */
function makeAgentWithHistory(source: InstanceType<typeof Agent>) {
  const agent = makeAgent(HAIKU, 'Be brief. Follow instructions exactly.');
  agent.messages.push(...source.messages);
  return agent;
}

const describeOpenAI = describeIfEnv(
  ['RUN_BEDROCK_TOKEN_LIMIT_INTEGRATION', 'RUN_BEDROCK_OPENAI_INTEGRATION'],
  'token limits on OpenAI-compatible endpoints'
);

describeOpenAI('token limits on the OpenAI-compatible endpoint (gpt-oss)', () => {
  // gpt-oss declines very long answers on its own, so the cut itself cannot be
  // forced here; the replay path it would take is the same code as Converse's
  // (MaxTokensError from the shared model base), covered above with Sonnet.
  it('caps max_completion_tokens near the limit and meters exactly', async () => {
    backend.limits.set(modelUsageKey(GPT_OSS), { input: 10_000_000, output: 200 });
    const agent = makeAgent(GPT_OSS, NEUTRAL);
    expect(capFor(GPT_OSS, agent)).toBe(GRACE_MAX_OUTPUT_TOKENS);
    const o = await runTurn(agent, GPT_OSS, LONG_ESSAY);
    expect(o.error).toBeUndefined();
    for (const c of o.calls) expect(c.outputTokens).toBeLessThanOrEqual(GRACE_MAX_OUTPUT_TOKENS);
    expect(reported(GPT_OSS)!.outputTokens).toBe(sum(o.calls).output);
  });

  it('reports input without double-counting cached tokens', async () => {
    backend.limits.set(modelUsageKey(GPT_OSS), { input: 10_000_000, output: 1_000_000 });
    const agent = makeAgent(GPT_OSS);
    const o = await runTurn(agent, GPT_OSS, 'Reply with the single word OK.');
    expect(o.error).toBeUndefined();
    const row = reported(GPT_OSS)!;
    expect(inputOf(row)).toBe(sum(o.calls).input);
    for (const c of o.calls) expect(c.uncachedInputTokens).toBeGreaterThanOrEqual(0);
  });
});
