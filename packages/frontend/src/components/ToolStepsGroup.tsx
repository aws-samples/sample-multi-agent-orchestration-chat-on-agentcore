import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../utils/formatBytes';
import {
  AlertCircle,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Code2,
  FileEdit,
  Film,
  FolderOpen,
  Globe,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  ListTodo,
  Loader2,
  ScanText,
  Search,
  Terminal,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { WorkflowGraph } from './WorkflowGraph';
import { layoutWorkflow, parseWorkflowInput } from '../utils/workflow-layout';
import {
  formatToolResult,
  stepSummary,
  summarizeSteps,
  toolBaseName,
  type Step,
  type ToolStep,
} from '../utils/tool-steps';

/** While live, only the newest steps stay visible so the group height stays stable. */
const LIVE_VISIBLE_STEPS = 3;
const MAX_HEADER_ICONS = 4;

type LabelKey =
  | 'search'
  | 'browse'
  | 'code'
  | 'file'
  | 'command'
  | 'agent'
  | 'todo'
  | 'ui'
  | 'memory'
  | 'think'
  | 'files'
  | 'imageToText'
  | 'image'
  | 'video'
  | 'knowledge'
  | 'trigger'
  | 'workflow'
  | 'reasoning';

const TOOL_META: Record<string, { icon: LucideIcon; label: LabelKey }> = {
  tavily_search: { icon: Search, label: 'search' },
  x_amz_bedrock_agentcore_search: { icon: Search, label: 'search' },
  tavily_extract: { icon: Globe, label: 'browse' },
  tavily_crawl: { icon: Globe, label: 'browse' },
  WebSearch: { icon: Search, label: 'search' },
  browser: { icon: Globe, label: 'browse' },
  code_interpreter: { icon: Code2, label: 'code' },
  file_editor: { icon: FileEdit, label: 'file' },
  execute_command: { icon: Terminal, label: 'command' },
  call_agent: { icon: Bot, label: 'agent' },
  manage_agent: { icon: Bot, label: 'agent' },
  manage_trigger: { icon: Clock, label: 'trigger' },
  run_workflow: { icon: Workflow, label: 'workflow' },
  todo: { icon: ListTodo, label: 'todo' },
  generate_ui: { icon: LayoutDashboard, label: 'ui' },
  memory_search: { icon: History, label: 'memory' },
  think: { icon: Brain, label: 'think' },
  s3_list_files: { icon: FolderOpen, label: 'files' },
  image_to_text: { icon: ScanText, label: 'imageToText' },
  nova_canvas: { icon: ImageIcon, label: 'image' },
  nova_reel: { icon: Film, label: 'video' },
  retrieve: { icon: BookOpen, label: 'knowledge' },
};

const useStepMeta = () => {
  const { t } = useTranslation();
  return (step: Step): { icon: LucideIcon; label: string } => {
    if (step.kind === 'reasoning') return { icon: Brain, label: t('tool.steps.labels.reasoning') };
    const base = toolBaseName(step.name);
    const meta = TOOL_META[base];
    if (meta) return { icon: meta.icon, label: t(`tool.steps.labels.${meta.label}`) };
    // MCP / custom tools: the raw name is the most honest label we have.
    return { icon: Wrench, label: base || t('tool.steps.labels.unknown') };
  };
};

const StatusMark: React.FC<{ step: Step }> = ({ step }) => {
  const { t } = useTranslation();
  switch (step.status) {
    case 'running':
      return (
        <Loader2
          className="size-3.5 shrink-0 text-fg-link motion-safe:animate-spin"
          aria-label={t('tool.steps.status.running')}
        />
      );
    case 'error':
      return (
        <AlertCircle
          className="size-3.5 shrink-0 text-feedback-error"
          aria-label={t('tool.steps.status.error')}
        />
      );
    case 'incomplete':
      return (
        <Circle
          className="size-3 shrink-0 text-fg-disabled"
          aria-label={t('tool.steps.status.incomplete')}
        />
      );
    default:
      return (
        <Check
          className="size-3.5 shrink-0 text-feedback-success"
          aria-label={t('tool.steps.status.completed')}
        />
      );
  }
};

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      // clipboard is undefined outside secure contexts; copying is best-effort.
      onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}
      className="rounded-sm px-1.5 py-0.5 text-[11px] text-fg-disabled hover:bg-surface-secondary hover:text-fg-secondary"
      title={t('common.copyToClipboard')}
    >
      {t('common.copy')}
    </button>
  );
};

const DetailBlock: React.FC<{
  label: string;
  text: string;
  mono: boolean;
  tone?: 'default' | 'error';
}> = ({ label, text, mono, tone = 'default' }) => (
  <div>
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-medium text-fg-muted">{label}</span>
      <CopyButton text={text} />
    </div>
    <pre
      className={cn(
        'max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded-btn border p-2 text-xs',
        mono ? 'font-mono' : 'font-sans',
        tone === 'error'
          ? 'border-feedback-error-border bg-feedback-error-bg text-feedback-error'
          : 'border-border bg-surface-secondary text-fg-default'
      )}
    >
      {text}
    </pre>
  </div>
);

/** run_workflow start input: graph (default) ⇄ JSON. Falls back to JSON when unrenderable. */
const WorkflowInputBlock: React.FC<{ input: Record<string, unknown> }> = ({ input }) => {
  const { t } = useTranslation();
  const [view, setView] = useState<'graph' | 'json'>('graph');
  const json = JSON.stringify(input, null, 2);
  const spec = useMemo(() => {
    const parsed = parseWorkflowInput(input);
    return parsed && layoutWorkflow(parsed) ? parsed : null;
  }, [input]);
  if (!spec) {
    return <DetailBlock label={t('common.inputParameters')} text={json} mono />;
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-fg-muted">{t('common.inputParameters')}</span>
        <div className="flex items-center gap-1">
          <div
            role="tablist"
            aria-label={t('tool.workflowGraph.view')}
            className="flex rounded-btn border border-border p-0.5 text-[11px]"
          >
            {(['graph', 'json'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-sm px-2 py-0.5',
                  view === v
                    ? 'bg-surface-secondary font-medium text-fg-default'
                    : 'text-fg-muted hover:text-fg-secondary'
                )}
              >
                {t(`tool.workflowGraph.${v}`)}
              </button>
            ))}
          </div>
          <CopyButton text={json} />
        </div>
      </div>
      {view === 'graph' ? (
        <WorkflowGraph spec={spec} />
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded-btn border border-border bg-surface-secondary p-2 font-mono text-xs text-fg-default">
          {json}
        </pre>
      )}
    </div>
  );
};

const ToolStepDetail: React.FC<{ step: ToolStep }> = ({ step }) => {
  const { t } = useTranslation();
  const result = step.result ? formatToolResult(step.result.content) : null;
  return (
    <div className="space-y-2">
      {step.truncated ? (
        <p className="text-xs text-fg-muted italic">
          {t('tool.steps.inputOmitted', { size: formatBytes(step.truncated.byteSize) })}
        </p>
      ) : toolBaseName(step.name) === 'run_workflow' && step.input.action === 'start' ? (
        <WorkflowInputBlock input={step.input} />
      ) : (
        Object.keys(step.input).length > 0 && (
          <DetailBlock
            label={t('common.inputParameters')}
            text={JSON.stringify(step.input, null, 2)}
            mono
          />
        )
      )}
      {step.resultTruncated ? (
        <p className="text-xs text-fg-muted italic">
          {t('tool.steps.resultOmitted', { size: formatBytes(step.resultTruncated.byteSize) })}
        </p>
      ) : (
        result && (
          <DetailBlock
            label={step.status === 'error' ? t('tool.steps.errorOutput') : t('tool.steps.output')}
            text={result.text}
            mono={result.isJson}
            tone={step.status === 'error' ? 'error' : 'default'}
          />
        )
      )}
      {!result && !step.resultTruncated && step.status === 'running' && (
        <p className="text-xs text-fg-muted">{t('tool.steps.waitingForResult')}</p>
      )}
    </div>
  );
};

const StepRow: React.FC<{ step: Step }> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { t } = useTranslation();
  const meta = useStepMeta()(step);
  const Icon = meta.icon;
  const isError = step.status === 'error';
  const summary = stepSummary(step);

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left text-xs transition-colors hover:bg-surface-secondary',
          isError ? 'text-feedback-error' : 'text-fg-secondary'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-fg-disabled motion-safe:transition-transform',
            open && 'rotate-90'
          )}
        />
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{meta.label}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            isError ? 'text-feedback-error' : 'text-fg-muted'
          )}
        >
          {summary}
        </span>
        <StatusMark step={step} />
      </button>
      {open && (
        <div id={detailId} className="mb-1.5 ml-6 mt-1">
          {step.kind === 'reasoning' ? (
            step.truncated ? (
              <p className="text-xs text-fg-muted italic">
                {t('tool.steps.reasoningOmitted', {
                  size: formatBytes(step.truncated.byteSize),
                })}
              </p>
            ) : (
              <p className="whitespace-pre-wrap wrap-break-word text-xs text-fg-muted">
                {step.text}
              </p>
            )
          ) : (
            <ToolStepDetail step={step} />
          )}
        </div>
      )}
    </li>
  );
};

interface ToolStepsGroupProps {
  steps: Step[];
  /** True while this group is the tail of a still-streaming turn. */
  isLive: boolean;
  className?: string;
}

/**
 * A consecutive run of reasoning / tool calls, folded into one summary line.
 * Expanded while the agent is working (showing only the newest steps), folded
 * once the answer starts; a manual toggle always wins over the automatic state.
 */
export const ToolStepsGroup: React.FC<ToolStepsGroupProps> = ({ steps, isLive, className }) => {
  const { t } = useTranslation();
  const getMeta = useStepMeta();
  // null = follow isLive; boolean = what the user chose.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const bodyId = useId();

  if (steps.length === 0) return null;

  // A lone step needs no summary header. Same element tree either way, so the
  // first row keeps its expanded state when a second step arrives.
  const single = steps.length === 1;
  const open = single || (manualOpen ?? isLive);
  const { failed, recovered } = summarizeSteps(steps);
  const current =
    [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  const currentMeta = getMeta(current);
  const currentSummary = stepSummary(current);
  const icons = Array.from(new Set(steps.map((s) => getMeta(s).icon))).slice(0, MAX_HEADER_ICONS);
  const hidden = isLive && !showAll ? Math.max(0, steps.length - LIVE_VISIBLE_STEPS) : 0;

  return (
    <div className={cn('not-prose', className)}>
      {single ? null : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setManualOpen(!open)}
          className="flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left text-sm text-fg-secondary transition-colors hover:bg-surface-secondary"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-fg-muted motion-safe:transition-transform',
              open && 'rotate-90'
            )}
          />
          {isLive ? (
            <>
              <Loader2 className="size-4 shrink-0 text-fg-link motion-safe:animate-spin" />
              <span aria-live="polite" className="min-w-0 flex-1 truncate">
                {currentMeta.label}
                {currentSummary && <span className="text-fg-muted">: {currentSummary}</span>}
              </span>
              <span className="shrink-0 text-xs text-fg-muted">
                {t('tool.steps.count', { count: steps.length })}
              </span>
            </>
          ) : (
            <>
              <span className="min-w-0 truncate">
                {t('tool.steps.executed', { count: steps.length })}
              </span>
              <span className="flex shrink-0 -space-x-1" aria-hidden="true">
                {icons.map((Ic, i) => (
                  <span
                    key={i}
                    className="flex size-5 items-center justify-center rounded-full border border-border bg-surface-primary text-fg-muted"
                  >
                    <Ic className="size-3" />
                  </span>
                ))}
              </span>
              {failed > 0 && (
                <span className="shrink-0 rounded-btn border border-feedback-error-border bg-feedback-error-bg px-1.5 py-0.5 text-xs text-feedback-error">
                  {t('tool.steps.failed', { count: failed })}
                </span>
              )}
              {recovered > 0 && (
                <span className="shrink-0 text-xs text-fg-muted">
                  {t('tool.steps.retried', { count: recovered })}
                </span>
              )}
            </>
          )}
        </button>
      )}
      {open && (
        <div id={bodyId} className={cn(!single && 'ml-3 mt-0.5 border-l border-border pl-2')}>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mb-0.5 rounded-btn px-1.5 py-0.5 text-xs text-fg-link hover:bg-surface-secondary"
            >
              {t('tool.steps.showEarlier', { count: hidden })}
            </button>
          )}
          <ul>
            {steps.slice(hidden).map((s) => (
              <StepRow key={s.key} step={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
