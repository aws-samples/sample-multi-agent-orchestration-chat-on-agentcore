import { describe, it, expect } from 'vitest';
import type { SessionSummary } from '../../../api/sessions';
import { buildSessionTree, treeContains } from '../session-tree';

const s = (id: string, createdAt: string, parent?: SessionSummary['parent']): SessionSummary =>
  ({ sessionId: id, title: id, createdAt, updatedAt: createdAt, parent }) as SessionSummary;

describe('buildSessionTree', () => {
  const sessions = [
    s('stepB', '05', { sessionId: 'p1', workflowId: 'w1', workflowGoal: 'G', stepId: 'b' }),
    s('p2', '04'),
    s('stepAReview', '03', {
      sessionId: 'p1',
      workflowId: 'w1',
      stepId: 'a',
      role: 'reviewer',
    }),
    s('stepA', '02', { sessionId: 'p1', workflowId: 'w1', workflowGoal: 'G', stepId: 'a' }),
    s('sub', '02', { sessionId: 'p1' }),
    s('p1', '01'),
    s('orphan', '00', { sessionId: 'gone', workflowId: 'w9', stepId: 'x' }),
  ];

  it('nests children under their parent and keeps the top-level order', () => {
    const tree = buildSessionTree(sessions);
    expect(tree.map((n) => n.session.sessionId)).toEqual(['p2', 'p1', 'orphan']);
    const p1 = tree.find((n) => n.session.sessionId === 'p1')!;
    expect(p1.workflows).toHaveLength(1);
    expect(p1.workflows[0].goal).toBe('G');
    // Creation order: worker before its reviewer.
    expect(p1.workflows[0].children.map((c) => c.sessionId)).toEqual([
      'stepA',
      'stepAReview',
      'stepB',
    ]);
    expect(p1.subAgents.map((c) => c.sessionId)).toEqual(['sub']);
  });

  it('keeps a child top-level when its parent is not loaded', () => {
    const orphan = buildSessionTree(sessions).find((n) => n.session.sessionId === 'orphan')!;
    expect(orphan.workflows).toEqual([]);
  });

  it('finds the active session among children', () => {
    const p1 = buildSessionTree(sessions).find((n) => n.session.sessionId === 'p1')!;
    expect(treeContains(p1, 'stepAReview')).toBe(true);
    expect(treeContains(p1, 'p2')).toBe(false);
  });
});
