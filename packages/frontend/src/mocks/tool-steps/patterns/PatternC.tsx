import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Brain,
  ChevronRight,
  Code2,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Search,
  Terminal,
  Wrench,
  LayoutDashboard,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Step, StepGroupViewProps, ToolStep } from '../types';

const ALL = '__all__';

const LABELS: Record<string, string> = {
  tavily_search: '検索',
  browser: '閲覧',
  code_interpreter: 'コード',
  file_editor: 'ファイル',
  execute_command: 'コマンド',
  call_agent: 'エージェント',
  todo: 'ToDo',
  generate_ui: 'UI',
  reasoning: '思考',
};

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  tavily_search: Search,
  browser: Globe,
  code_interpreter: Code2,
  file_editor: FileText,
  execute_command: Terminal,
  call_agent: Bot,
  todo: ListChecks,
  generate_ui: LayoutDashboard,
  reasoning: Brain,
};

const keyOf = (s: Step) => (s.kind === 'reasoning' ? 'reasoning' : s.name);
const labelOf = (k: string) => LABELS[k] ?? k;
const ToolIcon: React.FC<{ k: string; className?: string }> = ({ k, className }) =>
  React.createElement(ICONS[k] ?? Wrench, { className });

const firstString = (input: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
};

const summarize = (s: Step): string => {
  if (s.kind === 'reasoning') return s.text.split('\n')[0];
  const v =
    firstString(s.input, ['url', 'query', 'command', 'path', 'task', 'title', 'component', 'code']) ??
    JSON.stringify(s.input);
  const line = v.split('\n')[0];
  if (s.name === 'file_editor' && typeof s.input.command === 'string' && typeof s.input.path === 'string') {
    return `${s.input.command} ${s.input.path}`;
  }
  return line;
};

const runningVerb = (s: Step): string => {
  if (s.kind === 'reasoning') return '考え中';
  switch (s.name) {
    case 'browser':
      return 'ページを閲覧中';
    case 'tavily_search':
      return '検索中';
    case 'code_interpreter':
      return 'コードを実行中';
    case 'execute_command':
      return 'コマンドを実行中';
    case 'file_editor':
      return 'ファイルを編集中';
    case 'call_agent':
      return 'エージェントに依頼中';
    default:
      return `${labelOf(s.name)}を実行中`;
  }
};

const fmtDuration = (ms?: number) =>
  ms === undefined ? null : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const hasError = (s: Step) => s.kind === 'tool' && s.status === 'error';

const StatusMark: React.FC<{ step: Step }> = ({ step }) => {
  if (step.status === 'running')
    return <Loader2 className="size-3 shrink-0 animate-spin text-action-primary" aria-label="実行中" />;
  if (step.status === 'error')
    return <AlertCircle className="size-3 shrink-0 text-feedback-error" aria-label="失敗" />;
  return null;
};

const StepItem: React.FC<{ step: Step; depth?: number; showTool?: boolean }> = ({
  step,
  depth = 0,
  showTool,
}) => {
  const [open, setOpen] = useState(false);
  const k = keyOf(step);
  const dur = fmtDuration(step.durationMs);
  const children = step.kind === 'tool' ? step.children : undefined;
  const panelId = `c-${step.id}`;
  return (
    <li className={cn(depth > 0 && 'ml-4 border-l border-border pl-2')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-btn px-1 py-0.5 text-left text-xs hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-primary"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-fg-muted transition-transform', open && 'rotate-90')} />
        {showTool && (
          <span className="flex shrink-0 items-center gap-1 text-fg-secondary">
            <ToolIcon k={k} className="size-3" />
            {labelOf(k)}
          </span>
        )}
        <span className={cn('min-w-0 flex-1 truncate', step.status === 'error' ? 'text-feedback-error' : 'text-fg-muted')}>
          {summarize(step)}
        </span>
        {dur && <span className="shrink-0 tabular-nums text-fg-disabled">{dur}</span>}
        <StatusMark step={step} />
      </button>
      {open && (
        <div id={panelId} className="mb-1 ml-5 mt-0.5 space-y-1">
          {step.kind === 'reasoning' ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-btn bg-surface-secondary p-2 text-xs text-fg-secondary">
              {step.text}
            </pre>
          ) : (
            <>
              <pre className="max-h-48 overflow-auto rounded-btn bg-surface-secondary p-2 text-xs text-fg-secondary">
                {JSON.stringify(step.input, null, 2)}
              </pre>
              {step.result !== undefined && (
                <pre
                  className={cn(
                    'max-h-48 overflow-auto whitespace-pre-wrap rounded-btn border p-2 text-xs',
                    step.status === 'error'
                      ? 'border-feedback-error-border bg-feedback-error-bg text-feedback-error'
                      : 'border-border bg-surface-primary text-fg-secondary'
                  )}
                >
                  {step.result}
                </pre>
              )}
            </>
          )}
        </div>
      )}
      {children && children.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {children.map((c) => (
            <StepItem key={c.id} step={c} depth={depth + 1} showTool />
          ))}
        </ul>
      )}
    </li>
  );
};

export const PatternC: React.FC<StepGroupViewProps> = ({ group, isLive }) => {
  const [openKey, setOpenKey] = useState<string | null>(null);

  const chips = useMemo(() => {
    const map = new Map<string, Step[]>();
    for (const s of group.steps) {
      const k = keyOf(s);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()].map(([key, steps]) => ({ key, steps }));
  }, [group.steps]);

  const current: Step | undefined = isLive
    ? [...group.steps].reverse().find((s) => s.status === 'running')
    : undefined;
  const currentKey = current ? keyOf(current) : null;

  const toggle = (k: string) => setOpenKey((o) => (o === k ? null : k));
  const openSteps = openKey === ALL ? group.steps : chips.find((c) => c.key === openKey)?.steps;

  const chipBase =
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-primary';

  const renderChip = (k: string, steps: Step[] | null) => {
    const isAll = steps === null;
    const list = steps ?? group.steps;
    const errors = list.filter(hasError).length;
    const active = openKey === k;
    const running = !isAll && currentKey === k;
    return (
      <button
        key={k}
        type="button"
        aria-expanded={active}
        aria-controls="pattern-c-tray"
        onClick={() => toggle(k)}
        className={cn(
          chipBase,
          active
            ? 'border-border-strong bg-surface-elevated text-fg-default'
            : 'border-border bg-surface-secondary text-fg-secondary hover:border-border-strong',
          running && 'motion-safe:animate-pulse border-action-primary'
        )}
      >
        {running ? (
          <Loader2 className="size-3 animate-spin text-action-primary" aria-hidden />
        ) : (
          !isAll && <ToolIcon k={k} className="size-3" />
        )}
        <span>{isAll ? 'すべて' : labelOf(k)}</span>
        <span className="tabular-nums text-fg-muted">
          {isAll ? `(${list.length})` : list.length}
          {errors > 0 && !isAll && <span className="text-feedback-error"> · {errors} 失敗</span>}
        </span>
        {errors > 0 && (
          <span className="size-1.5 rounded-full bg-feedback-error" role="img" aria-label="エラーあり" />
        )}
      </button>
    );
  };

  return (
    <div className="my-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => renderChip(c.key, c.steps))}
        {group.steps.length > 1 && renderChip(ALL, null)}
      </div>
      <div aria-live="polite" className="min-h-0">
        {current && (
          <p className="mt-1 truncate text-xs text-fg-muted">
            {runningVerb(current)}
            {current.kind === 'tool' ? `: ${summarize(current)}` : ''}
          </p>
        )}
      </div>
      {openSteps && (
        <ul
          id="pattern-c-tray"
          className="mt-1 max-h-80 space-y-0.5 overflow-auto rounded-card border border-border bg-surface-primary p-1.5"
        >
          {openSteps.map((s) => (
            <StepItem key={s.id} step={s as ToolStep | Step} showTool={openKey === ALL} />
          ))}
        </ul>
      )}
    </div>
  );
};
