import React, { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Brain, Check, ChevronRight, Loader2, Search, Wrench, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { Step, StepGroupViewProps, StepStatus } from '../types';

// Module-level store: only one inspector may be open across all groups.
let openGroupId: string | null = null;
const listeners = new Set<() => void>();
const setOpenGroup = (id: string | null) => {
  if (openGroupId === id) return;
  openGroupId = id;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getOpenGroup = () => openGroupId;

interface FlatStep {
  step: Step;
  depth: number;
}

const flatten = (steps: Step[], depth = 0): FlatStep[] =>
  steps.flatMap((step) => [
    { step, depth },
    ...(step.kind === 'tool' && step.children ? flatten(step.children, depth + 1) : []),
  ]);

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const argSummary = (step: Step): string => {
  if (step.kind === 'reasoning') return truncate(step.text.replace(/\s+/g, ' '), 80);
  const first = Object.values(step.input).find((v) => typeof v === 'string') as string | undefined;
  return truncate(first ?? JSON.stringify(step.input), 80);
};

const stepLabel = (step: Step): string => (step.kind === 'reasoning' ? '思考' : step.name);

const formatDuration = (ms?: number): string | null => {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

const statusOf = (s: Step): StepStatus => s.status;

const segmentClass: Record<StepStatus, string> = {
  completed: 'bg-feedback-success',
  error: 'bg-feedback-error',
  running: 'bg-action-primary motion-safe:animate-pulse',
};

const StepIcon: React.FC<{ step: Step; className?: string }> = ({ step, className }) => {
  if (step.status === 'running')
    return <Loader2 className={cn('motion-safe:animate-spin text-action-primary', className)} aria-hidden />;
  if (step.status === 'error') return <AlertCircle className={cn('text-feedback-error', className)} aria-hidden />;
  const Icon = step.kind === 'reasoning' ? Brain : Wrench;
  return <Icon className={cn('text-fg-muted', className)} aria-hidden />;
};

const FILTERS = [
  { key: 'all', label: 'すべて' },
  { key: 'tool', label: 'ツール' },
  { key: 'reasoning', label: '思考' },
  { key: 'error', label: 'エラー' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const matches = (step: Step, filter: FilterKey, q: string): boolean => {
  if (filter === 'tool' && step.kind !== 'tool') return false;
  if (filter === 'reasoning' && step.kind !== 'reasoning') return false;
  if (filter === 'error' && step.status !== 'error') return false;
  if (!q) return true;
  const hay = step.kind === 'tool' ? `${step.name} ${JSON.stringify(step.input)}` : step.text;
  return hay.toLowerCase().includes(q.toLowerCase());
};

const Detail: React.FC<{ step: Step }> = ({ step }) => (
  <div className="space-y-2 text-xs">
    <div className="flex items-center gap-2 font-medium text-fg-default">
      <StepIcon step={step} className="size-3.5" />
      <span className="truncate">{stepLabel(step)}</span>
      {formatDuration(step.durationMs) && <span className="text-fg-muted">{formatDuration(step.durationMs)}</span>}
    </div>
    {step.kind === 'tool' ? (
      <>
        <div>
          <div className="mb-1 text-fg-muted">入力</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-btn border border-border bg-surface-secondary p-2 font-mono text-fg-secondary">
            {JSON.stringify(step.input, null, 2)}
          </pre>
        </div>
        <div>
          <div className="mb-1 text-fg-muted">結果</div>
          {step.result === undefined ? (
            <div className="text-fg-muted">実行中…</div>
          ) : (
            <pre
              className={cn(
                'max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-btn border p-2 font-mono',
                step.status === 'error'
                  ? 'border-feedback-error-border bg-feedback-error-bg text-feedback-error'
                  : 'border-border bg-surface-secondary text-fg-secondary'
              )}
            >
              {step.result}
            </pre>
          )}
        </div>
      </>
    ) : (
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-btn border border-border bg-surface-secondary p-2 font-mono text-fg-secondary">
        {step.text}
      </pre>
    )}
  </div>
);

interface InspectorProps {
  flat: FlatStep[];
  isLive: boolean;
  onClose: () => void;
  titleId: string;
}

const Inspector: React.FC<InspectorProps> = ({ flat, isLive, onClose, titleId }) => {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => flat.filter((f) => matches(f.step, filter, query)), [flat, filter, query]);
  const errorCount = flat.filter((f) => f.step.status === 'error').length;
  const totalMs = flat.reduce((sum, f) => sum + (f.depth === 0 ? (f.step.durationMs ?? 0) : 0), 0);
  const hasTiming = flat.some((f) => f.step.durationMs !== undefined);

  const following = isLive && selectedId === null;
  const selected =
    flat.find((f) => f.step.id === selectedId)?.step ?? (following ? visible[visible.length - 1]?.step : undefined);

  useEffect(() => {
    if (following && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [following, visible.length]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface-primary shadow-elevation-3 outline-none md:w-[420px]"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold text-fg-default">
            ステップ詳細
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            {flat.length} ステップ
            {hasTiming && ` · ${formatDuration(totalMs)}`}
            {errorCount > 0 && <span className="text-feedback-error"> · エラー {errorCount}</span>}
            {isLive && ' · 実行中'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="rounded-btn p-1.5 text-fg-muted hover:bg-surface-secondary hover:text-fg-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="space-y-2 border-b border-border px-4 py-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="フィルター">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded-btn border px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-primary',
                filter === f.key
                  ? 'border-action-primary bg-surface-secondary text-action-primary'
                  : 'border-border text-fg-secondary hover:bg-surface-secondary'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 rounded-btn border border-border bg-surface-primary px-2 py-1 text-xs focus-within:border-border-strong">
          <Search className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ツール名・引数で検索"
            aria-label="ステップを検索"
            className="min-w-0 flex-1 bg-transparent text-fg-default outline-none placeholder:text-fg-disabled"
          />
        </label>
      </div>

      <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1" aria-live={isLive ? 'polite' : undefined}>
        {visible.length === 0 && <li className="px-4 py-6 text-center text-xs text-fg-muted">該当するステップはありません</li>}
        {visible.map(({ step, depth }) => {
          const isSel = selected?.id === step.id;
          const dur = formatDuration(step.durationMs);
          return (
            <li key={step.id}>
              <button
                type="button"
                aria-current={isSel || undefined}
                onClick={() => setSelectedId(selectedId === step.id ? null : step.id)}
                style={{ paddingLeft: 16 + depth * 16 }}
                className={cn(
                  'flex w-full items-center gap-2 py-1.5 pr-4 text-left text-xs focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action-primary',
                  isSel ? 'bg-surface-secondary' : 'hover:bg-surface-secondary',
                  depth > 0 && 'border-l-2 border-border-strong'
                )}
              >
                <StepIcon step={step} className="size-3.5 shrink-0" />
                <span className={cn('shrink-0 font-medium', step.status === 'error' ? 'text-feedback-error' : 'text-fg-default')}>
                  {stepLabel(step)}
                </span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{argSummary(step)}</span>
                {dur && <span className="shrink-0 tabular-nums text-fg-disabled">{dur}</span>}
                <span className="sr-only">
                  {step.status === 'running' ? '実行中' : step.status === 'error' ? 'エラー' : '完了'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <section
        aria-label="選択中のステップ"
        className="max-h-[50%] min-h-[96px] shrink-0 overflow-y-auto border-t border-border-strong bg-surface-elevated px-4 py-3"
      >
        {selected ? <Detail step={selected} /> : <p className="text-xs text-fg-muted">ステップを選択すると入力と結果を表示します</p>}
      </section>
    </div>,
    document.body
  );
};

export const PatternD: React.FC<StepGroupViewProps> = ({ group, isLive }) => {
  const openId = useSyncExternalStore(subscribe, getOpenGroup, getOpenGroup);
  const isOpen = openId === group.id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();

  const flat = useMemo(() => flatten(group.steps), [group.steps]);
  const errorCount = flat.filter((f) => f.step.status === 'error').length;
  const single = flat.length === 1;

  const close = useCallback(() => setOpenGroup(null), []);

  useEffect(() => {
    if (wasOpen.current && !isOpen) triggerRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);

  // Unmounting while open (e.g. scenario replay) must not leave a dangling id.
  useEffect(
    () => () => {
      if (openGroupId === group.id) setOpenGroup(null);
    },
    [group.id]
  );

  const current = [...flat].reverse().find((f) => f.step.status === 'running')?.step ?? flat[flat.length - 1]?.step;
  const currentText = current ? `${stepLabel(current)}${current.kind === 'tool' ? ': ' : ' '}${argSummary(current)}` : '';

  return (
    <div className="my-1 max-w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setOpenGroup(isOpen ? null : group.id)}
        className="group flex w-full max-w-full flex-col items-start gap-1 rounded-btn px-1 py-1 text-left hover:bg-surface-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-primary"
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-xs text-fg-secondary" aria-live="polite">
          {isLive ? (
            <Loader2 className="size-3.5 shrink-0 text-action-primary motion-safe:animate-spin" aria-hidden />
          ) : (
            <Check className="size-3.5 shrink-0 text-feedback-success" aria-hidden />
          )}
          {isLive ? (
            <span className="min-w-0 truncate">
              作業中{!single && ` · ${flat.length} ステップ`} · {truncate(currentText, 60)}
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {single ? truncate(currentText, 60) : `${flat.length} ステップ実行`}
              {errorCount > 0 && <span className="text-feedback-error"> · エラー {errorCount}</span>}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center text-fg-muted group-hover:text-fg-default">
            {!isLive && '詳細'}
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        </span>
        {!single && (
          <span className="flex h-1 w-full max-w-[240px] gap-px" aria-hidden>
            {flat.map(({ step }) => (
              <span key={step.id} className={cn('h-full min-w-px flex-1 rounded-sm', segmentClass[statusOf(step)])} />
            ))}
          </span>
        )}
      </button>
      {isOpen && <Inspector flat={flat} isLive={isLive} onClose={close} titleId={titleId} />}
    </div>
  );
};
