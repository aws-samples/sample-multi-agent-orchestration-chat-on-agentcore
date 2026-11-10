import { describe, it, expect } from 'vitest';
import { countDoneSteps, formatWorkflowDuration, pickDefaultStep } from '../workflow-status';
import type { WorkflowStepView, WorkflowView } from '../../types/workflow';

const step = (stepId: string, status: WorkflowStepView['status']): WorkflowStepView => ({
  stepId,
  status,
  runs: 1,
  iteration: 0,
  updatedAt: '2026-11-10T00:00:00Z',
});
const workflow = (steps: WorkflowStepView[]): WorkflowView => ({
  workflowId: 'wf-1',
  status: 'running',
  spec: { goal: 'g', steps: steps.map((s) => ({ id: s.stepId, agentId: 'a', prompt: 'p' })) },
  createdAt: '2026-11-10T00:00:00Z',
  updatedAt: '2026-11-10T00:00:00Z',
  steps,
});

describe('workflow-status', () => {
  it('prefers the active step, then a failed one, then the last step', () => {
    expect(
      pickDefaultStep(workflow([step('a', 'done'), step('b', 'reviewing'), step('c', 'pending')]))
    ).toBe('b');
    expect(pickDefaultStep(workflow([step('a', 'failed'), step('b', 'skipped')]))).toBe('a');
    expect(pickDefaultStep(workflow([step('a', 'done'), step('b', 'done')]))).toBe('b');
  });

  it('counts only done steps', () => {
    expect(
      countDoneSteps(workflow([step('a', 'done'), step('b', 'skipped'), step('c', 'running')]))
    ).toBe(1);
  });

  it('formats durations in minutes and hours', () => {
    const t = (key: string, o?: Record<string, unknown>) =>
      `${key.split('.').pop()}${o ? JSON.stringify(o) : ''}`;
    expect(formatWorkflowDuration(30_000, t)).toBe('lessThanMinute');
    expect(formatWorkflowDuration(22 * 60_000, t)).toBe('minutes{"m":22}');
    expect(formatWorkflowDuration(125 * 60_000, t)).toBe('hours{"h":2,"m":5}');
  });
});
