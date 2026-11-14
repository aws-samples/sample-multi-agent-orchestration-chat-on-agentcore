/**
 * view_image — Integration Tests (real Bedrock calls)
 *
 * Proves the one thing unit tests cannot: that the model actually receives the
 * pixels. Each model is asked a question it can only answer by seeing an image
 * that `view_image` returned in a tool result. A model that cannot take an
 * image there fails the Converse call with a ValidationException instead.
 *
 * The models listed here are the ones `supportsToolResultImages()` allows;
 * run this suite before adding a provider to that rule.
 *
 * Requirements:
 *   - AWS credentials with `bedrock:InvokeModel` +
 *     `bedrock:InvokeModelWithResponseStream` on the models below.
 *   - Model access granted for them in BEDROCK_REGION.
 *
 * The suite is OPT-IN: set RUN_BEDROCK_VIEW_IMAGE_INTEGRATION=1 to run it.
 *
 * Run:
 *   cd packages/agent
 *   RUN_BEDROCK_VIEW_IMAGE_INTEGRATION=1 BEDROCK_REGION=ap-northeast-1 \
 *     npm run test:integration -- view-image.integration
 */

import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import type { UserId } from '@moca/core';
import { createBedrockModel } from '../../../../config/bedrock.js';
import { createRequestContext, runWithContext } from '../../../../libs/context/request-context.js';
import { describeIfEnv } from '../../../../tests/integration-helpers.js';
import { viewImageTool } from '../tool.js';

const describeViewImage = describeIfEnv(
  ['RUN_BEDROCK_VIEW_IMAGE_INTEGRATION'],
  'view_image integration'
);

let dir: string;
let imagePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'view-image-it-'));
  imagePath = join(dir, 'swatch.png');
  // Larger than the edge limit, so the downscale path is what the model sees.
  await writeFile(
    imagePath,
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#00a000' } })
      .png()
      .toBuffer()
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter((b) => (b as { type: string }).type === 'textBlock')
    .map((b) => (b as { text?: string }).text || '')
    .join('');
}

for (const [label, modelId] of [
  ['Claude Haiku 5.5', 'global.anthropic.claude-haiku-5-5'],
  ['Nova 2 Lite', 'global.amazon.nova-2-lite-v1:0'],
] as const) {
  describeViewImage(`${label} (${modelId})`, () => {
    it('answers from the pixels of an image returned by view_image', async () => {
      const agent = new Agent({
        model: createBedrockModel({ modelId }),
        systemPrompt: 'Use the view_image tool to look at images. Be very brief.',
        tools: [viewImageTool],
        conversationManager: new SlidingWindowConversationManager({ windowSize: 20 }),
      });

      await runWithContext({ ...createRequestContext(), userId: 'it-user' as UserId }, async () => {
        for await (const event of agent.stream(
          `What single colour fills the image at ${imagePath}? Answer with one lowercase word.`
        )) {
          void event;
        }
      });

      const toolResults = agent.messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'toolResultBlock');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].status).toBe('success');
      expect(textOf(agent.messages[agent.messages.length - 1]).toLowerCase()).toContain('green');
    }, 120_000);
  });
}
