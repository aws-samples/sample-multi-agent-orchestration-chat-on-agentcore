/**
 * Bedrock model registry — LIVE integration tests.
 *
 * These connect to the real Amazon Bedrock runtime and verify that every
 * Anthropic model in BEDROCK_MODEL_DEFINITIONS can actually be invoked via its
 * cross-region inference profile id. This is the executable form of the
 * "verify the inference profile id before merging" requirement: a model that
 * is in the registry but does not resolve (typo, not-yet-GA, wrong profile
 * prefix) fails CI here instead of in production.
 *
 * The suite is OPT-IN: it only runs when RUN_BEDROCK_MODEL_INTEGRATION=1.
 * Without the flag it is skipped so unit-test CI and restricted roles stay
 * green.
 *
 *   Requires:
 *     - AWS credentials with bedrock:InvokeModel on the Anthropic foundation models
 *     - BEDROCK_REGION pointed at a region where the models are enabled
 *
 *   NOTE (Fable 5 / Mythos-class data retention): claude-fable-5 can ONLY be
 *   invoked when the account's Bedrock Data Retention mode is set to
 *   `provider_data_share` in the invocation region. With the default mode the
 *   runtime rejects the request with:
 *     ValidationException: data retention mode 'default' is not available for this model
 *   See packages/libs/core/src/bedrock-models.ts for the registry note.
 *
 *   Run (us-west-2 has provider_data_share enabled and Fable 5 verified ACTIVE):
 *     cd packages/libs/core
 *     RUN_BEDROCK_MODEL_INTEGRATION=1 BEDROCK_REGION=us-west-2 \
 *       npm run test:integration
 */

import { describe, it, expect } from 'vitest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { BEDROCK_MODEL_DEFINITIONS, getModelRegion, getMaxOutputTokens } from '../bedrock-models.js';

const RUN = process.env.RUN_BEDROCK_MODEL_INTEGRATION === '1';
const describeLive = RUN ? describe : describe.skip;

if (!RUN) {
  console.log(
    '⏭️  Skipping Bedrock model live integration tests: set RUN_BEDROCK_MODEL_INTEGRATION=1 to run'
  );
}

const DEFAULT_REGION = process.env.BEDROCK_REGION || 'us-west-2';

/** Extract concatenated text from a Converse response. */
function textOf(out: Awaited<ReturnType<BedrockRuntimeClient['send']>>): string {
  // ConverseCommandOutput shape: output.message.content[].text
  const msg = (out as { output?: { message?: { content?: Array<{ text?: string }> } } }).output
    ?.message;
  return (msg?.content ?? []).map((b) => b.text ?? '').join('');
}

/** Invoke a model with a trivial deterministic prompt via the Converse API. */
async function converse(modelId: string): Promise<string> {
  // Most models are invoked in BEDROCK_REGION; a registry region pin (e.g. for
  // In-Region-only models) overrides it. Mirrors createBedrockModel()'s
  // region-resolution order.
  const region = getModelRegion(modelId) || DEFAULT_REGION;
  const client = new BedrockRuntimeClient({
    region,
    // Mirror production wiring (createBedrockModel): Bedrock returns transient
    // ServiceUnavailableException under load, especially for a just-GA'd model
    // like Fable 5. Adaptive retries smooth those over so the test asserts the
    // model's behaviour, not Bedrock's momentary capacity.
    retryMode: 'adaptive',
    maxAttempts: 5,
  });
  const out = await client.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Reply with exactly one word: PONG' }] }],
      // Fable 5 (Mythos-class) has adaptive thinking always ON: it spends output
      // budget on internal reasoning before the visible answer. A tiny cap (e.g.
      // 16) truncates the reply to a single character. Give enough headroom that
      // the one-word answer always lands. Bedrock counts reasoning toward
      // maxTokens, so this stays well within every model's limit.
      inferenceConfig: { maxTokens: 1024 },
    })
  );
  return textOf(out);
}

const ANTHROPIC_MODELS = BEDROCK_MODEL_DEFINITIONS.filter((m) => m.provider === 'Anthropic');

describeLive('Bedrock model registry — live invocation', () => {
  it.each(ANTHROPIC_MODELS.map((m) => [m.id, m.name] as const))(
    'invokes %s (%s) and gets a non-empty response',
    async (modelId) => {
      const text = await converse(modelId);
      expect(text.length).toBeGreaterThan(0);
    },
    90_000
  );

  it('invokes Claude Fable 5 specifically and it follows a trivial instruction', async () => {
    const FABLE_5 = 'global.anthropic.claude-fable-5';
    // Fable 5 must be present in the registry as the new default (first entry).
    const entry = BEDROCK_MODEL_DEFINITIONS.find((m) => m.id === FABLE_5);
    expect(entry, 'claude-fable-5 must be registered in BEDROCK_MODEL_DEFINITIONS').toBeDefined();
    // Bedrock enforces a hard 128000 ceiling for Fable 5 (verified live);
    // the registry must not advertise more or every request fails.
    expect(getMaxOutputTokens(FABLE_5)).toBe(128000);

    const text = await converse(FABLE_5);
    expect(text.toUpperCase()).toContain('PONG');
  }, 90_000);
});
