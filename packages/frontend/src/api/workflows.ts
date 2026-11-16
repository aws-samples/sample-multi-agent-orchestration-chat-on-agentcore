/**
 * Workflows API client (run_workflow progress).
 */

import { backendClient } from './client/backend-client';
import type { WorkflowView } from '../types/workflow';

export * from '../types/workflow';

/** Header plus per-step state, without step outputs (the UI polls this). */
export async function getWorkflow(workflowId: string): Promise<WorkflowView> {
  const data = await backendClient.get<{ workflow: WorkflowView }>(
    `/workflows/${encodeURIComponent(workflowId)}?view=summary`
  );
  return data.workflow;
}

export async function cancelWorkflow(workflowId: string): Promise<void> {
  await backendClient.post(`/workflows/${encodeURIComponent(workflowId)}/cancel`);
}
