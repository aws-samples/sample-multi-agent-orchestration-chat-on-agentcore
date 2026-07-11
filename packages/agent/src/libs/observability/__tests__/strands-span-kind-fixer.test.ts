/**
 * Unit tests for StrandsSpanKindFixer.
 *
 * Two adaptations, both gated to OUR invoke_agent spans (identified by the
 * `enduser.id` trace attribute that createAgent always stamps):
 *   1. onStart: promote INTERNAL → CLIENT so trace-level token aggregation works.
 *   2. onEnd:   project per-message events into gen_ai.prompt/completion (+ fallbacks).
 *
 * The GoalLoop judge Agent's own invoke_agent span carries NEITHER our trace
 * attributes NOR (relevantly) a session — so it must be left untouched, or its
 * tokens double-count the goal turn. These tests focus on that exclusion.
 */

import { describe, it, expect } from '@jest/globals';
import { SpanKind } from '@opentelemetry/api';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { StrandsSpanKindFixer } from '../strands-span-kind-fixer.js';

const OP = 'gen_ai.operation.name';
const MARKER = 'enduser.id';

/** Minimal mutable Span for onStart. */
function makeStartSpan(attributes: Record<string, unknown>): Span {
  return { kind: SpanKind.INTERNAL, attributes } as unknown as Span;
}

/** Minimal ReadableSpan for onEnd, with a user-message + choice event. */
function makeEndSpan(attributes: Record<string, unknown>): ReadableSpan {
  return {
    attributes,
    events: [
      {
        name: 'gen_ai.user.message',
        attributes: { content: JSON.stringify([{ type: 'textBlock', text: 'hi' }]) },
      },
      { name: 'gen_ai.choice', attributes: { message: 'hello' } },
    ],
  } as unknown as ReadableSpan;
}

describe('StrandsSpanKindFixer onStart', () => {
  const fixer = new StrandsSpanKindFixer();

  it('promotes our invoke_agent span (has enduser.id) INTERNAL → CLIENT', () => {
    const span = makeStartSpan({ [OP]: 'invoke_agent', [MARKER]: 'user-123' });
    fixer.onStart(span, {} as never);
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it('leaves the GoalLoop judge invoke_agent span (no enduser.id) as INTERNAL', () => {
    const span = makeStartSpan({ [OP]: 'invoke_agent' });
    fixer.onStart(span, {} as never);
    expect(span.kind).toBe(SpanKind.INTERNAL);
  });

  it('ignores non-agent spans', () => {
    const span = makeStartSpan({ [OP]: 'chat', [MARKER]: 'user-123' });
    fixer.onStart(span, {} as never);
    expect(span.kind).toBe(SpanKind.INTERNAL);
  });
});

describe('StrandsSpanKindFixer onEnd', () => {
  const fixer = new StrandsSpanKindFixer();

  it('writes prompt/completion attributes on our invoke_agent span', () => {
    const attrs: Record<string, unknown> = { [OP]: 'invoke_agent', [MARKER]: 'user-123' };
    fixer.onEnd(makeEndSpan(attrs));
    expect(attrs['gen_ai.prompt']).toBe('hi');
    expect(attrs['gen_ai.completion']).toBe('hello');
  });

  it('leaves the GoalLoop judge span (no enduser.id) untouched', () => {
    const attrs: Record<string, unknown> = { [OP]: 'invoke_agent' };
    fixer.onEnd(makeEndSpan(attrs));
    expect(attrs['gen_ai.prompt']).toBeUndefined();
    expect(attrs['gen_ai.completion']).toBeUndefined();
  });
});
