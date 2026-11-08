/**
 * Tests that verify the identity-preserving truncation placeholder shape
 * (option a from the review findings).
 *
 * For toolUse/toolResult/reasoning the placeholder keeps the identity/pairing
 * fields (id, name, toolUseId, isError) and replaces only the heavy payload
 * field with an empty value, plus adds a `truncated: { field, byteSize }`
 * marker. For other block types (text, image) the generic
 * `{ type:'truncated', … }` shape is preserved.
 */

import { describe, it, expect } from '@jest/globals';
import {
  BLOCK_TRUNCATE_THRESHOLD_BYTES,
  PAGE_BYTE_BUDGET_BYTES,
} from '../../libs/http/pagination';

// ---------- minimal inline harness (no full mock needed) ----------

import { jest } from '@jest/globals';

jest.mock('../../config/index', () => ({
  config: { AGENTCORE_MEMORY_ID: 'test-memory-id' },
}));
jest.mock('@aws-sdk/client-bedrock-agentcore', () => {
  const actual = jest.requireActual<typeof import('@aws-sdk/client-bedrock-agentcore')>(
    '@aws-sdk/client-bedrock-agentcore'
  );
  return {
    ...actual,
    BedrockAgentCoreClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
      config: {},
    })),
  };
});

import { AgentCoreMemoryService } from '../agentcore-memory';
import type { MessageContent } from '../memory/content-codec';

const MEMORY_ID = 'test-memory-id';
const SESSION_ID = 'SID00000000000000000000000000001';

/** Build a minimal BedrockAgentCoreClient whose send() returns the given response. */
const makeSinglePageClient = (events: unknown[]) => {
  const sendFn = jest.fn().mockResolvedValue({
    events,
    nextToken: undefined,
  });
  return { send: sendFn, config: {} } as unknown as ConstructorParameters<
    typeof AgentCoreMemoryService
  >[1];
};

/** Encode one content block into the wire blob the memory service expects. */
const makeBlob = (block: object): Buffer =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 'v2-strands-sdk-1',
      messageType: 'content',
      role: 'assistant',
      content: [block],
    }),
    'utf8'
  );

/** Build a single memory event with an arbitrary payload size. */
const makeEvent = (id: string, block: object, ts = new Date('2024-01-01T10:00:00Z')) => ({
  eventId: id,
  eventTimestamp: ts,
  payload: [{ blob: makeBlob(block) }],
});

/** A toolUse wire block with the input inflated to `payloadBytes`. */
const toolUseBlock = (id: string, name: string, payloadBytes: number) => ({
  type: 'toolUseBlock',
  toolUseId: id,
  name,
  input: { data: 'x'.repeat(payloadBytes) },
});

/** A toolResult wire block with content inflated to `payloadBytes`. */
const toolResultBlock = (toolUseId: string, payloadBytes: number, isError = false) => ({
  type: 'toolResultBlock',
  toolUseId,
  content: 'x'.repeat(payloadBytes),
  status: isError ? 'error' : undefined,
});

/** A reasoning wire block with text inflated to `payloadBytes`. */
const reasoningBlock = (payloadBytes: number) => ({
  type: 'reasoningBlock',
  text: 'x'.repeat(payloadBytes),
});

const OVER = BLOCK_TRUNCATE_THRESHOLD_BYTES + 50_000;

// ---------- tests ----------

describe('truncated placeholder — identity-preserving shape (option a)', () => {
  it('truncated toolUse preserves id and name, replaces input with {}', async () => {
    const block = toolUseBlock('tu-id-001', 'execute_command', OVER);
    const client = makeSinglePageClient([makeEvent('e1', block)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);
    const contents = page.events[0].contents;

    // Must NOT be the old generic { type:'truncated' } shape.
    expect(contents.find((c) => c.type === 'truncated')).toBeUndefined();

    // Must be a toolUse content block.
    const tc = contents.find((c) => c.type === 'toolUse') as Extract<
      MessageContent,
      { type: 'toolUse' }
    >;
    expect(tc).toBeDefined();
    expect(tc.toolUse.id).toBe('tu-id-001');
    expect(tc.toolUse.name).toBe('execute_command');
    // Heavy payload replaced with empty object.
    expect(tc.toolUse.input).toEqual({});

    // Truncation marker present.
    expect(tc.truncated).toBeDefined();
    expect(tc.truncated!.field).toBe('input');
    expect(tc.truncated!.byteSize).toBeGreaterThan(BLOCK_TRUNCATE_THRESHOLD_BYTES);
  });

  it('truncated toolResult preserves toolUseId and isError, replaces content with ""', async () => {
    const block = toolResultBlock('tu-id-002', OVER, true);
    const client = makeSinglePageClient([makeEvent('e2', block)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);
    const contents = page.events[0].contents;

    expect(contents.find((c) => c.type === 'truncated')).toBeUndefined();

    const tc = contents.find((c) => c.type === 'toolResult') as Extract<
      MessageContent,
      { type: 'toolResult' }
    >;
    expect(tc).toBeDefined();
    expect(tc.toolResult.toolUseId).toBe('tu-id-002');
    expect(tc.toolResult.isError).toBe(true);
    expect(tc.toolResult.content).toBe('');

    expect(tc.truncated).toBeDefined();
    expect(tc.truncated!.field).toBe('content');
    expect(tc.truncated!.byteSize).toBeGreaterThan(BLOCK_TRUNCATE_THRESHOLD_BYTES);
  });

  it('truncated reasoning preserves type:reasoning with text:"", adds marker', async () => {
    const block = reasoningBlock(OVER);
    const client = makeSinglePageClient([makeEvent('e3', block)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);
    const contents = page.events[0].contents;

    expect(contents.find((c) => c.type === 'truncated')).toBeUndefined();

    const tc = contents.find((c) => c.type === 'reasoning') as Extract<
      MessageContent,
      { type: 'reasoning' }
    >;
    expect(tc).toBeDefined();
    expect(tc.reasoning.text).toBe('');

    expect(tc.truncated).toBeDefined();
    expect(tc.truncated!.field).toBe('text');
    expect(tc.truncated!.byteSize).toBeGreaterThan(BLOCK_TRUNCATE_THRESHOLD_BYTES);
  });

  it('byte accounting uses post-truncation size (page stays within budget)', async () => {
    const block = toolUseBlock('tu-id-003', 'big_tool', OVER);
    const client = makeSinglePageClient([makeEvent('e4', block)]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);
    const pageBytes = Buffer.byteLength(JSON.stringify(page.events), 'utf8');
    expect(pageBytes).toBeLessThanOrEqual(PAGE_BYTE_BUDGET_BYTES);
  });

  it('a paired toolUse+toolResult where toolUse is truncated still links via toolUseId', async () => {
    // Both blocks in one event so the merge logic sees them together.
    const tuBlock = toolUseBlock('tu-id-004', 'search', OVER);
    const trBlock = { type: 'toolResultBlock', toolUseId: 'tu-id-004', content: 'result' };
    const event = {
      eventId: 'e5',
      eventTimestamp: new Date('2024-01-01T10:00:00Z'),
      payload: [
        {
          blob: Buffer.from(
            JSON.stringify({
              schemaVersion: 'v2-strands-sdk-1',
              messageType: 'content',
              role: 'assistant',
              content: [tuBlock, trBlock],
            }),
            'utf8'
          ),
        },
      ],
    };

    const client = makeSinglePageClient([event]);
    const svc = new AgentCoreMemoryService(MEMORY_ID, client);

    const page = await svc.getSessionEventsPage('actor1', SESSION_ID);
    const contents = page.events[0].contents;

    const tu = contents.find((c) => c.type === 'toolUse') as Extract<
      MessageContent,
      { type: 'toolUse' }
    >;
    const tr = contents.find((c) => c.type === 'toolResult') as Extract<
      MessageContent,
      { type: 'toolResult' }
    >;

    expect(tu.toolUse.id).toBe('tu-id-004');
    expect(tu.truncated).toBeDefined();
    expect(tr.toolResult.toolUseId).toBe('tu-id-004');
    expect(tr.truncated).toBeUndefined(); // result is small, not truncated
  });
});
