/**
 * Live status of the run_workflow executions started in a chat session.
 * Opened from the launcher above the composer.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Copy, ExternalLink, Square, Workflow, X } from 'lucide-react';
import { Modal } from '../ui/Modal/Modal';
import { ConfirmModal } from '../ui/Modal/ConfirmModal';
import { cn } from '../../lib/utils';
import { useUIStore } from '../../stores/uiStore';
import { useWorkflowStore } from '../../stores/workflowStore';
import { isTerminalWorkflowStatus, type WorkflowView } from '../../api/workflows';
import type { WorkflowGraphStep } from '../../utils/workflow-layout';
import { layoutWorkflow } from '../../utils/workflow-layout';
import { WorkflowGraph } from '../WorkflowGraph';
import { useAgentName } from '../../hooks/useAgentName';
import {
  countDoneSteps,
  formatWorkflowDuration,
  isActiveStatus,
  pickDefaultStep,
} from '../../utils/workflow-status';
import { WorkflowStatusIcon } from './WorkflowStatusIcon';
import { WorkflowMarkdown } from './WorkflowMarkdown';

/** Mirrors WORKFLOW_LIMITS.DEFAULT_REVIEW_ITERATIONS in @moca/tool-definitions. */
const DEFAULT_REVIEW_ROUNDS = 2;
const CLOCK_TICK_MS = 15_000;
/** Shrinks the shared markdown styles (headings are text-lg/base) to the instruction's size. */
const SMALL_MARKDOWN = cn(
  'text-xs [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h4]:text-xs [&_h1]:mt-3 [&_h2]:mt-3 [&_p]:mb-2',
  // No typography plugin: tables would render without any rules.
  '[&_table]:my-2 [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border',
  '[&_th]:bg-surface-secondary [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:text-left'
);

/** Wall clock for elapsed times; ticks only while the modal is open. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Deferred so opening the modal refreshes the clock without a synchronous setState.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

function useFormatDuration(): (ms: number) => string {
  const { t } = useTranslation();
  return (ms) => formatWorkflowDuration(ms, t);
}

export type DetailTab = 'result' | 'instruction';

/**
 * One card that switches between the workflow's result and the selected
 * step's instruction, so long texts do not stack up vertically.
 */
const DetailTabs: React.FC<{
  outputs: WorkflowView['steps'];
  prompt: string | undefined;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}> = ({ outputs, prompt, tab, onTab }) => {
  const { t } = useTranslation();
  const tabs = [
    ...(outputs.length > 0 ? (['result'] as const) : []),
    ...(prompt !== undefined ? (['instruction'] as const) : []),
  ];
  if (tabs.length === 0) return null;
  // Falls back when the requested tab has no content (no result yet / no step selected).
  const active = tabs.includes(tab) ? tab : tabs[0];
  const copyText =
    active === 'result'
      ? outputs
          .map((s) => (outputs.length > 1 ? `## ${s.stepId}\n\n${s.output}` : s.output))
          .join('\n\n')
      : (prompt ?? '');

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-card border border-border">
      <div
        role="tablist"
        aria-label={t('workflowStatus.detailTabs')}
        className="flex shrink-0 gap-1 border-b border-border bg-surface-secondary px-2 pt-1.5"
      >
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            onClick={() => onTab(key)}
            className={cn(
              '-mb-px rounded-t-md border px-3 py-1 text-xs',
              active === key
                ? 'border-border border-b-surface-primary bg-surface-primary font-medium text-fg-default'
                : 'border-transparent text-fg-muted hover:text-fg-secondary'
            )}
          >
            {t(key === 'result' ? 'workflowStatus.result' : 'workflowStatus.instruction')}
          </button>
        ))}
        <button
          type="button"
          // clipboard is undefined outside secure contexts; copying is best-effort.
          onClick={() => void navigator.clipboard?.writeText(copyText).catch(() => undefined)}
          title={t('common.copyToClipboard')}
          className="mb-1 ml-auto inline-flex items-center gap-1 self-center rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-primary hover:text-fg-secondary"
        >
          <Copy className="size-3" aria-hidden />
          {t('common.copy')}
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 overflow-y-auto px-4 py-3">
        {active === 'result' ? (
          <div className="space-y-3">
            {outputs.map((s) => (
              <div key={s.stepId}>
                {outputs.length > 1 && (
                  <p className="mb-1 font-mono text-xs font-medium text-fg-secondary">{s.stepId}</p>
                )}
                <WorkflowMarkdown text={s.output!} className={SMALL_MARKDOWN} />
              </div>
            ))}
          </div>
        ) : (
          <WorkflowMarkdown text={prompt ?? ''} className={SMALL_MARKDOWN} />
        )}
      </div>
    </section>
  );
};

const StepDetail: React.FC<{
  workflow: WorkflowView;
  step: WorkflowGraphStep | undefined;
  now: number;
  onNavigate: () => void;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}> = ({ workflow, step, now, onNavigate, tab, onTab }) => {
  const { t } = useTranslation();
  const agentName = useAgentName();
  const formatDuration = useFormatDuration();
  // Only finished final steps carry an output in the summary view.
  const finalOutputs = workflow.steps.filter((s) => s.output);
  if (!step) {
    return (
      <div className="flex min-h-72 flex-1 flex-col border-t border-border pt-4">
        <DetailTabs outputs={finalOutputs} prompt={undefined} tab={tab} onTab={onTab} />
      </div>
    );
  }
  const state = workflow.steps.find((s) => s.stepId === step.id);
  const status = state?.status ?? 'pending';
  const startedAt = state?.startedAt ? Date.parse(state.startedAt) : undefined;
  const endedAt = state && !isActiveStatus(status) ? Date.parse(state.updatedAt) : now;
  const pendingDeps = (step.dependsOn ?? []).filter(
    (d) => workflow.steps.find((s) => s.stepId === d)?.status !== 'done'
  );
  const meta = [
    agentName(step.agentId),
    step.review &&
      t('workflowStatus.reviewer', {
        agent: agentName(step.review.agentId),
        count: step.review.maxIterations ?? DEFAULT_REVIEW_ROUNDS,
      }),
    t(`workflowStatus.step.${status}`),
    startedAt !== undefined && status !== 'pending' && formatDuration(endedAt - startedAt),
  ].filter(Boolean);

  return (
    // The tab card takes what the fixed parts leave and scrolls inside. On a
    // short window the min-h floor overflows the (shrinkable) ancestors, and the
    // modal body scrolls that overflow instead of squeezing the card to a few lines.
    <div className="flex min-h-72 flex-1 flex-col gap-2 border-t border-border pt-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-sm font-semibold text-fg-default">{step.id}</h3>
        {state?.sessionId && status !== 'pending' && (
          <Link
            to={`/chat/${state.sessionId}`}
            onClick={onNavigate}
            className="inline-flex items-center gap-1.5 rounded-btn border border-border-strong px-2.5 py-1 text-xs text-fg-secondary hover:bg-surface-secondary hover:text-fg-default"
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('workflowStatus.openSession')}
          </Link>
        )}
      </div>
      <p className="text-xs text-fg-muted">{meta.join(t('workflowStatus.separator'))}</p>
      {status === 'pending' && (
        <p className="text-fg-secondary">
          {pendingDeps.length > 0
            ? t('workflowStatus.waitingFor', { steps: pendingDeps.join(', ') })
            : t('workflowStatus.waiting')}
        </p>
      )}
      {state?.error && (
        <p className="whitespace-pre-wrap wrap-break-word rounded-btn border border-feedback-error-border bg-feedback-error-bg px-3 py-2 text-xs text-feedback-error">
          {state.error}
        </p>
      )}
      {state?.feedback && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-l-2 border-border-strong pl-3 text-fg-secondary">
          <p className="text-xs text-fg-muted">{t('workflowStatus.feedback')}</p>
          <WorkflowMarkdown
            text={state.feedback}
            className={cn(SMALL_MARKDOWN, 'text-fg-secondary')}
          />
        </div>
      )}
      {state?.unapproved && (
        <p className="text-xs text-feedback-warning">{t('workflowStatus.unapproved')}</p>
      )}
      <div className="flex min-h-0 flex-col pt-1">
        <DetailTabs outputs={finalOutputs} prompt={step.prompt} tab={tab} onTab={onTab} />
      </div>
    </div>
  );
};

/** Vertical list used instead of the graph on narrow screens. */
const StepList: React.FC<{
  workflow: WorkflowView;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}> = ({ workflow, selected, onSelect }) => {
  const { t } = useTranslation();
  const agentName = useAgentName();
  return (
    <ul className="space-y-2">
      {workflow.spec.steps.map((step) => {
        const state = workflow.steps.find((s) => s.stepId === step.id);
        const status = state?.status ?? 'pending';
        const isSelected = selected === step.id;
        return (
          <li key={step.id}>
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(isSelected ? undefined : step.id)}
              className={cn(
                'w-full rounded-btn border px-3 py-2 text-left',
                status === 'pending' ? 'bg-surface-secondary' : 'bg-surface-primary',
                isSelected
                  ? 'border-action-primary ring-1 ring-action-primary'
                  : isActiveStatus(status)
                    ? 'border-action-primary'
                    : 'border-border'
              )}
            >
              <div className="truncate font-mono text-xs font-medium text-fg-default">
                {step.id}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-secondary">
                <WorkflowStatusIcon status={status} className="size-3" />
                <span>{t(`workflowStatus.step.${status}`)}</span>
                <span className="truncate text-fg-muted">
                  {t('workflowStatus.separator')}
                  {agentName(step.agentId)}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
};

const WorkflowBody: React.FC<{ workflow: WorkflowView; now: number; onNavigate: () => void }> = ({
  workflow,
  now,
  onNavigate,
}) => {
  const isMobileView = useUIStore((s) => s.isMobileView);
  const [selected, setSelected] = useState<string | undefined>(() => pickDefaultStep(workflow));
  const stepStates = useMemo(
    () => Object.fromEntries(workflow.steps.map((s) => [s.stepId, s])),
    [workflow.steps]
  );
  const canGraph = useMemo(() => layoutWorkflow(workflow.spec) !== null, [workflow.spec]);
  // Kept here so switching steps keeps the chosen tab; the result first once there is one.
  const [tab, setTab] = useState<DetailTab>('result');
  const tabProps = { tab, onTab: setTab };
  const findStep = (id: string | undefined) => workflow.spec.steps.find((s) => s.id === id);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {!canGraph ? (
        <>
          <div className="shrink-0">
            <StepList workflow={workflow} selected={selected} onSelect={setSelected} />
          </div>
          <StepDetail
            workflow={workflow}
            step={findStep(selected)}
            now={now}
            onNavigate={onNavigate}
            {...tabProps}
          />
        </>
      ) : (
        <WorkflowGraph
          spec={workflow.spec}
          stepStates={stepStates}
          defaultSelected={selected}
          centerSelected={isMobileView}
          hideGoal
          className="flex min-h-0 flex-1 flex-col space-y-0 gap-2"
          renderDetail={(step) => (
            <StepDetail
              workflow={workflow}
              step={step}
              now={now}
              onNavigate={onNavigate}
              {...tabProps}
            />
          )}
        />
      )}
      {workflow.error && (
        <p className="max-h-24 shrink-0 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-btn border border-feedback-error-border bg-feedback-error-bg px-3 py-2 text-sm text-feedback-error">
          {workflow.error}
        </p>
      )}
    </div>
  );
};

interface WorkflowStatusModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Newest first. */
  workflows: WorkflowView[];
  /** Workflow to show; defaults to the running one, else the newest. */
  selectedId?: string;
  onSelect: (workflowId: string) => void;
}

export const WorkflowStatusModal: React.FC<WorkflowStatusModalProps> = ({
  isOpen,
  onClose,
  workflows,
  selectedId,
  onSelect,
}) => {
  const { t, i18n } = useTranslation();
  const isMobileView = useUIStore((s) => s.isMobileView);
  const cancel = useWorkflowStore((s) => s.cancel);
  const markSeen = useWorkflowStore((s) => s.markSeen);
  const formatDuration = useFormatDuration();
  const now = useNow(isOpen);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  const workflow =
    workflows.find((w) => w.workflowId === selectedId) ??
    workflows.find((w) => !isTerminalWorkflowStatus(w.status)) ??
    workflows[0];
  const terminal = workflow ? isTerminalWorkflowStatus(workflow.status) : false;

  useEffect(() => {
    if (isOpen && workflow && terminal) markSeen(workflow.workflowId);
  }, [isOpen, workflow, terminal, markSeen]);

  if (!workflow) return null;

  const done = countDoneSteps(workflow);
  const total = workflow.spec.steps.length;
  const createdAt = Date.parse(workflow.createdAt);
  const endedAt = workflow.completedAt ? Date.parse(workflow.completedAt) : now;
  const summary = terminal
    ? [
        t(`workflowStatus.status.${workflow.status}`),
        t('workflowStatus.stepCount', { count: total }),
        t('workflowStatus.took', { duration: formatDuration(endedAt - createdAt) }),
      ]
    : [
        t(`workflowStatus.status.${workflow.status}`),
        t('workflowStatus.progress', { done, total }),
        t('workflowStatus.elapsed', { duration: formatDuration(now - createdAt) }),
      ];
  const canStop = !terminal && !workflow.cancelRequested;

  const handleStop = async () => {
    setStopping(true);
    try {
      await cancel(workflow.workflowId);
    } catch {
      toast.error(t('workflowStatus.stopFailed'));
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size={isMobileView ? 'xl' : 'lg'}
        // Fixed height: switching workflows would otherwise resize the modal with
        // the length of each result; the body scrolls instead.
        className="md:h-[min(92vh,64rem)] md:w-full md:max-w-6xl"
      >
        <div className="shrink-0 border-b border-border px-4 py-3 md:px-6 md:py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Workflow className="size-5 shrink-0 text-fg-link" aria-hidden />
                <h2 className="truncate text-base font-semibold text-fg-default md:text-lg">
                  {workflow.spec.goal}
                </h2>
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-secondary">
                <WorkflowStatusIcon status={workflow.status} />
                <span>{summary.join(t('workflowStatus.separator'))}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="shrink-0 rounded-md p-2 text-fg-disabled transition-colors hover:bg-surface-secondary hover:text-fg-secondary"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {workflows.length > 1 && (
          <div
            role="tablist"
            aria-label={t('workflowStatus.workflows')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface-secondary px-3 py-2 md:px-5"
          >
            {workflows.map((w) => {
              const on = w.workflowId === workflow.workflowId;
              return (
                <button
                  key={w.workflowId}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => onSelect(w.workflowId)}
                  className={cn(
                    'inline-flex max-w-60 shrink-0 items-center gap-1.5 rounded-btn px-2.5 py-1 text-xs',
                    on
                      ? 'bg-surface-primary text-fg-default shadow-elevation-1'
                      : 'text-fg-secondary hover:text-fg-default'
                  )}
                >
                  <WorkflowStatusIcon status={w.status} className="size-3" />
                  <span className="truncate">{w.spec.goal}</span>
                </button>
              );
            })}
          </div>
        )}

        {!terminal && (
          <div
            className="h-1 shrink-0 bg-border"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <div
              className="h-full bg-action-primary transition-[width] duration-500"
              style={{ width: `${total ? (done / total) * 100 : 0}%` }}
            />
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6 pt-4 md:px-6 md:pt-5">
          {/* Keyed so the default step is re-picked when switching workflows. */}
          <WorkflowBody
            key={workflow.workflowId}
            workflow={workflow}
            now={now}
            onNavigate={onClose}
          />
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border bg-surface-secondary px-4 py-3 md:px-6">
          <p className="hidden min-w-0 flex-1 truncate text-xs text-fg-muted sm:block">
            {terminal && workflow.completedAt
              ? t('workflowStatus.finishedAt', {
                  time: new Date(workflow.completedAt).toLocaleString(i18n.language),
                })
              : t('workflowStatus.autoUpdating')}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {canStop && (
              <button
                type="button"
                disabled={stopping}
                onClick={() => setConfirmStop(true)}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-feedback-error hover:bg-feedback-error-bg disabled:opacity-50"
              >
                <Square className="size-3.5" aria-hidden />
                {stopping ? t('workflowStatus.stopping') : t('workflowStatus.stop')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-strong bg-surface-primary px-4 py-2 text-sm font-medium text-fg-secondary transition-colors hover:bg-surface-secondary"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </Modal>
      <ConfirmModal
        isOpen={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => void handleStop()}
        title={t('workflowStatus.stopConfirmTitle')}
        message={t('workflowStatus.stopConfirmMessage')}
        confirmText={t('workflowStatus.stop')}
        variant="danger"
      />
    </>
  );
};
