import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { buildSandboxedSrcDoc } from '../../../utils/htmlSandbox';
import { Button } from '../../ui/Button';
import {
  CodeView,
  TextFrame,
  ToolbarToggle,
  ViewModeSwitch,
  type TextContentProps,
} from './TextViewers';
import { useTruncatedNotice } from './useTruncatedNotice';

/**
 * Never add `allow-same-origin`: together with `allow-scripts` the document
 * could remove its own sandbox and read the app's tokens. Popups, forms and
 * top navigation stay blocked as well.
 */
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

/**
 * Rendered (sandboxed iframe) / source toggle for HTML files. Remote resources
 * are opt-in per file: the state lives here and the body is keyed by path.
 */
export function HtmlViewer({ text, truncated, className }: TextContentProps) {
  const { t } = useTranslation();
  const truncatedNotice = useTruncatedNotice(truncated);
  const [showSource, setShowSource] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const [confirmingRemote, setConfirmingRemote] = useState(false);
  // A cut-off document would render as broken DOM, so only its source is shown.
  const rendered = !truncated && !showSource;
  const srcDoc = useMemo(
    () => (truncated ? null : buildSandboxedSrcDoc(text, { allowRemote })),
    [text, truncated, allowRemote]
  );

  const notice = truncated
    ? `${truncatedNotice} ${t('storage.preview.htmlSourceOnly')}`
    : rendered && allowRemote
      ? t('storage.preview.htmlRemoteWarning')
      : null;

  return (
    <TextFrame
      className={className}
      notice={notice}
      // The remote-loading line is a standing reminder, not an alert.
      noticeTone={truncated ? 'warning' : 'muted'}
      toolbar={
        !truncated && (
          <>
            {rendered && (
              <ToolbarToggle
                active={allowRemote}
                // Turning remote loading off is always safe; turning it on asks first.
                onClick={() => (allowRemote ? setAllowRemote(false) : setConfirmingRemote(true))}
              >
                <Globe className="h-3.5 w-3.5" />
                {t('storage.preview.htmlRemote')}
              </ToolbarToggle>
            )}
            <ViewModeSwitch
              showSource={showSource}
              onChange={setShowSource}
              renderedLabel={t('storage.preview.rendered')}
            />
          </>
        )
      }
    >
      {rendered && srcDoc !== null ? (
        <div className="relative h-full">
          <iframe
            title={t('storage.preview.htmlFrameTitle')}
            sandbox={HTML_PREVIEW_SANDBOX}
            srcDoc={srcDoc}
            referrerPolicy="no-referrer"
            className="block h-full w-full border-0 bg-white"
          />
          {confirmingRemote && (
            <RemoteResourcesConfirm
              onConfirm={() => {
                setConfirmingRemote(false);
                setAllowRemote(true);
              }}
              onCancel={() => setConfirmingRemote(false)}
            />
          )}
        </div>
      ) : (
        <CodeView text={text} language="markup" wrap />
      )}
    </TextFrame>
  );
}

/**
 * Rendered inside the viewer rather than as a stacked Modal: the preview's
 * capture-phase Esc handler would close the whole preview before a Modal saw
 * the key. `data-owns-escape` makes it skip keys from inside this dialog.
 */
function RemoteResourcesConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Safe choice gets focus, so Enter right after the click does not opt in.
  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <div
      data-owns-escape=""
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Keep it from the storage Modal's document-level Esc listener.
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="html-remote-confirm-title"
        aria-describedby="html-remote-confirm-message"
        className="w-full max-w-sm rounded-2xl border border-border bg-surface-primary p-5 shadow-xl"
      >
        <h2 id="html-remote-confirm-title" className="text-sm font-semibold text-fg-default">
          {t('storage.preview.htmlRemoteConfirmTitle')}
        </h2>
        <p
          id="html-remote-confirm-message"
          className="mt-2 text-xs leading-relaxed text-fg-secondary"
        >
          {t('storage.preview.htmlRemoteConfirmMessage')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            {t('storage.preview.htmlRemoteConfirmAction')}
          </Button>
        </div>
      </div>
    </div>
  );
}
