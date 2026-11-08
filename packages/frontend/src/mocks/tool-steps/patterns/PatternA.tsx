import React, { useState } from 'react';
import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  ChevronRight,
  FileEdit,
  Globe,
  LayoutDashboard,
  ListTodo,
  Loader2,
  Search,
  Terminal,
  Code2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Step, StepGroupViewProps, ToolStep } from '../types';

const LIVE_VISIBLE = 3;

interface ToolMeta {
  icon: LucideIcon;
  /** Past/neutral label, e.g. 「検索」 */
  label: string;
  /** Progressive label used for the live header, e.g. 「Web を検索中」 */
  live: string;
}

const TOOL_META: Record<string, ToolMeta> = {
  tavily_search: { icon: Search, label: '検索', live: 'Web を検索中' },
  browser: { icon: Globe, label: 'ページを閲覧', live: 'ページを閲覧中' },
  code_interpreter: { icon: Code2, label: 'コードを実行', live: 'コードを実行中' },
  file_editor: { icon: FileEdit, label: 'ファイルを編集', live: 'ファイルを編集中' },
  execute_command: { icon: Terminal, label: 'コマンドを実行', live: 'コマンドを実行中' },
  call_agent: { icon: Bot, label: 'エージェントに依頼', live: 'エージェントに依頼中' },
  todo: { icon: ListTodo, label: 'タスクを更新', live: 'タスクを更新中' },
  generate_ui: { icon: LayoutDashboard, label: 'UI を生成', live: 'UI を生成中' },
};

const REASONING_META: ToolMeta = { icon: Brain, label: '考え中', live: '考え中' };

const metaOf = (step: Step): ToolMeta =>
  step.kind === 'reasoning'
    ? REASONING_META
    : (TOOL_META[step.name] ?? { icon: Wrench, label: step.name, live: step.name });

/** One-line summary of the most telling argument. */
const argSummary = (step: Step): string => {
  if (step.kind === 'reasoning') return step.text.split('\n')[0] ?? '';
  const i = step.input;
  if (step.name === 'call_agent' && typeof i.agent === 'string') return i.agent;
  const pick = ['query', 'url', 'path', 'command', 'task', 'title', 'code', 'component'];
  for (const k of pick) {
    const v = i[k];
    if (typeof v === 'string' && v) {
      // `command` is a verb for file_editor; prefer the path there.
      if (k === 'command' && typeof i.path === 'string') continue;
      return v.split('\n')[0] ?? '';
    }
  }
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return first ?? '';
};

const fmtDuration = (ms?: number): string | undefined => {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

const isErr = (s: Step) => s.kind === 'tool' && s.status === 'error';

const countErrors = (steps: Step[]): number =>
  steps.reduce(
    (n, s) => n + (isErr(s) ? 1 : 0) + (s.kind === 'tool' && s.children ? countErrors(s.children) : 0),
    0
  );

const StatusMark: React.FC<{ step: Step }> = ({ step }) => {
  if (step.status === 'running')
    return <Loader2 className="size-3.5 shrink-0 text-action-primary motion-safe:animate-spin" aria-label="実行中" />;
  if (isErr(step)) return <AlertCircle className="size-3.5 shrink-0 text-feedback-error" aria-label="失敗" />;
  return <Check className="size-3.5 shrink-0 text-feedback-success" aria-label="完了" />;
};

const StepRow: React.FC<{ step: Step; depth?: number }> = ({ step, depth = 0 }) => {
  const [open, setOpen] = useState(false);
  const meta = metaOf(step);
  const Icon = meta.icon;
  const err = isErr(step);
  const isAgent = step.kind === 'tool' && step.name === 'call_agent';
  const children = step.kind === 'tool' ? step.children : undefined;
  const summary = argSummary(step);
  const dur = fmtDuration(step.durationMs);

  return (
    <li className={cn(depth > 0 && 'ml-4 border-l border-border pl-2')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left text-xs hover:bg-surface-secondary',
          err ? 'text-feedback-error' : 'text-fg-secondary'
        )}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-fg-disabled motion-safe:transition-transform', open && 'rotate-90')}
        />
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{isAgent ? 'サブエージェント' : meta.label}</span>
        {summary && (
          <span className={cn('min-w-0 flex-1 truncate', err ? 'text-feedback-error' : 'text-fg-muted')}>{summary}</span>
        )}
        {!summary && <span className="flex-1" />}
        {dur && <span className="shrink-0 tabular-nums text-fg-muted">{dur}</span>}
        <StatusMark step={step} />
      </button>
      {open && (
        <div className="ml-6 mt-1 mb-1.5 space-y-1.5">
          {step.kind === 'reasoning' ? (
            <p className="whitespace-pre-wrap text-xs italic text-fg-muted">{step.text}</p>
          ) : (
            <ToolDetail step={step} />
          )}
        </div>
      )}
      {open && children && children.length > 0 && (
        <ul className="mt-0.5">
          {children.map((c) => (
            <StepRow key={c.id} step={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
};

const ToolDetail: React.FC<{ step: ToolStep }> = ({ step }) => (
  <>
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-btn bg-surface-secondary p-2 font-mono text-[11px] text-fg-secondary">
      {JSON.stringify(step.input, null, 2)}
    </pre>
    {step.result !== undefined && (
      <pre
        className={cn(
          'max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-btn border p-2 font-mono text-[11px]',
          step.status === 'error'
            ? 'border-feedback-error-border bg-feedback-error-bg text-feedback-error'
            : 'border-border bg-surface-primary text-fg-secondary'
        )}
      >
        {step.result}
      </pre>
    )}
  </>
);

export const PatternA: React.FC<StepGroupViewProps> = ({ group, isLive }) => {
  // null = follow isLive automatically; boolean = user's manual intent.
  const [manual, setManual] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const steps = group.steps;

  if (steps.length === 1) {
    return (
      <ul className="my-1">
        <StepRow step={steps[0]} />
      </ul>
    );
  }

  const open = manual ?? isLive;
  const errors = countErrors(steps);
  const timed = steps.some((s) => s.durationMs !== undefined);
  const totalSec = Math.round(steps.reduce((t, s) => t + (s.durationMs ?? 0), 0) / 1000);

  const current = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  const curMeta = metaOf(current);
  const curArg = argSummary(current);

  const icons = Array.from(new Set(steps.map((s) => metaOf(s).icon))).slice(0, 4);

  const hidden = isLive && !showAll ? Math.max(0, steps.length - LIVE_VISIBLE) : 0;
  const visible = steps.slice(hidden);
  const bodyId = `pa-body-${group.id}`;

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 rounded-btn px-1.5 py-1 text-left text-sm text-fg-secondary hover:bg-surface-secondary"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-fg-muted motion-safe:transition-transform', open && 'rotate-90')}
        />
        {isLive ? (
          <>
            <Loader2 className="size-4 shrink-0 text-action-primary motion-safe:animate-spin" />
            <span aria-live="polite" className="min-w-0 flex-1 truncate">
              {curMeta.live}
              {curArg && <span className="text-fg-muted">: {curArg}</span>}
            </span>
            <span className="shrink-0 text-xs text-fg-muted">· {steps.length} ステップ</span>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">
              {steps.length} ステップを実行
              {timed && <span className="text-fg-muted"> · {totalSec} 秒</span>}
            </span>
            <span className="flex shrink-0 -space-x-1">
              {icons.map((Ic, i) => (
                <span
                  key={i}
                  className="flex size-5 items-center justify-center rounded-full border border-border bg-surface-primary text-fg-muted"
                >
                  <Ic className="size-3" />
                </span>
              ))}
            </span>
            {errors > 0 && (
              <span className="shrink-0 rounded-btn border border-feedback-error-border bg-feedback-error-bg px-1.5 py-0.5 text-xs text-feedback-error">
                {errors} 件失敗
              </span>
            )}
          </>
        )}
      </button>
      {open && (
        <div id={bodyId} className="mt-0.5 ml-3 border-l border-border pl-2">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mb-0.5 rounded-btn px-1.5 py-0.5 text-xs text-action-primary hover:bg-surface-secondary"
            >
              前の {hidden} 件を表示
            </button>
          )}
          <ul>
            {visible.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
