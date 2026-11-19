// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ImageViewer } from '../ImageViewer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Fixed 400x300 viewport for the fit computation.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {
      this.cb(
        [{ contentRect: { width: 400, height: 300 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function renderLoaded(naturalWidth: number, naturalHeight: number) {
  render(<ImageViewer url="https://example.test/a.png" alt="a.png" />);
  const img = screen.getByAltText('a.png') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
  Object.defineProperty(img, 'naturalHeight', { value: naturalHeight });
  fireEvent.load(img);
  return img;
}

const zoomLabel = () => screen.getByLabelText('storage.preview.actualSize');

describe('ImageViewer zoom', () => {
  it('fits a large image into the viewport', () => {
    const img = renderLoaded(800, 600);
    expect(zoomLabel()).toHaveTextContent('50%');
    expect(img.style.width).toBe('400px');
  });

  it('does not upscale a small image when fitting', () => {
    renderLoaded(100, 100);
    expect(zoomLabel()).toHaveTextContent('100%');
  });

  it('zooms a small image in and out with the buttons', () => {
    const img = renderLoaded(100, 100);
    fireEvent.click(screen.getByLabelText('storage.preview.zoomIn'));
    expect(zoomLabel()).toHaveTextContent('125%');
    expect(img.style.width).toBe('125px');
    fireEvent.click(screen.getByLabelText('storage.preview.zoomOut'));
    fireEvent.click(screen.getByLabelText('storage.preview.zoomOut'));
    expect(zoomLabel()).toHaveTextContent('80%');
  });

  it('zooms with Ctrl+wheel and keyboard, and 0 returns to fit', () => {
    const img = renderLoaded(800, 600);
    fireEvent.wheel(img.parentElement!.parentElement!, { deltaY: -100, ctrlKey: true });
    expect(Number(zoomLabel().textContent!.replace('%', ''))).toBeGreaterThan(50);
    fireEvent.keyDown(window, { key: '0' });
    expect(zoomLabel()).toHaveTextContent('50%');
    fireEvent.keyDown(window, { key: '+' });
    expect(zoomLabel()).toHaveTextContent('63%');
  });

  it('ignores zoom keys typed on elements outside the preview', () => {
    renderLoaded(800, 600);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.keyDown(outside, { key: '+' });
    expect(zoomLabel()).toHaveTextContent('50%');
    outside.remove();
  });

  it('toggles fit and zoomed on double-click', () => {
    renderLoaded(800, 600);
    fireEvent.doubleClick(zoomLabel().parentElement!.previousElementSibling!);
    expect(zoomLabel()).toHaveTextContent('100%');
    fireEvent.doubleClick(zoomLabel().parentElement!.previousElementSibling!);
    expect(zoomLabel()).toHaveTextContent('50%');
  });
});
