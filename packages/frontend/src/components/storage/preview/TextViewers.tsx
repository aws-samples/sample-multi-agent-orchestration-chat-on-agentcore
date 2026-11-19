import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Braces, WrapText } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useThemeStore } from '../../../stores/themeStore';
import { parseDelimited } from '../../../utils/csv';
import { createMarkdownComponents, resolveStorageHref } from '../../markdown/markdownComponents';
import { storageDirname } from '../../../utils/storagePath';
import { useTruncatedNotice } from './useTruncatedNotice';

/** Above this, Prism highlighting (one DOM node per token) gets sluggish. */
const HIGHLIGHT_MAX_CHARS = 200_000;
const CSV_MAX_ROWS = 1000;

// ---------------------------------------------------------------------------
// Frame: optional toolbar + truncation notice around a scrollable body
// ---------------------------------------------------------------------------

export function ToolbarToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-feedback-info-bg text-fg-link' : 'text-fg-secondary hover:bg-surface-secondary'
      )}
    >
      {children}
    </button>
  );
}

/**
 * Rendered ⇄ source as one segmented control rather than two independent
 * toggles, so it reads as "pick one view".
 */
export function ViewModeSwitch({
  showSource,
  onChange,
  renderedLabel,
}: {
  showSource: boolean;
  onChange: (showSource: boolean) => void;
  renderedLabel: string;
}) {
  const { t } = useTranslation();
  const options = [
    { source: false, label: renderedLabel },
    { source: true, label: t('storage.preview.source') },
  ];
  return (
    <div
      role="group"
      aria-label={t('storage.preview.viewMode')}
      className="inline-flex rounded-md border border-border bg-surface-subtle p-0.5"
    >
      {options.map((o) => {
        const active = o.source === showSource;
        return (
          <button
            key={String(o.source)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.source)}
            className={cn(
              'rounded px-2.5 py-0.5 text-xs transition-colors',
              active
                ? 'bg-surface-elevated font-medium text-fg-default shadow-sm'
                : 'text-fg-secondary hover:text-fg-default'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function TextFrame({
  toolbar,
  notice,
  children,
  className,
}: {
  toolbar?: React.ReactNode;
  notice?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface-primary">
        {(toolbar || notice) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            {notice && <span className="text-xs text-feedback-warning">{notice}</span>}
            <div className="ml-auto flex items-center gap-1">{toolbar}</div>
          </div>
        )}
        {/* Focusable so a click hands ←/→ scrolling to it (see usePreviewNavigation). */}
        <div
          data-preview-viewer=""
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto focus:outline-hidden"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code / plain text / logs
// ---------------------------------------------------------------------------

export interface TextContentProps {
  text: string;
  truncated: boolean;
  className?: string;
}

export function CodeView({
  text,
  language,
  wrap,
}: {
  text: string;
  language?: string;
  wrap: boolean;
}) {
  const isDark = useThemeStore((s) => s.resolvedTheme) === 'dark';
  const theme = isDark ? oneDark : oneLight;
  if (!language || text.length > HIGHLIGHT_MAX_CHARS) {
    return (
      <pre
        className={cn(
          'p-3 font-mono text-xs leading-relaxed text-fg-default',
          wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
        )}
      >
        {text}
      </pre>
    );
  }
  return (
    <SyntaxHighlighter
      language={language}
      style={theme}
      showLineNumbers
      wrapLongLines={wrap}
      customStyle={{ margin: 0, background: 'transparent', fontSize: '0.75rem', minHeight: '100%' }}
      // The theme also paints the inner <code>, which only spans the text width.
      codeTagProps={{
        className: `language-${language}`,
        style: { ...theme['code[class*="language-"]'], background: 'transparent' },
      }}
      lineNumberStyle={{ minWidth: '3em', opacity: 0.5 }}
    >
      {text}
    </SyntaxHighlighter>
  );
}

export function CodeViewer({
  text,
  truncated,
  language,
  className,
}: TextContentProps & { language?: string }) {
  const { t } = useTranslation();
  const notice = useTruncatedNotice(truncated);
  // Logs and prose read better wrapped; code keeps its columns.
  const [wrap, setWrap] = useState(!language);
  const pretty = useMemo(() => {
    if (language !== 'json' || truncated) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null; // JSON Lines or invalid JSON: show as-is.
    }
  }, [language, text, truncated]);
  const [formatJson, setFormatJson] = useState(true);
  const shown = pretty !== null && formatJson ? pretty : text;

  return (
    <TextFrame
      className={className}
      notice={notice}
      toolbar={
        <>
          {pretty !== null && (
            <ToolbarToggle active={formatJson} onClick={() => setFormatJson((v) => !v)}>
              <Braces className="h-3.5 w-3.5" />
              {t('storage.preview.formatJson')}
            </ToolbarToggle>
          )}
          <ToolbarToggle active={wrap} onClick={() => setWrap((v) => !v)}>
            <WrapText className="h-3.5 w-3.5" />
            {t('storage.preview.wrap')}
          </ToolbarToggle>
        </>
      }
    >
      <CodeView text={shown} language={language} wrap={wrap} />
    </TextFrame>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function MarkdownViewer({
  text,
  truncated,
  path,
  onOpenFile,
  className,
}: TextContentProps & { path: string; onOpenFile?: (path: string) => void }) {
  const { t } = useTranslation();
  const notice = useTruncatedNotice(truncated);
  const isDark = useThemeStore((s) => s.resolvedTheme) === 'dark';
  const [showSource, setShowSource] = useState(false);
  const baseDir = storageDirname(path);
  const components = useMemo(
    () =>
      createMarkdownComponents({
        isDark,
        toStoragePath: (h) => resolveStorageHref(h, baseDir),
        onOpenFile,
      }),
    [isDark, baseDir, onOpenFile]
  );

  return (
    <TextFrame
      className={className}
      notice={notice}
      toolbar={
        <>
          <ViewModeSwitch
            showSource={showSource}
            onChange={setShowSource}
            renderedLabel={t('storage.preview.rendered')}
          />
        </>
      }
    >
      {showSource ? (
        <CodeView text={text} language="markdown" wrap />
      ) : (
        // Raw HTML is not enabled (no rehype-raw), so embedded HTML stays text.
        <div className="markdown-content prose prose-sm max-w-none p-5 text-fg-default">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={components}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
    </TextFrame>
  );
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

export function CsvViewer({
  text,
  truncated,
  delimiter,
  className,
}: TextContentProps & { delimiter: ',' | '\t' }) {
  const { t } = useTranslation();
  const truncatedNotice = useTruncatedNotice(truncated);
  const [showSource, setShowSource] = useState(false);
  const { rows, hasMore } = useMemo(
    // +1: the header row does not count toward the shown data rows.
    () => parseDelimited(text, delimiter, CSV_MAX_ROWS + 1),
    [text, delimiter]
  );
  const [header = [], ...body] = rows;
  const columnCount = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const notice =
    hasMore || truncated
      ? [truncatedNotice, t('storage.preview.rowsShown', { count: body.length })]
          .filter(Boolean)
          .join(' ')
      : null;

  return (
    <TextFrame
      className={className}
      notice={notice}
      toolbar={
        <>
          <ViewModeSwitch
            showSource={showSource}
            onChange={setShowSource}
            renderedLabel={t('storage.preview.table')}
          />
        </>
      }
    >
      {showSource ? (
        <CodeView text={text} wrap={false} />
      ) : (
        <table className="min-w-full border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-surface-secondary">
            <tr>
              <th className="sticky left-0 border-b border-r border-border bg-surface-secondary px-2 py-1.5 text-right font-normal text-fg-muted">
                #
              </th>
              {Array.from({ length: columnCount }, (_, c) => (
                <th
                  key={c}
                  className="max-w-xs truncate border-b border-r border-border px-3 py-1.5 text-left font-semibold text-fg-default"
                  title={header[c]}
                >
                  {header[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="hover:bg-surface-secondary">
                <td className="sticky left-0 border-b border-r border-border bg-surface-primary px-2 py-1 text-right tabular-nums text-fg-muted">
                  {r + 1}
                </td>
                {Array.from({ length: columnCount }, (_, c) => (
                  <td
                    key={c}
                    className="max-w-xs truncate border-b border-r border-border px-3 py-1 text-fg-default"
                    title={row[c]}
                  >
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TextFrame>
  );
}
