/**
 * A top-level session in the sidebar plus its child sessions, grouped as
 * parent → workflow (goal, progress) → step sessions, and parent → call_agent
 * sub-agents. Collapsed by default; opens on its own when the active session
 * is one of its children.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Bot, ChevronRight, Workflow } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SessionSummary } from '../../api/sessions';
import type { WorkflowView } from '../../api/workflows';
import { useWorkflowStore } from '../../stores/workflowStore';
import { useWorkflowPolling } from '../../hooks/useSessionWorkflows';
import { WorkflowStatusIcon } from '../workflow/WorkflowStatusIcon';
import { countDoneSteps } from '../../utils/workflow-status';
import type { AnyWorkflowStatus } from '../../utils/workflow-status';
import { treeContains, type SessionTreeNode, type WorkflowGroup } from './session-tree';
import { SessionItem } from './SessionItem';

const ExpandToggle: React.FC<{ open: boolean; label: string; onToggle: () => void }> = ({
  open,
  label,
  onToggle,
}) => (
  <button
    type="button"
    onClick={onToggle}
    aria-expanded={open}
    aria-label={label}
    className="grid size-5 place-items-center rounded text-fg-muted hover:bg-border hover:text-fg-secondary"
  >
    <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
  </button>
);

/** Polls the workflows of an expanded group until they finish. */
function useWorkflowViews(ids: string[], enabled: boolean): Record<string, WorkflowView> {
  const key = ids.join(',');
  // Only this row's workflows: a refresh of any other workflow must not re-render every row.
  const views = useWorkflowStore(
    useShallow((s) => {
      const picked: Record<string, WorkflowView> = {};
      for (const id of key ? key.split(',') : []) {
        const data = s.workflows[id]?.data;
        if (data) picked[id] = data;
      }
      return picked;
    })
  );
  useWorkflowPolling(key, enabled);
  return views;
}

/**
 * A step session's own state: running while its turn runs (exact, per session);
 * otherwise the step's final state, or waiting while the step is still in flight.
 */
function childStatus(child: SessionSummary, view: WorkflowView | undefined): AnyWorkflowStatus {
  if (child.activeTurnStartedAt) return 'running';
  const step = view?.steps.find((s) => s.stepId === child.parent?.stepId);
  if (!step) return 'pending';
  if (step.status === 'running' || step.status === 'reviewing') return 'pending';
  return step.status;
}

interface RowContext {
  activeSessionId: string | null;
  newSessionIds: Set<string>;
  onDeleteRequest: (sessionId: string) => void;
}

const WorkflowGroupRows: React.FC<
  RowContext & { group: WorkflowGroup; view: WorkflowView | undefined }
> = ({ group, view, activeSessionId, newSessionIds, onDeleteRequest }) => {
  const { t } = useTranslation();
  // undefined = follow the default (open); an explicit toggle wins.
  const [open, setOpen] = useState<boolean>();
  const isOpen = open ?? true;
  const running = group.children.some((c) => c.activeTurnStartedAt);
  const status: AnyWorkflowStatus = view?.status ?? (running ? 'running' : 'pending');
  const total = view?.spec.steps.length;
  const goal = group.goal ?? view?.spec.goal ?? group.workflowId;

  return (
    <div>
      <div className="flex items-center gap-1 py-1 pl-1 pr-2">
        <ExpandToggle
          open={isOpen}
          label={t(isOpen ? 'chat.sessionTree.collapse' : 'chat.sessionTree.expand')}
          onToggle={() => setOpen(!isOpen)}
        />
        <Workflow className="size-3 shrink-0 text-fg-link" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary" title={goal}>
          {goal}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-fg-muted">
          <WorkflowStatusIcon status={status} className="size-3" />
          {view && total !== undefined && `${countDoneSteps(view)}/${total}`}
        </span>
      </div>
      {isOpen && (
        <div className="ml-3.5 space-y-0.5 border-l border-border pl-1.5">
          {group.children.map((child) => {
            const reviewer = child.parent?.role === 'reviewer';
            const stepId = child.parent?.stepId ?? child.title;
            return (
              <SessionItem
                key={child.sessionId}
                session={child}
                compact
                isActive={child.sessionId === activeSessionId}
                isNew={newSessionIds.has(child.sessionId)}
                onDeleteRequest={onDeleteRequest}
                label={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <WorkflowStatusIcon
                      status={childStatus(child, view)}
                      className="size-3 shrink-0"
                    />
                    <span className="truncate font-mono">{stepId}</span>
                    {reviewer && <span className="shrink-0">{t('chat.sessionTree.reviewer')}</span>}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

export const SessionTreeItem: React.FC<RowContext & { node: SessionTreeNode }> = ({
  node,
  activeSessionId,
  newSessionIds,
  onDeleteRequest,
}) => {
  const { t } = useTranslation();
  const { session, workflows, subAgents } = node;
  const childCount = workflows.reduce((n, w) => n + w.children.length, 0) + subAgents.length;
  const containsActiveChild =
    session.sessionId !== activeSessionId && treeContains(node, activeSessionId);
  // undefined = open only while a child is the active session; an explicit toggle wins.
  const [open, setOpen] = useState<boolean>();
  const isOpen = childCount > 0 && (open ?? containsActiveChild);
  const views = useWorkflowViews(
    workflows.map((w) => w.workflowId),
    isOpen
  );
  const rowContext = { activeSessionId, newSessionIds, onDeleteRequest };

  return (
    <div>
      <SessionItem
        session={session}
        isActive={session.sessionId === activeSessionId}
        isNew={newSessionIds.has(session.sessionId)}
        onDeleteRequest={onDeleteRequest}
        leading={
          childCount > 0 ? (
            <ExpandToggle
              open={isOpen}
              label={t(isOpen ? 'chat.sessionTree.collapse' : 'chat.sessionTree.expand')}
              onToggle={() => setOpen(!isOpen)}
            />
          ) : undefined
        }
        trailing={
          childCount > 0 && (
            <span className="shrink-0 rounded-full bg-surface-secondary px-1.5 text-[10px] text-fg-muted group-hover:bg-surface-primary">
              {childCount}
            </span>
          )
        }
      />
      {isOpen && (
        <div className="ml-3.5 mt-0.5 space-y-0.5 border-l border-border pl-1">
          {workflows.map((group) => (
            <WorkflowGroupRows
              key={group.workflowId}
              group={group}
              view={views[group.workflowId]}
              {...rowContext}
            />
          ))}
          {subAgents.map((child) => (
            <SessionItem
              key={child.sessionId}
              session={child}
              compact
              isActive={child.sessionId === activeSessionId}
              isNew={newSessionIds.has(child.sessionId)}
              onDeleteRequest={onDeleteRequest}
              label={
                <span className="flex min-w-0 items-center gap-1.5">
                  <Bot className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{child.title}</span>
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
};
