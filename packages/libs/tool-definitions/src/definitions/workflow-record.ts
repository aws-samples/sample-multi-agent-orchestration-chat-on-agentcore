/**
 * Persisted workflow state, shared by the Backend (create / read / cancel)
 * and the orchestrator (progress updates). One header item per workflow plus
 * one item per step: step outputs are large enough that ten of them would
 * overflow DynamoDB's 400 KB item limit.
 */

import type { WorkflowSpec } from './run-workflow.js';

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type WorkflowStepStatus =
  'pending' | 'running' | 'reviewing' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface WorkflowParent {
  sessionId?: string;
  sessionType?: string;
  agentId?: string;
  modelId?: string;
  storagePath?: string;
}

export interface WorkflowRecord {
  workflowId: string;
  userId: string;
  status: WorkflowStatus;
  spec: WorkflowSpec;
  parent?: WorkflowParent;
  /** Final summary written by the orchestrator. */
  result?: string;
  error?: string;
  /** Set by the Backend; the orchestrator stops at its next checkpoint. */
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkflowStepState {
  workflowId: string;
  stepId: string;
  status: WorkflowStepStatus;
  /** How many times the step was (re)scheduled, incl. downstream-requested re-runs. */
  runs: number;
  /** Work→review round within the current run. */
  iteration: number;
  sessionId?: string;
  reviewerSessionId?: string;
  output?: string;
  /** Latest reviewer or downstream feedback. */
  feedback?: string;
  /** True when the review loop hit maxIterations without approval. */
  unapproved?: boolean;
  error?: string;
  /** When the current run of the step started (reset on each re-run). */
  startedAt?: string;
  updatedAt: string;
}

export const WORKFLOW_RETENTION_DAYS = 30;

export const workflowKeys = {
  pk: (userId: string) => `USER#${userId}`,
  header: (workflowId: string) => `WORKFLOW#${workflowId}`,
  headerPrefix: 'WORKFLOW#',
  step: (workflowId: string, stepId: string) => `WFSTEP#${workflowId}#${stepId}`,
  stepPrefix: (workflowId: string) => `WFSTEP#${workflowId}#`,
};

export function workflowTtl(now = Date.now()): number {
  return Math.floor(now / 1000) + WORKFLOW_RETENTION_DAYS * 24 * 60 * 60;
}

export function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** Payload of the orchestrator Lambda (a durable execution per workflow). */
export type WorkflowOrchestratorEvent =
  | { action: 'run'; workflowId: string; userId: string }
  | { action: 'cancel'; workflowId: string; userId: string };
