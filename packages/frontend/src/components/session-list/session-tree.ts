/**
 * Nests child sessions (workflow steps, call_agent sub-agents) under their
 * parent for the session sidebar. Children never have children of their own
 * (both paths remove call_agent / run_workflow from the child's tools).
 */

import type { SessionSummary } from '../../api/sessions';

export interface WorkflowGroup {
  workflowId: string;
  goal?: string;
  /** Step sessions in creation order (worker before its reviewer). */
  children: SessionSummary[];
}

export interface SessionTreeNode {
  session: SessionSummary;
  workflows: WorkflowGroup[];
  subAgents: SessionSummary[];
}

const byCreatedAt = (a: SessionSummary, b: SessionSummary) =>
  a.createdAt.localeCompare(b.createdAt);

/**
 * Keeps the list order of top-level sessions. A child whose parent is not in
 * `sessions` (deleted, or not paged in yet) stays top-level so it never
 * disappears from the list.
 */
export function buildSessionTree(sessions: SessionSummary[]): SessionTreeNode[] {
  const ids = new Set<string>(sessions.map((s) => s.sessionId));
  const childrenOf = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const parentId = s.parent?.sessionId;
    if (!parentId || !ids.has(parentId) || parentId === s.sessionId) continue;
    const list = childrenOf.get(parentId) ?? [];
    list.push(s);
    childrenOf.set(parentId, list);
  }
  const nested = new Set([...childrenOf.values()].flat().map((s) => s.sessionId));

  return sessions
    .filter((s) => !nested.has(s.sessionId))
    .map((session) => {
      const children = (childrenOf.get(session.sessionId) ?? []).sort(byCreatedAt);
      const workflows = new Map<string, WorkflowGroup>();
      const subAgents: SessionSummary[] = [];
      for (const child of children) {
        const workflowId = child.parent?.workflowId;
        if (!workflowId) {
          subAgents.push(child);
          continue;
        }
        const group = workflows.get(workflowId) ?? {
          workflowId,
          goal: child.parent?.workflowGoal,
          children: [],
        };
        group.children.push(child);
        workflows.set(workflowId, group);
      }
      return { session, workflows: [...workflows.values()], subAgents };
    });
}

/** Whether `sessionId` is the node's own session or one of its children. */
export function treeContains(node: SessionTreeNode, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return (
    node.session.sessionId === sessionId ||
    node.subAgents.some((s) => s.sessionId === sessionId) ||
    node.workflows.some((w) => w.children.some((s) => s.sessionId === sessionId))
  );
}
