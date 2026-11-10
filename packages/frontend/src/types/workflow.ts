/**
 * run_workflow shapes as seen by the frontend. They mirror the spec and
 * `WorkflowRecord` / `WorkflowStepState` in @moca/tool-definitions, which the
 * frontend does not depend on.
 */

export interface WorkflowGraphStep {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  modelId?: string;
  review?: { agentId: string; criteria: string; maxIterations?: number };
}

export interface WorkflowGraphSpec {
  goal: string;
  steps: WorkflowGraphStep[];
  maxConcurrency?: number;
  notifyOnComplete?: boolean;
}

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type WorkflowStepStatus =
  'pending' | 'running' | 'reviewing' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface WorkflowStepView {
  stepId: string;
  status: WorkflowStepStatus;
  runs: number;
  /** Work→review round within the current run. */
  iteration: number;
  sessionId?: string;
  reviewerSessionId?: string;
  /** Latest reviewer or downstream feedback. */
  feedback?: string;
  unapproved?: boolean;
  error?: string;
  startedAt?: string;
  updatedAt: string;
}

export interface WorkflowView {
  workflowId: string;
  status: WorkflowStatus;
  spec: WorkflowGraphSpec;
  result?: string;
  error?: string;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  steps: WorkflowStepView[];
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
