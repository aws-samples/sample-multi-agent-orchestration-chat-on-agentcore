import { describe, it, expect } from 'vitest';
import type { Message, MessageContent } from '../../types/index';
import {
  buildSegments,
  mergeToolTurnMessages,
  stepSummary,
  summarizeSteps,
  toolBaseName,
  type Step,
  type ToolStep,
} from '../tool-steps';

const text = (t: string): MessageContent => ({ type: 'text', text: t });
const use = (id: string, name: string, input: Record<string, unknown> = {}): MessageContent => ({
  type: 'toolUse',
  toolUse: { id, name, input, status: 'completed' },
});
const result = (id: string, content = 'ok', isError = false): MessageContent => ({
  type: 'toolResult',
  toolResult: { toolUseId: id, content, isError },
});
const reasoning = (t: string): MessageContent => ({ type: 'reasoning', reasoning: { text: t } });
const msg = (
  id: string,
  type: Message['type'],
  contents: MessageContent[],
  extra = {}
): Message => ({
  id,
  type,
  contents,
  timestamp: new Date(0),
  ...extra,
});

const UI_SPEC = JSON.stringify({ root: 'r', elements: { r: { type: 'Text', props: {} } } });

describe('mergeToolTurnMessages', () => {
  it('folds a history tool round-trip (assistant → user toolResult → assistant) into one message', () => {
    const merged = mergeToolTurnMessages([
      msg('u1', 'user', [text('question')]),
      msg('a1', 'assistant', [use('t1', 'browser')]),
      msg('u2', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('answer')]),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1].contents.map((c) => c.type)).toEqual(['toolUse', 'toolResult', 'text']);
  });

  it('does not merge adjacent assistant messages that are not continuing a tool turn', () => {
    const merged = mergeToolTurnMessages([
      msg('a1', 'assistant', [text('first')]),
      msg('a2', 'assistant', [text('second')]),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['a1', 'a2']);
  });

  it('keeps a real user message (text + toolResult mix is not tool-only) as its own message', () => {
    const merged = mergeToolTurnMessages([
      msg('a1', 'assistant', [use('t1', 'browser')]),
      msg('u1', 'user', [text('stop'), result('t1')]),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('takes streaming/error flags from the merged tail', () => {
    const merged = mergeToolTurnMessages([
      msg('a1', 'assistant', [use('t1', 'browser')], { isError: true }),
      msg('u1', 'user', [result('t1')]),
      msg('a2', 'assistant', [text('…')], { isStreaming: true }),
    ]);
    expect(merged[0]).toMatchObject({ id: 'a1', isStreaming: true, isError: true });
  });
});

describe('buildSegments', () => {
  it('groups consecutive reasoning and tool calls between text blocks', () => {
    const segs = buildSegments(
      [
        reasoning('plan'),
        use('t1', 'tavily_search', { query: 'a' }),
        result('t1'),
        use('t2', 'browser'),
        result('t2'),
        text('interim'),
        use('t3', 'code_interpreter'),
        result('t3'),
        text('final'),
      ],
      false
    );
    expect(segs.map((s) => s.type)).toEqual(['steps', 'text', 'steps', 'text']);
    const first = segs[0];
    expect(first.type === 'steps' && first.steps.map((s) => s.kind)).toEqual([
      'reasoning',
      'tool',
      'tool',
    ]);
  });

  it('attaches results to their toolUse, matching originalToolUseId too, and derives error from isError', () => {
    const segs = buildSegments(
      [
        {
          type: 'toolUse',
          toolUse: {
            id: 'local-1',
            originalToolUseId: 'remote-1',
            name: 'browser',
            input: {},
            status: 'completed',
          },
        },
        result('remote-1', 'boom', true),
      ],
      false
    );
    expect(segs).toHaveLength(1);
    const step = segs[0].type === 'steps' ? (segs[0].steps[0] as ToolStep) : null;
    expect(step).toMatchObject({ status: 'error', result: { content: 'boom' } });
  });

  it('marks a call without a result as running while streaming and incomplete afterwards', () => {
    const status = (streaming: boolean) => {
      const s = buildSegments([use('t1', 'browser')], streaming)[0];
      return s.type === 'steps' ? s.steps[0].status : null;
    };
    expect(status(true)).toBe('running');
    expect(status(false)).toBe('incomplete');
  });

  it('marks only the trailing reasoning of a streaming turn as running', () => {
    const segs = buildSegments(
      [reasoning('a'), use('t1', 'browser'), result('t1'), reasoning('b')],
      true
    );
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    expect(steps.map((s) => s.status)).toEqual(['completed', 'completed', 'running']);
  });

  it('pulls generative UI out of the group so the artifact is never folded away', () => {
    const segs = buildSegments(
      [
        use('t1', 'browser'),
        result('t1'),
        use('t2', 'generate_ui'),
        result('t2', UI_SPEC),
        text('done'),
      ],
      false
    );
    expect(segs.map((s) => s.type)).toEqual(['steps', 'ui', 'text']);
    const steps = segs[0].type === 'steps' ? segs[0].steps : [];
    expect(steps.map((s) => s.status)).toEqual(['completed', 'completed']);
  });

  it('does not split a group on whitespace-only text', () => {
    const segs = buildSegments(
      [use('t1', 'browser'), result('t1'), text('\n'), use('t2', 'browser')],
      false
    );
    expect(segs.map((s) => s.type)).toEqual(['steps']);
  });

  it('keeps an orphan toolResult visible as a step', () => {
    const segs = buildSegments([result('missing', 'data')], false);
    expect(segs[0].type === 'steps' && segs[0].steps[0]).toMatchObject({
      kind: 'tool',
      status: 'completed',
    });
  });
});

describe('summarizeSteps', () => {
  const tool = (name: string, status: ToolStep['status']): Step => ({
    kind: 'tool',
    key: `${name}-${status}-${Math.random()}`,
    name,
    input: {},
    status,
  });

  it('counts an error followed by a successful call of the same tool as recovered, not failed', () => {
    expect(
      summarizeSteps([
        tool('browser', 'error'),
        tool('search', 'completed'),
        tool('browser', 'completed'),
      ])
    ).toEqual({ failed: 0, recovered: 1 });
  });

  it('counts an error with no later success of that tool as failed', () => {
    expect(summarizeSteps([tool('browser', 'completed'), tool('browser', 'error')])).toEqual({
      failed: 1,
      recovered: 0,
    });
  });
});

describe('stepSummary / toolBaseName', () => {
  it('prefers the path over file_editor’s command verb', () => {
    const s: Step = {
      kind: 'tool',
      key: 'k',
      name: 'file_editor',
      input: { command: 'view', path: '/a.ts' },
      status: 'completed',
    };
    expect(stepSummary(s)).toBe('/a.ts');
  });

  it('uses the first line of reasoning text', () => {
    expect(
      stepSummary({ kind: 'reasoning', key: 'k', text: '\nfirst\nsecond', status: 'completed' })
    ).toBe('first');
  });

  it('strips the gateway target prefix', () => {
    expect(toolBaseName('tavily-tools___tavily_search')).toBe('tavily_search');
    expect(toolBaseName('browser')).toBe('browser');
  });
});
