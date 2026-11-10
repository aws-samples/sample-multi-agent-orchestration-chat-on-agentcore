import { describe, it, expect } from 'vitest';
import { extractSessionWorkflowIds, parseStartedWorkflowId } from '../session-workflows';
import type { Message } from '../../types/index';

const WF1 = 'wf-01a1c5fd-fbe4-7719-8d8e-24e7004f5495';
const WF2 = 'wf-01a1c600-0000-7000-8000-000000000000';

const msg = (contents: Message['contents']): Message => ({
  id: Math.random().toString(36),
  type: 'assistant',
  contents,
  timestamp: new Date(),
});
const use = (id: string, input: Record<string, unknown>, name = 'run_workflow') => ({
  type: 'toolUse' as const,
  toolUse: { id, name, input },
});
const result = (toolUseId: string, body: unknown) => ({
  type: 'toolResult' as const,
  toolResult: { toolUseId, content: JSON.stringify(body) },
});

describe('extractSessionWorkflowIds', () => {
  it('collects ids from successful start results, oldest first and once each', () => {
    const messages = [
      msg([use('t1', { action: 'start', workflow: {} })]),
      msg([result('t1', { success: true, workflowId: WF1, status: 'pending' })]),
      msg([
        use('t2', { action: 'start', workflow: {} }, 'gateway___run_workflow'),
        result('t2', { success: true, workflowId: WF2 }),
      ]),
      // status / list results mention ids but did not start anything here.
      msg([
        use('t3', { action: 'status', workflowId: WF1 }),
        result('t3', { success: true, workflowId: WF1 }),
      ]),
    ];
    expect(extractSessionWorkflowIds(messages)).toEqual([WF1, WF2]);
  });

  it('pairs results with the streamed tool use via originalToolUseId', () => {
    const messages = [
      msg([
        {
          type: 'toolUse',
          toolUse: {
            id: 'local-1',
            originalToolUseId: 'tooluse_x',
            name: 'run_workflow',
            input: { action: 'start' },
          },
        },
      ]),
      msg([result('tooluse_x', { success: true, workflowId: WF1 })]),
    ];
    expect(extractSessionWorkflowIds(messages)).toEqual([WF1]);
  });

  it('ignores failed starts, other tools and malformed results', () => {
    const messages = [
      msg([
        use('a', { action: 'start' }),
        result('a', { success: false, error: 'Invalid workflow' }),
      ]),
      msg([
        use('b', { action: 'start' }, 'call_agent'),
        result('b', { success: true, workflowId: WF1 }),
      ]),
      msg([
        use('c', { action: 'start' }),
        { type: 'toolResult', toolResult: { toolUseId: 'c', content: 'not json' } },
      ]),
    ];
    expect(extractSessionWorkflowIds(messages)).toEqual([]);
  });
});

describe('parseStartedWorkflowId', () => {
  it('reads results restored from history as content blocks', () => {
    const inner = JSON.stringify({ success: true, workflowId: WF1, status: 'pending' });
    expect(parseStartedWorkflowId(JSON.stringify([{ text: inner }]))).toBe(WF1);
    expect(
      parseStartedWorkflowId(JSON.stringify([{ json: { success: true, workflowId: WF2 } }]))
    ).toBe(WF2);
  });

  it('rejects ids that do not look like workflow ids', () => {
    expect(
      parseStartedWorkflowId(JSON.stringify({ success: true, workflowId: '../x' }))
    ).toBeNull();
    expect(parseStartedWorkflowId(undefined)).toBeNull();
  });
});
