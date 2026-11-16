/**
 * Where a child session came from. Written by the agent on the child's session
 * row (workflow steps and call_agent sub-agents) so the session list can nest
 * children under their parent. Children never spawn children (call_agent and
 * run_workflow are removed from their tools), so one level is enough.
 */
export type WorkflowSessionRole = 'worker' | 'reviewer';

export interface SessionParent {
  sessionId: string;
  /** Set for run_workflow step sessions; absent for call_agent sub-agents. */
  workflowId?: string;
  workflowGoal?: string;
  stepId?: string;
  role?: WorkflowSessionRole;
}
