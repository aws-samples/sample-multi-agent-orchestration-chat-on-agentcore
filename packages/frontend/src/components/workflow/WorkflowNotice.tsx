import React from 'react';
import { useTranslation } from 'react-i18next';
import { Workflow } from 'lucide-react';
import type { WorkflowNotification } from '../../utils/session-workflows';
import { openWorkflowStatus } from '../../utils/workflow-events';
import { WorkflowStatusIcon } from './WorkflowStatusIcon';

/**
 * Stands in for the orchestrator's "workflow finished" prompt, which is stored
 * as a user turn but is an internal message to the agent.
 */
export const WorkflowNotice: React.FC<{ notice: WorkflowNotification }> = ({ notice }) => {
  const { t } = useTranslation();
  const status = notice.status ?? 'completed';
  return (
    <div className="mb-6 flex justify-center">
      <div className="flex max-w-full items-center gap-2 rounded-full border border-border bg-surface-secondary px-3 py-1.5 text-xs text-fg-secondary">
        <Workflow className="size-3.5 shrink-0 text-fg-link" aria-hidden />
        <WorkflowStatusIcon status={status} className="size-3" />
        <span className="min-w-0 truncate">
          {t(`workflowStatus.notice.${status}`, { goal: notice.goal ?? notice.workflowId })}
        </span>
        <button
          type="button"
          onClick={() => openWorkflowStatus(notice.workflowId)}
          className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-fg-link hover:bg-surface-primary"
        >
          {t('workflowStatus.notice.show')}
        </button>
      </div>
    </div>
  );
};
