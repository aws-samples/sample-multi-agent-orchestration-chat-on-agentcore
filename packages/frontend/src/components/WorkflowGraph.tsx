import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { useAgentName } from '../hooks/useAgentName';
import {
  layoutWorkflow,
  type WorkflowGraphSpec,
  type WorkflowGraphStep,
} from '../utils/workflow-layout';
import type { WorkflowStepView } from '../api/workflows';
import { WorkflowStatusIcon } from './workflow/WorkflowStatusIcon';
import { isActiveStatus } from '../utils/workflow-status';

const NODE_W = 168;
const NODE_H = 58;
const GAP_X = 48;
const GAP_Y = 14;
/** Mirrors WORKFLOW_LIMITS.DEFAULT_REVIEW_ITERATIONS in @moca/tool-definitions. */
const DEFAULT_REVIEW_ROUNDS = 2;

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

const ReviewBadge: React.FC<{ step: WorkflowGraphStep; agentName: (id: string) => string }> = ({
  step,
  agentName,
}) => {
  const { t } = useTranslation();
  if (!step.review) return null;
  const rounds = step.review.maxIterations ?? DEFAULT_REVIEW_ROUNDS;
  const label = t('tool.workflowGraph.review', {
    agent: agentName(step.review.agentId),
    count: rounds,
  });
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-feedback-info-border bg-feedback-info-bg px-1.5 py-px text-[10px] text-feedback-info"
      title={label}
      aria-label={label}
    >
      <RefreshCw className="size-2.5" aria-hidden />
      {t('tool.workflowGraph.rounds', { count: rounds })}
    </span>
  );
};

/** Live status line of a node: status label, plus the review round when the step has a reviewer. */
const LiveStatus: React.FC<{ step: WorkflowGraphStep; state: WorkflowStepView }> = ({
  step,
  state,
}) => {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1 text-[11px] text-fg-secondary">
      <WorkflowStatusIcon status={state.status} className="size-3" />
      <span className="truncate">{t(`workflowStatus.step.${state.status}`)}</span>
      {step.review && state.iteration > 0 && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-fg-muted">
          <RefreshCw className="size-2.5" aria-hidden />
          {state.iteration}/{step.review.maxIterations ?? DEFAULT_REVIEW_ROUNDS}
        </span>
      )}
    </span>
  );
};

const StepDetail: React.FC<{
  step: WorkflowGraphStep | undefined;
  agentName: (id: string) => string;
}> = ({ step, agentName }) => {
  const { t } = useTranslation();
  if (!step) {
    return <p className="text-[11px] text-fg-muted">{t('tool.workflowGraph.selectHint')}</p>;
  }
  return (
    <div className="space-y-1.5 rounded-btn border border-border bg-surface-secondary p-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono font-medium text-fg-default">{step.id}</span>
        <span className="text-fg-secondary">{agentName(step.agentId)}</span>
        {step.modelId && <span className="font-mono text-fg-muted">{step.modelId}</span>}
        {(step.dependsOn ?? []).length > 0 && (
          <span className="font-mono text-fg-muted">
            {t('tool.workflowGraph.dependsOn', { steps: step.dependsOn!.join(', ') })}
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap wrap-break-word text-fg-default">{step.prompt}</p>
      {step.review && (
        <div className="border-t border-border pt-1.5 text-fg-secondary">
          <span className="font-medium">{t('tool.workflowGraph.reviewCriteria')}</span>{' '}
          <span className="whitespace-pre-wrap">{step.review.criteria}</span>
          <span className="ml-1 text-fg-muted">
            {t('tool.workflowGraph.review', {
              agent: agentName(step.review.agentId),
              count: step.review.maxIterations ?? DEFAULT_REVIEW_ROUNDS,
            })}
          </span>
        </div>
      )}
    </div>
  );
};

interface WorkflowGraphProps {
  spec: WorkflowGraphSpec;
  /** Live per-step state; when present, nodes show progress instead of the review badge. */
  stepStates?: Record<string, WorkflowStepView>;
  /** Replaces the spec-only detail shown under the graph for the selected step. */
  renderDetail?: (step: WorkflowGraphStep | undefined) => React.ReactNode;
  defaultSelected?: string;
  /** Hide the goal line (when the caller already shows it as a title). */
  hideGoal?: boolean;
  className?: string;
}

/**
 * Left-to-right DAG of a run_workflow spec. Returns null when the spec cannot
 * be laid out (cycle / unknown dependency) so the caller can fall back to JSON.
 */
export const WorkflowGraph: React.FC<WorkflowGraphProps> = ({
  spec,
  stepStates,
  renderDetail,
  defaultSelected,
  hideGoal,
  className,
}) => {
  const { t } = useTranslation();
  const agentName = useAgentName();
  const layout = useMemo(() => layoutWorkflow(spec), [spec]);
  const [selected, setSelected] = useState<string | undefined>(defaultSelected);
  const markerId = useId();
  if (!layout) return null;

  const maxRows = Math.max(...layout.levels.map((c) => c.length));
  const pos = new Map(
    layout.nodes.map((n) => {
      const offset = ((maxRows - layout.levels[n.level].length) * (NODE_H + GAP_Y)) / 2;
      return [n.step.id, { x: n.level * (NODE_W + GAP_X), y: offset + n.row * (NODE_H + GAP_Y) }];
    })
  );
  const width = layout.levels.length * (NODE_W + GAP_X) - GAP_X;
  const height = maxRows * (NODE_H + GAP_Y) - GAP_Y;
  // Draw highlighted edges last so they sit on top of the others.
  const edges = [...layout.edges].sort(
    (a, b) =>
      Number(selected === a.from || selected === a.to) -
      Number(selected === b.from || selected === b.to)
  );

  return (
    <div className={cn('space-y-2', className)}>
      {spec.goal && !hideGoal && (
        <p className="text-xs text-fg-secondary">
          <span className="font-medium">{t('tool.workflowGraph.goal')}</span> {spec.goal}
        </p>
      )}
      <div className="overflow-x-auto pb-1">
        <div
          role="group"
          aria-label={t('tool.workflowGraph.ariaLabel', { count: spec.steps.length })}
          className="relative"
          style={{ width, height }}
        >
          <svg
            className="absolute inset-0 overflow-visible"
            width={width}
            height={height}
            aria-hidden
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 z" className="fill-fg-disabled" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = pos.get(e.from)!;
              const b = pos.get(e.to)!;
              const hot = selected === e.from || selected === e.to;
              // An edge whose output is being consumed right now.
              const flowing =
                stepStates?.[e.from]?.status === 'done' &&
                isActiveStatus(stepStates?.[e.to]?.status ?? 'pending');
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(a.x + NODE_W, a.y + NODE_H / 2, b.x - 2, b.y + NODE_H / 2)}
                  className={cn(
                    'fill-none',
                    hot || flowing ? 'stroke-action-primary' : 'stroke-border-strong'
                  )}
                  strokeWidth={hot ? 2 : 1.5}
                  strokeDasharray={flowing && !hot ? '4 3' : undefined}
                  markerEnd={`url(#${markerId})`}
                />
              );
            })}
          </svg>
          {layout.nodes.map(({ step }) => {
            const p = pos.get(step.id)!;
            const isSelected = selected === step.id;
            const state = stepStates?.[step.id];
            return (
              <button
                key={step.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelected(isSelected ? undefined : step.id)}
                className={cn(
                  'absolute rounded-btn border px-2 py-1.5 text-left text-xs shadow-elevation-1 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
                  state?.status === 'pending' ? 'bg-surface-secondary' : 'bg-surface-primary',
                  isSelected
                    ? 'border-action-primary ring-1 ring-action-primary'
                    : state && isActiveStatus(state.status)
                      ? 'border-action-primary'
                      : 'border-border hover:border-border-strong'
                )}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              >
                <div className="truncate font-mono font-medium text-fg-default">{step.id}</div>
                <div className="flex items-center gap-1 text-[11px] text-fg-secondary">
                  <Bot className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{agentName(step.agentId)}</span>
                </div>
                <div className="mt-0.5 h-4">
                  {state ? (
                    <LiveStatus step={step} state={state} />
                  ) : (
                    <ReviewBadge step={step} agentName={agentName} />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {renderDetail ? (
        renderDetail(spec.steps.find((s) => s.id === selected))
      ) : (
        <StepDetail step={spec.steps.find((s) => s.id === selected)} agentName={agentName} />
      )}
    </div>
  );
};
