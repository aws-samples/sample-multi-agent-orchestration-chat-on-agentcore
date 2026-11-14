/**
 * Icon button above the composer (next to the storage path) that shows the
 * progress of this session's workflows and opens their status modal.
 * Renders nothing when the session has started no workflow.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useWorkflowStore } from '../../stores/workflowStore';
import {
  useSessionWorkflows,
  WORKFLOW_POLL_INTERVAL_FOCUSED_MS,
  WORKFLOW_POLL_INTERVAL_MS,
} from '../../hooks/useSessionWorkflows';
import { isTerminalWorkflowStatus } from '../../api/workflows';
import { countDoneSteps } from '../../utils/workflow-status';
import { WorkflowStatusModal } from './WorkflowStatusModal';
import {
  WORKFLOW_STATUS_OPEN_EVENT,
  type WorkflowStatusOpenDetail,
} from '../../utils/workflow-events';

const RING_RADIUS = 12;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export const WorkflowStatusLauncher: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  useEffect(() => {
    const onOpen = (e: Event) => {
      setSelectedId((e as CustomEvent<WorkflowStatusOpenDetail>).detail.workflowId);
      setIsOpen(true);
    };
    window.addEventListener(WORKFLOW_STATUS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(WORKFLOW_STATUS_OPEN_EVENT, onOpen);
  }, []);
  const workflows = useSessionWorkflows(
    sessionId,
    isOpen ? WORKFLOW_POLL_INTERVAL_FOCUSED_MS : WORKFLOW_POLL_INTERVAL_MS
  );
  const seen = useWorkflowStore((s) => s.seen);
  if (workflows.length === 0) return null;

  // The ring follows the workflow still running, else the newest one.
  const focus = workflows.find((w) => !isTerminalWorkflowStatus(w.status)) ?? workflows[0];
  const running = !isTerminalWorkflowStatus(focus.status);
  const total = focus.spec.steps.length;
  const done = countDoneSteps(focus);
  const unseen = workflows.some(
    (w) => isTerminalWorkflowStatus(w.status) && !seen.includes(w.workflowId)
  );
  const label = running
    ? t('workflowStatus.tooltipRunning', { done, total })
    : unseen
      ? t('workflowStatus.tooltipUnseen')
      : t('workflowStatus.tooltipDone');
  const ringColor = running
    ? 'stroke-action-primary'
    : focus.status === 'completed'
      ? 'stroke-feedback-success'
      : focus.status === 'failed'
        ? 'stroke-feedback-error'
        : 'stroke-fg-disabled';
  // A finished workflow draws a full ring even when some steps were skipped.
  const progress = running ? (total ? done / total : 0) : 1;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSelectedId(undefined);
          setIsOpen(true);
        }}
        title={label}
        aria-label={`${t('workflowStatus.open')}: ${label}`}
        className={cn(
          'relative grid size-8 place-items-center rounded-lg text-fg-secondary transition-colors',
          'hover:bg-surface-secondary hover:text-fg-default',
          isOpen && 'bg-surface-secondary text-fg-default'
        )}
      >
        <svg className="absolute inset-1 size-6 -rotate-90" viewBox="0 0 28 28" aria-hidden>
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-border"
          />
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${RING_LENGTH * progress} ${RING_LENGTH}`}
            className={cn(ringColor, 'transition-[stroke-dasharray] duration-500')}
          />
        </svg>
        <Workflow className="relative size-3.5" aria-hidden />
        {unseen && (
          <span
            className="absolute right-1 top-1 size-2 rounded-full border-[1.5px] border-surface-primary bg-action-primary"
            aria-hidden
          />
        )}
      </button>
      <WorkflowStatusModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        workflows={workflows}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </>
  );
};
