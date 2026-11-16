/**
 * Window event that opens the workflow status modal from outside the composer
 * (e.g. the completion notice in the message list). The modal is owned by the
 * launcher above the composer, so a store would only mirror its local state.
 */

export const WORKFLOW_STATUS_OPEN_EVENT = 'openWorkflowStatus';

export interface WorkflowStatusOpenDetail {
  workflowId: string;
}

export function openWorkflowStatus(workflowId: string): void {
  window.dispatchEvent(
    new CustomEvent<WorkflowStatusOpenDetail>(WORKFLOW_STATUS_OPEN_EVENT, {
      detail: { workflowId },
    })
  );
}
