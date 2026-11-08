import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BarChart3, Moon, Play, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';
import { patterns, type PatternEntry } from './patterns';
import { scenarioDurationMs, scenarios, snapshotAt, type Scenario } from './scenarios';
import type { Segment } from './types';

/**
 * URL params make every state reproducible for screenshots:
 *   ?pattern=a|b|c|d|current|all  &scenario=research|single|interleaved
 *   &t=<ms>|done (frozen; omit to auto-play)  &theme=dark  &width=390
 */
const params = new URLSearchParams(window.location.search);

function useClock(running: boolean, startedAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [running]);
  return now - startedAt;
}

const UiArtifact: React.FC<{ title: string }> = ({ title }) => (
  <div className="rounded-card border border-border bg-surface-primary p-4">
    <div className="mb-3 flex items-center gap-2 text-sm font-medium text-fg-default">
      <BarChart3 className="h-4 w-4 text-action-primary" />
      {title}
    </div>
    <div className="flex h-28 items-end gap-6 px-4">
      {[61, 42, 35].map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1">
          <div className="w-full rounded-t bg-action-primary/80" style={{ height: `${v * 1.6}px` }} />
          <span className="text-xs text-fg-muted">{['金融', '製造', '小売'][i]}</span>
        </div>
      ))}
    </div>
  </div>
);

const AssistantTurn: React.FC<{
  pattern: PatternEntry;
  segments: Segment[];
  isStreaming: boolean;
}> = ({ pattern, segments, isStreaming }) => {
  const { Component } = pattern;
  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        const isTail = i === segments.length - 1;
        if (seg.type === 'text')
          return (
            <div key={seg.id} className="prose prose-sm max-w-none text-fg-default">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
            </div>
          );
        if (seg.type === 'ui') return <UiArtifact key={seg.id} title={seg.title} />;
        return <Component key={seg.group.id} group={seg.group} isLive={isStreaming && isTail} />;
      })}
      {isStreaming && segments.length === 0 && (
        <div className="text-sm text-fg-muted animate-pulse">…</div>
      )}
    </div>
  );
};

const ChatColumn: React.FC<{
  pattern: PatternEntry;
  scenario: Scenario;
  t: number;
  t0: number;
  showHeader: boolean;
}> = ({ pattern, scenario, t, t0, showHeader }) => {
  const { segments, isStreaming } = useMemo(() => snapshotAt(scenario, t, t0), [scenario, t, t0]);
  return (
    <section className="flex min-w-0 flex-col gap-4" data-pattern={pattern.id}>
      {showHeader && (
        <header>
          <h2 className="text-sm font-semibold text-fg-default">{pattern.name}</h2>
          <p className="text-xs text-fg-muted">{pattern.summary}</p>
        </header>
      )}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-card-lg bg-action-primary px-4 py-2 text-sm text-action-primary-fg">
          {scenario.userPrompt}
        </div>
      </div>
      <AssistantTurn pattern={pattern} segments={segments} isStreaming={isStreaming} />
    </section>
  );
};

export const MockPage: React.FC = () => {
  const [patternId, setPatternId] = useState(params.get('pattern') ?? 'a');
  const [scenarioId, setScenarioId] = useState(params.get('scenario') ?? 'research');
  const [theme, setTheme] = useState<'light' | 'dark'>(
    params.get('theme') === 'dark' ? 'dark' : 'light'
  );
  const [speed, setSpeed] = useState(Number(params.get('speed') ?? 1));
  const frozen = params.get('t');
  const [run, setRun] = useState(() => ({ startedAt: Date.now(), playing: frozen === null, done: frozen === 'done' }));
  const width = params.get('width');

  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
  const total = scenarioDurationMs(scenario);
  const elapsed = useClock(run.playing, run.startedAt) * speed;
  const t = run.done ? Infinity : frozen !== null ? Number(frozen) : elapsed;
  const playing = run.playing && t < total;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const replay = () => setRun({ startedAt: Date.now(), playing: true, done: false });
  const visible = patternId === 'all' ? patterns : patterns.filter((p) => p.id === patternId);

  return (
    <div className="min-h-screen bg-surface-secondary text-fg-default">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-surface-primary px-4 py-2 text-sm">
        <div className="flex flex-wrap gap-1" role="tablist">
          {[...patterns, { id: 'all', name: '並べて比較' } as PatternEntry].map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={patternId === p.id}
              onClick={() => setPatternId(p.id)}
              className={cn(
                'rounded-btn px-2.5 py-1 text-xs',
                patternId === p.id
                  ? 'bg-action-primary text-action-primary-fg'
                  : 'text-fg-secondary hover:bg-surface-secondary'
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
        <select
          value={scenarioId}
          onChange={(e) => {
            setScenarioId(e.target.value);
            replay();
          }}
          className="ml-auto rounded-input border border-border bg-surface-primary px-2 py-1 text-xs"
        >
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="rounded-input border border-border bg-surface-primary px-2 py-1 text-xs"
        >
          {[1, 2, 4].map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
        <button
          onClick={replay}
          className="flex items-center gap-1 rounded-btn border border-border px-2 py-1 text-xs hover:bg-surface-secondary"
        >
          <Play className="h-3 w-3" />
          {playing ? `再生中 ${(Math.min(t, total) / 1000).toFixed(1)}s` : '再生'}
        </button>
        <button
          onClick={() => setRun((r) => ({ ...r, playing: false, done: true }))}
          className="rounded-btn border border-border px-2 py-1 text-xs hover:bg-surface-secondary"
        >
          完了状態
        </button>
        <button
          aria-label="toggle theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="rounded-btn border border-border p-1.5 hover:bg-surface-secondary"
        >
          {theme === 'dark' ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
        </button>
      </div>

      <main
        className={cn(
          'mx-auto p-6',
          patternId === 'all' ? 'grid max-w-[1600px] gap-8 lg:grid-cols-2 2xl:grid-cols-3' : 'max-w-3xl'
        )}
        style={width ? { maxWidth: `${width}px` } : undefined}
      >
        {visible.map((p) => (
          <ChatColumn
            key={`${p.id}-${scenario.id}-${run.startedAt}`}
            pattern={p}
            scenario={scenario}
            t={t}
            t0={run.startedAt}
            showHeader={patternId === 'all'}
          />
        ))}
      </main>
    </div>
  );
};
