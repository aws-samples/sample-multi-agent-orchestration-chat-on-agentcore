import { describe, expect, it } from 'vitest';
import { layoutWorkflow, parseWorkflowInput, type WorkflowGraphSpec } from '../workflow-layout';

const step = (id: string, dependsOn?: string[]) => ({ id, agentId: 'a', prompt: 'p', dependsOn });

describe('layoutWorkflow', () => {
  it('places each step one column after its deepest dependency', () => {
    const layout = layoutWorkflow({
      goal: 'g',
      steps: [step('a'), step('b'), step('c', ['a']), step('d', ['a', 'c']), step('e', ['b'])],
    })!;
    const level = Object.fromEntries(layout.nodes.map((n) => [n.step.id, n.level]));
    expect(level).toEqual({ a: 0, b: 0, c: 1, e: 1, d: 2 });
    expect(layout.edges).toContainEqual({ from: 'a', to: 'd' });
  });

  it('orders a column by the average row of its parents to avoid crossings', () => {
    const layout = layoutWorkflow({
      goal: 'g',
      steps: [
        step('top'),
        step('bottom'),
        step('from_bottom', ['bottom']),
        step('from_top', ['top']),
      ],
    })!;
    expect(layout.levels[1].map((s) => s.id)).toEqual(['from_top', 'from_bottom']);
  });

  it('returns null for cycles, unknown dependencies and duplicate ids', () => {
    const bad: WorkflowGraphSpec[] = [
      { goal: 'g', steps: [step('a', ['b']), step('b', ['a'])] },
      { goal: 'g', steps: [step('a', ['missing'])] },
      { goal: 'g', steps: [step('a'), step('a')] },
    ];
    for (const spec of bad) expect(layoutWorkflow(spec)).toBeNull();
  });
});

describe('parseWorkflowInput', () => {
  it('accepts only a complete start action', () => {
    expect(
      parseWorkflowInput({ action: 'start', workflow: { goal: 'g', steps: [step('a')] } })
    ).not.toBeNull();
    expect(parseWorkflowInput({ action: 'status', workflowId: 'wf-1' })).toBeNull();
    // A partially streamed input has no steps yet.
    expect(parseWorkflowInput({ action: 'start', workflow: { goal: 'g' } })).toBeNull();
    expect(
      parseWorkflowInput({ action: 'start', workflow: { goal: 'g', steps: [{ id: 'a' }] } })
    ).toBeNull();
  });
});
