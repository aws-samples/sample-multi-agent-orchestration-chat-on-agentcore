import type { WorkflowStatus, WorkflowStepStatus, WorkflowView } from '../types/workflow';

export type AnyWorkflowStatus = WorkflowStatus | WorkflowStepStatus;

export function isActiveStatus(status: AnyWorkflowStatus): boolean {
  return status === 'running' || status === 'reviewing';
}

/** Colour is reserved for "in progress" and the outcome; everything else stays muted. */
export function statusTone(status: AnyWorkflowStatus): string {
  switch (status) {
    case 'running':
    case 'reviewing':
      return 'text-action-primary';
    case 'done':
    case 'completed':
      return 'text-feedback-success';
    case 'failed':
      return 'text-feedback-error';
    default:
      return 'text-fg-muted';
  }
}

export function countDoneSteps(workflow: WorkflowView): number {
  return workflow.steps.filter((s) => s.status === 'done').length;
}

/** The step the user most likely wants to see: the running one, else a failed one, else the last. */
export function pickDefaultStep(workflow: WorkflowView): string | undefined {
  const active = workflow.steps.find((s) => isActiveStatus(s.status));
  if (active) return active.stepId;
  const failed = workflow.steps.find((s) => s.status === 'failed');
  if (failed) return failed.stepId;
  return workflow.spec.steps[workflow.spec.steps.length - 1]?.id;
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export function formatWorkflowDuration(ms: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t('workflowStatus.duration.lessThanMinute');
  if (minutes < 60) return t('workflowStatus.duration.minutes', { m: minutes });
  return t('workflowStatus.duration.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
}
