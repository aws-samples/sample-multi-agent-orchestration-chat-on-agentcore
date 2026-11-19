import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '../../../lib/utils';

export interface ImageViewerProps {
  url: string | null;
  alt: string;
  /** URL resolution failed upstream. */
  urlError?: string | null;
  tone?: 'light' | 'dark';
  className?: string;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const STEP = 1.25;

const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

interface Size {
  w: number;
  h: number;
}

/**
 * Zoomable image: fit by default; +/- buttons, Ctrl/⌘+wheel or trackpad pinch,
 * double-click and +/-/0 keys zoom; drag pans once the image overflows.
 * The caller keys it by file so zoom state resets per image.
 */
export function ImageViewer({ url, alt, urlError, tone = 'light', className }: ImageViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  // null = follow the container ("fit"), so resizing (pane ↔ full-screen) refits.
  const [userScale, setUserScale] = useState<number | null>(null);
  // Image-space point to keep under the cursor across a zoom step.
  const anchorRef = useRef<{ ix: number; iy: number; px: number; py: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const dark = tone === 'dark';
  const mutedText = dark ? 'text-white/70' : 'text-fg-secondary';

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setViewport({ w: entry.contentRect.width, h: entry.contentRect.height })
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale =
    natural && viewport.w > 0 && viewport.h > 0
      ? Math.min(1, viewport.w / natural.w, viewport.h / natural.h)
      : 1;
  const scale = userScale ?? fitScale;
  const imgW = natural ? natural.w * scale : 0;
  const imgH = natural ? natural.h * scale : 0;
  const overflows = imgW > viewport.w + 0.5 || imgH > viewport.h + 0.5;

  const zoomTo = useCallback(
    (next: number | null, point?: { x: number; y: number }) => {
      const el = containerRef.current;
      if (el && natural) {
        const px = point?.x ?? el.clientWidth / 2;
        const py = point?.y ?? el.clientHeight / 2;
        const padX = Math.max(0, (el.clientWidth - natural.w * scale) / 2);
        const padY = Math.max(0, (el.clientHeight - natural.h * scale) / 2);
        anchorRef.current = {
          ix: (el.scrollLeft + px - padX) / scale,
          iy: (el.scrollTop + py - padY) / scale,
          px,
          py,
        };
      }
      setUserScale(next === null ? null : clamp(next));
    },
    [natural, scale]
  );

  // Restore the anchor after the new size is laid out.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const a = anchorRef.current;
    if (!el || !a || !natural) return;
    anchorRef.current = null;
    const padX = Math.max(0, (el.clientWidth - imgW) / 2);
    const padY = Math.max(0, (el.clientHeight - imgH) / 2);
    el.scrollLeft = a.ix * scale + padX - a.px;
    el.scrollTop = a.iy * scale + padY - a.py;
  }, [scale, imgW, imgH, natural]);

  // Non-passive so Ctrl/⌘+wheel (and trackpad pinch, reported as ctrl+wheel)
  // zooms the image instead of the page.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomTo(scale * factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scale, zoomTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Only while focus is on nothing in particular or inside this preview,
      // so the keys stay free for the file list and other controls.
      const target = e.target;
      if (target instanceof HTMLElement && target !== document.body) {
        const preview =
          containerRef.current?.closest('[data-file-preview]') ?? containerRef.current;
        if (!preview?.contains(target)) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      }
      if (e.key === '+' || e.key === '=') zoomTo(scale * STEP);
      else if (e.key === '-') zoomTo(scale / STEP);
      else if (e.key === '0') zoomTo(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scale, zoomTo]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (userScale === null) zoomTo(Math.max(1, fitScale * 2), point);
    else zoomTo(null, point);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!overflows || e.button !== 0) return;
    const el = containerRef.current!;
    dragRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const el = containerRef.current!;
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  if (urlError || failed) {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-2',
          mutedText,
          className
        )}
      >
        <AlertCircle className="h-8 w-8 text-feedback-error" />
        <p className="text-sm">{t('storage.failedToLoadImage')}</p>
      </div>
    );
  }

  const toolBtn = cn(
    'rounded-full p-1.5 transition-colors disabled:opacity-40',
    dark ? 'text-white/80 hover:bg-white/15' : 'text-fg-secondary hover:bg-surface-secondary'
  );

  return (
    <div className={cn('relative h-full w-full', className)}>
      <div
        ref={containerRef}
        // Arrow keys pan only once the image overflows; otherwise they keep
        // switching files.
        data-preview-viewer={overflows ? '' : undefined}
        tabIndex={overflows ? 0 : undefined}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          'h-full w-full select-none focus:outline-hidden',
          overflows ? 'overflow-auto' : 'overflow-hidden',
          overflows && (dragging ? 'cursor-grabbing' : 'cursor-grab')
        )}
      >
        {(!url || !natural) && (
          <div className={cn('absolute inset-0 flex items-center justify-center gap-2', mutedText)}>
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">{t('storage.loadingImage')}</span>
          </div>
        )}
        {url && (
          <div
            className="flex items-center justify-center"
            style={{ width: Math.max(viewport.w, imgW), height: Math.max(viewport.h, imgH) }}
          >
            <img
              src={url}
              alt={alt}
              draggable={false}
              onLoad={(e) =>
                setNatural({
                  w: e.currentTarget.naturalWidth || 1,
                  h: e.currentTarget.naturalHeight || 1,
                })
              }
              onError={() => setFailed(true)}
              style={natural ? { width: imgW, height: imgH } : undefined}
              className={cn(
                'max-w-none shrink-0',
                natural ? 'opacity-100' : 'opacity-0',
                // Checkerboard so transparent PNG/SVG edges stay visible.
                !dark &&
                  'bg-[length:16px_16px] bg-[conic-gradient(var(--color-border-default)_25%,transparent_0_50%,var(--color-border-default)_0_75%,transparent_0)]'
              )}
            />
          </div>
        )}
      </div>

      {natural && (
        <div
          className={cn(
            'absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border p-1 text-xs shadow-elevation-2',
            dark ? 'border-white/15 bg-black/60' : 'border-border bg-surface-primary/95'
          )}
        >
          <button
            type="button"
            className={toolBtn}
            onClick={() => zoomTo(scale / STEP)}
            disabled={scale <= MIN_SCALE}
            aria-label={t('storage.preview.zoomOut')}
            title={t('storage.preview.zoomOut')}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={cn(toolBtn, 'min-w-[3.5rem] px-2 tabular-nums')}
            onClick={() => zoomTo(1)}
            aria-label={t('storage.preview.actualSize')}
            title={t('storage.preview.actualSize')}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            className={toolBtn}
            onClick={() => zoomTo(scale * STEP)}
            disabled={scale >= MAX_SCALE}
            aria-label={t('storage.preview.zoomIn')}
            title={t('storage.preview.zoomIn')}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={toolBtn}
            onClick={() => zoomTo(null)}
            disabled={userScale === null}
            aria-label={t('storage.preview.fitToScreen')}
            title={t('storage.preview.fitToScreen')}
          >
            <Scan className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
