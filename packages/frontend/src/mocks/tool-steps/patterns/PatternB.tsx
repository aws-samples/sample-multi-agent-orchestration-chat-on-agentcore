import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Brain, Check, ChevronDown, ChevronRight, Loader2, MoreHorizontal } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { ReasoningStep, Step, StepGroupViewProps, StepStatus, ToolStep } from '../types';

const WINDOW_SIZE = 4;

type Entry =
  | { kind: 'reasoning'; id: string; step: ReasoningStep }
  | { kind: 'tool'; id: string; name: string; steps: ToolStep[] };

const TOOL_LABELS: Record<string, string> = {
  tavily_search: '検索',
  browser: 'ブラウザ',
  code_interpreter: 'コード実行',
  execute_command: 'コマンド',
  file_editor: 'ファイル編集',
  call_agent: 'サブエージェント',
  generate_ui: 'UI 生成',
  todo: 'TODO',
};
const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/** Consecutive tool steps with the same name collapse into one entry. */
const buildEntries = (steps: Step[]): Entry[] => {
  const entries: Entry[] = [];
  for (const step of steps) {
    if (step.kind === 'reasoning') {
      entries.push({ kind: 'reasoning', id: step.id, step });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last?.kind === 'tool' && last.name === step.name) last.steps.push(step);
    else entries.push({ kind: 'tool', id: step.id, name: step.name, steps: [step] });
  }
  return entries;
};

const entryStatus = (e: Entry): StepStatus => {
  if (e.kind === 'reasoning') return e.step.status;
  if (e.steps.some((s) => s.status === 'running')) return 'running';
  return e.steps[e.steps.length - 1].status === 'error' ? 'error' : 'completed';
};

/** An error step is "recovered" when a later step of the same tool completed. */
const countErrors = (steps: Step[]) => {
  let errors = 0;
  let recovered = 0;
  steps.forEach((s, i) => {
    if (s.kind !== 'tool' || s.status !== 'error') return;
    errors++;
    if (steps.slice(i + 1).some((n) => n.kind === 'tool' && n.name === s.name && n.status === 'completed')) {
      recovered++;
    }
  });
  return { errors, recovered };
};

const summarize = (steps: Step[]) => {
  const { errors, recovered } = countErrors(steps);
  const base = `${steps.length} ステップ`;
  if (errors === 0) return `${base} · 完了`;
  if (recovered === errors) return `${base} · ${errors} 件エラー（再試行で回復）`;
  if (recovered === 0) return `${base} · ${errors} 件エラー`;
  return `${base} · ${errors} 件エラー（${recovered} 件は再試行で回復）`;
};

const firstLine = (text: string) => text.trim().split('\n')[0] || '…';

const inputSummary = (input: Record<string, unknown>) => {
  const str = Object.values(input).find((v): v is string => typeof v === 'string');
  const text = str ?? JSON.stringify(input);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
};

const formatDuration = (ms?: number) =>
  ms === undefined ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const StatusIcon: React.FC<{ status: StepStatus; className?: string }> = ({ status, className }) => {
  if (status === 'running') return <Loader2 className={cn('motion-safe:animate-spin', className)} aria-hidden />;
  if (status === 'error') return <AlertCircle className={className} aria-hidden />;
  return <Check className={className} aria-hidden />;
};

const statusLabel: Record<StepStatus, string> = { running: '実行中', completed: '完了', error: 'エラー' };

const Node: React.FC<{ status: StepStatus; reasoning?: boolean }> = ({ status, reasoning }) => (
  <span
    className={cn(
      'absolute left-0 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border bg-surface-primary',
      status === 'running' && 'border-action-primary text-action-primary motion-safe:animate-pulse',
      status === 'error' && 'border-feedback-error-border bg-feedback-error-bg text-feedback-error',
      status === 'completed' && 'border-border-strong text-fg-muted'
    )}
  >
    {reasoning && status === 'completed' ? (
      <Brain className="h-2 w-2" aria-hidden />
    ) : (
      <StatusIcon status={status} className="h-2 w-2" />
    )}
  </span>
);

const Detail: React.FC<{ step: ToolStep }> = ({ step }) => (
  <div className="mt-1 space-y-1.5">
    <pre className="max-h-40 overflow-auto rounded-btn bg-surface-secondary p-2 text-xs text-fg-secondary">
      {JSON.stringify(step.input, null, 2)}
    </pre>
    {step.result !== undefined && (
      <pre
        className={cn(
          'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-btn p-2 text-xs',
          step.status === 'error'
            ? 'border border-feedback-error-border bg-feedback-error-bg text-feedback-error'
            : 'bg-surface-secondary text-fg-secondary'
        )}
      >
        {step.result}
      </pre>
    )}
    {step.children && step.children.length > 0 && (
      <div className="pt-1">
        <Timeline steps={step.children} live={step.status === 'running'} nested />
      </div>
    )}
  </div>
);

const Meta: React.FC<{ ms?: number }> = ({ ms }) => {
  const d = formatDuration(ms);
  return d ? <span className="shrink-0 text-xs tabular-nums text-fg-disabled">{d}</span> : null;
};

/** A single call inside a bundled entry: muted line, expandable. */
const SubCall: React.FC<{ step: ToolStep }> = ({ step }) => {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-btn py-0.5 text-left text-xs text-fg-muted hover:text-fg-secondary"
      >
        <StatusIcon
          status={step.status}
          className={cn('h-3 w-3 shrink-0', step.status === 'error' && 'text-feedback-error')}
        />
        <span className={cn('min-w-0 flex-1 truncate', step.status === 'error' && 'text-feedback-error')}>
          {inputSummary(step.input)}
        </span>
        <Meta ms={step.durationMs} />
      </button>
      {open && (
        <div className="pl-4">
          <Detail step={step} />
        </div>
      )}
    </li>
  );
};

const EntryRow: React.FC<{ entry: Entry; nested?: boolean }> = ({ entry, nested }) => {
  const [open, setOpen] = useState(false);
  const status = entryStatus(entry);
  const isBundle = entry.kind === 'tool' && entry.steps.length > 1;

  let label: string;
  let sub: string | null = null;
  let ms: number | undefined;
  if (entry.kind === 'reasoning') {
    label = '思考';
    sub = firstLine(entry.step.text);
    ms = entry.step.durationMs;
  } else {
    label = isBundle ? `${toolLabel(entry.name)} ×${entry.steps.length}` : toolLabel(entry.name);
    if (!isBundle) sub = inputSummary(entry.steps[0].input);
    else if (entry.steps.some((s) => s.status === 'error') && status !== 'error') sub = '再試行で回復';
    if (!isBundle) ms = entry.steps[0].durationMs;
  }

  return (
    <li className="relative pl-6">
      <Node status={status} reasoning={entry.kind === 'reasoning'} />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-btn text-left text-sm hover:bg-surface-secondary"
      >
        <span
          className={cn(
            'shrink-0 font-medium',
            status === 'error' ? 'text-feedback-error' : 'text-fg-default',
            nested && 'text-xs'
          )}
        >
          {label}
        </span>
        {sub && <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{sub}</span>}
        {!sub && <span className="flex-1" />}
        <Meta ms={ms} />
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden />
        )}
      </button>
      {open && entry.kind === 'reasoning' && (
        <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-fg-secondary">
          {entry.step.text}
        </p>
      )}
      {open && entry.kind === 'tool' && !isBundle && <Detail step={entry.steps[0]} />}
      {open && isBundle && (
        <ul className="mt-0.5 space-y-0.5">
          {(entry as Extract<Entry, { kind: 'tool' }>).steps.map((s) => (
            <SubCall key={s.id} step={s} />
          ))}
        </ul>
      )}
    </li>
  );
};

const Timeline: React.FC<{ steps: Step[]; live: boolean; nested?: boolean }> = ({ steps, live, nested }) => {
  const entries = useMemo(() => buildEntries(steps), [steps]);
  const [showAll, setShowAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const windowed = !nested && !showAll && entries.length > WINDOW_SIZE;
  const visible = windowed ? entries.slice(-WINDOW_SIZE) : entries;
  const hiddenSteps = windowed
    ? entries
        .slice(0, entries.length - WINDOW_SIZE)
        .reduce((n, e) => n + (e.kind === 'tool' ? e.steps.length : 1), 0)
    : 0;

  const tail = entries[entries.length - 1];
  const tailStatus = tail ? entryStatus(tail) : 'completed';
  // Scroll the container itself (not scrollIntoView) so the page never jumps.
  useEffect(() => {
    const el = scrollRef.current;
    if (live && !nested && el) el.scrollTop = el.scrollHeight;
  }, [live, nested, entries.length, tailStatus]);

  return (
    <div
      ref={scrollRef}
      className={cn(!nested && 'max-h-[28rem] overflow-y-auto overscroll-contain')}
    >
      <ul className="relative space-y-1.5 before:absolute before:bottom-2 before:left-[6px] before:top-2 before:w-px before:bg-border">
        {windowed && (
          <li className="relative pl-6">
            <span className="absolute left-0 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-dashed border-border-strong bg-surface-primary text-fg-muted">
              <MoreHorizontal className="h-2 w-2" aria-hidden />
            </span>
            <button
              type="button"
              aria-expanded={false}
              onClick={() => setShowAll(true)}
              className="rounded-btn border-b border-dashed border-border-strong text-xs text-fg-muted hover:text-fg-secondary"
            >
              さらに {hiddenSteps} 件のステップ
            </button>
          </li>
        )}
        {visible.map((e) => (
          <EntryRow key={e.id} entry={e} nested={nested} />
        ))}
      </ul>
    </div>
  );
};

export const PatternB: React.FC<StepGroupViewProps> = ({ group, isLive }) => {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? isLive;
  const { steps } = group;

  if (steps.length === 1) {
    return <Timeline steps={steps} live={isLive} />;
  }

  const tail = buildEntries(steps).slice(-1)[0];
  const liveText = tail
    ? `${tail.kind === 'reasoning' ? '思考' : toolLabel(tail.name)}: ${statusLabel[entryStatus(tail)]}`
    : '';

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-1.5 rounded-btn text-left text-xs text-fg-secondary hover:text-fg-default"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span className="font-medium">作業ログ · {steps.length} ステップ</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {isLive ? liveText : '作業完了'}
      </span>
      {open ? (
        <div className="mt-1.5">
          <Timeline steps={steps} live={isLive} />
        </div>
      ) : (
        <p className="pl-5 text-xs text-fg-muted">
          {isLive ? `実行中 · ${liveText}` : summarize(steps)}
        </p>
      )}
    </div>
  );
};
