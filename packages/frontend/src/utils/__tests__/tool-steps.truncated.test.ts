/**
 * buildSegments — truncated-content cases (review finding #1 and #2).
 *
 * After the fix:
 * - A content block with type:'toolUse' + truncated marker → ToolStep with
 *   the correct name/id and a truncated property, NOT an 'unknown' segment.
 * - A content block with type:'toolResult' + truncated marker → attaches to
 *   the owning ToolStep (pairing preserved via toolUseId).
 * - A content block with type:'reasoning' + truncated marker → ReasoningStep
 *   with a truncated property.
 * - The old generic { type:'truncated' } shape → 'truncated' segment (not
 *   'unknown'), carrying originalType and byteSize.
 * - No 'unknown' segment appears for any of the above cases.
 */

import { describe, it, expect } from 'vitest';
import type { MessageContent } from '../../types/index';
import { buildSegments } from '../tool-steps';
import type { ToolStep, ReasoningStep } from '../tool-steps';

// ---------- helpers ----------

const truncatedToolUse = (
  id: string,
  name: string,
  byteSize = 300_000
): MessageContent => ({
  type: 'toolUse',
  toolUse: { id, name, input: {}, status: 'completed' },
  truncated: { field: 'input', byteSize },
});

const truncatedToolResult = (
  toolUseId: string,
  byteSize = 300_000
): MessageContent => ({
  type: 'toolResult',
  toolResult: { toolUseId, content: '', isError: false },
  truncated: { field: 'content', byteSize },
});

const truncatedReasoning = (byteSize = 300_000): MessageContent => ({
  type: 'reasoning',
  reasoning: { text: '' },
  truncated: { field: 'text', byteSize },
});

const genericTruncated = (originalType: string, byteSize = 300_000): MessageContent => ({
  type: 'truncated',
  truncated: { originalType, byteSize } as unknown as { field: string; byteSize: number },
});

// ---------- tests ----------

describe('buildSegments — truncated toolUse', () => {
  it('produces a steps segment (not unknown) for a truncated toolUse block', () => {
    const segs = buildSegments([truncatedToolUse('t1', 'execute_command')], false);
    expect(segs.find((s) => s.type === 'unknown')).toBeUndefined();
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('steps');
  });

  it('ToolStep has the correct name from the truncated toolUse', () => {
    const segs = buildSegments([truncatedToolUse('t1', 'execute_command')], false);
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    const step = steps[0] as ToolStep;
    expect(step.kind).toBe('tool');
    expect(step.name).toBe('execute_command');
  });

  it('ToolStep carries the truncated marker', () => {
    const segs = buildSegments([truncatedToolUse('t1', 'execute_command', 350_000)], false);
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    const step = steps[0] as ToolStep;
    expect(step.truncated).toBeDefined();
    expect(step.truncated!.field).toBe('input');
    expect(step.truncated!.byteSize).toBe(350_000);
  });
});

describe('buildSegments — truncated toolResult', () => {
  it('attaches a truncated toolResult to the owning toolUse step (pairing preserved)', () => {
    const segs = buildSegments(
      [
        truncatedToolUse('t2', 'search'),
        truncatedToolResult('t2', 280_000),
      ],
      false
    );
    expect(segs.find((s) => s.type === 'unknown')).toBeUndefined();
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    expect(steps).toHaveLength(1); // still one merged step
    const step = steps[0] as ToolStep;
    expect(step.name).toBe('search');
    // result attached
    expect(step.result).toBeDefined();
    expect(step.result!.toolUseId).toBe('t2');
    // truncation on the result side
    expect(step.resultTruncated).toBeDefined();
    expect(step.resultTruncated!.field).toBe('content');
    expect(step.resultTruncated!.byteSize).toBe(280_000);
  });

  it('orphan truncated toolResult (no owning toolUse) stays visible as a step', () => {
    const segs = buildSegments([truncatedToolResult('missing', 290_000)], false);
    expect(segs.find((s) => s.type === 'unknown')).toBeUndefined();
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    expect(steps).toHaveLength(1);
    const step = steps[0] as ToolStep;
    expect(step.kind).toBe('tool');
    expect(step.resultTruncated).toBeDefined();
  });
});

describe('buildSegments — truncated reasoning', () => {
  it('produces a steps segment (not unknown) for a truncated reasoning block', () => {
    const segs = buildSegments([truncatedReasoning()], false);
    expect(segs.find((s) => s.type === 'unknown')).toBeUndefined();
    expect(segs[0].type).toBe('steps');
  });

  it('ReasoningStep carries the truncated marker', () => {
    const segs = buildSegments([truncatedReasoning(400_000)], false);
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    const step = steps[0] as ReasoningStep;
    expect(step.kind).toBe('reasoning');
    expect(step.truncated).toBeDefined();
    expect(step.truncated!.field).toBe('text');
    expect(step.truncated!.byteSize).toBe(400_000);
  });
});

describe('buildSegments — generic truncated block (text/image overflow)', () => {
  it('produces a truncated segment (not unknown) for the old generic { type:"truncated" } shape', () => {
    const segs = buildSegments([genericTruncated('text', 5_000_000)], false);
    expect(segs.find((s) => s.type === 'unknown')).toBeUndefined();
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('truncated');
  });

  it('truncated segment carries originalType and byteSize', () => {
    const segs = buildSegments([genericTruncated('image', 2_000_000)], false);
    const seg = segs[0];
    expect(seg.type === 'truncated' && seg.originalType).toBe('image');
    expect(seg.type === 'truncated' && seg.byteSize).toBe(2_000_000);
  });
});

describe('buildSegments — mixed truncated and normal blocks in one turn', () => {
  it('a normal toolUse followed by a truncated toolResult still produces one step', () => {
    const segs = buildSegments(
      [
        { type: 'toolUse', toolUse: { id: 't3', name: 'browser', input: { url: 'x' }, status: 'completed' as const } },
        truncatedToolResult('t3', 310_000),
      ],
      false
    );
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    expect(steps).toHaveLength(1);
    const step = steps[0] as ToolStep;
    expect(step.name).toBe('browser');
    expect(step.resultTruncated).toBeDefined();
    expect(step.truncated).toBeUndefined(); // input not truncated
  });
});
