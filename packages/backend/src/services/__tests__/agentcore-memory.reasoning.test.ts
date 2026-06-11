/**
 * convertToMessageContents — reasoningBlock handling.
 *
 * Reasoning blocks persisted to AgentCore Memory must render in the UI as a
 * reasoning DTO carrying only the human-readable text. The encrypted thinking
 * (redactedContentBase64) and the signature must NEVER reach the UI DTO.
 */

import { describe, it, expect, jest } from '@jest/globals';

// Mock `../config/index` before agentcore-memory imports it, otherwise the real
// config.ts evaluates its Zod schema against `process.env` and the suite fails
// to load on missing required vars (Cognito, memory, …) in CI. convertToMessageContents
// is pure and uses no config, but the module-level `config` import is enough to crash.
jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));

import { convertToMessageContents } from '../agentcore-memory';

// The function is typed against the module-internal BackendContentBlock; tests
// supply plain wire-shaped objects, so cast through a loose parameter type.
type Block = Parameters<typeof convertToMessageContents>[0][number];

describe('convertToMessageContents — reasoningBlock', () => {
  it('maps a reasoning block with text to a reasoning DTO (text only)', () => {
    const out = convertToMessageContents([
      { type: 'reasoningBlock', text: 'Let me think...', signature: 'sig' } as Block,
    ]);
    expect(out).toEqual([{ type: 'reasoning', reasoning: { text: 'Let me think...' } }]);
  });

  it('never leaks signature or redactedContentBase64 into the DTO', () => {
    const out = convertToMessageContents([
      {
        type: 'reasoningBlock',
        text: 'visible',
        signature: 'SECRET_SIG',
        redactedContentBase64: 'SECRET_REDACTED',
      } as Block,
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SECRET_SIG');
    expect(serialized).not.toContain('SECRET_REDACTED');
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('redacted');
  });

  it('drops a reasoning block with empty or absent text', () => {
    expect(
      convertToMessageContents([{ type: 'reasoningBlock', text: '' } as Block])
    ).toEqual([]);
    expect(
      convertToMessageContents([
        { type: 'reasoningBlock', redactedContentBase64: 'abc' } as Block,
      ])
    ).toEqual([]);
  });

  it('preserves a reasoning block in stream order alongside text', () => {
    const out = convertToMessageContents([
      { type: 'reasoningBlock', text: 'thinking' } as Block,
      { type: 'textBlock', text: 'answer' } as Block,
    ]);
    expect(out).toEqual([
      { type: 'reasoning', reasoning: { text: 'thinking' } },
      { type: 'text', text: 'answer' },
    ]);
  });
});
