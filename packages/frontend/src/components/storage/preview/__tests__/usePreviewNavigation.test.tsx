// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import type { StorageItem } from '../../../../api/storage';
import { usePreviewNavigation } from '../usePreviewNavigation';

const file = (name: string): StorageItem => ({ name, path: `/d/${name}`, type: 'file' });
const files = [file('a.txt'), file('b.txt'), file('c.txt')];

function setup(enabled = true) {
  const onChange = vi.fn();
  const onEscape = vi.fn();
  renderHook(() => usePreviewNavigation(files, files[1], onChange, { onEscape, enabled }));
  return { onChange, onEscape };
}

function element(tag: string, attrs: Record<string, string> = {}) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('usePreviewNavigation', () => {
  it('moves to the previous / next file with ←/→', () => {
    const { onChange } = setup();
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onChange.mock.calls.map(([f]) => f.name)).toEqual(['a.txt', 'c.txt']);
  });

  it.each([
    ['a <video>', () => element('video')],
    ['the resize handle', () => element('div', { role: 'separator' })],
    ['a scrollable viewer', () => element('div', { 'data-preview-viewer': '' })],
    ['an <input>', () => element('input')],
  ])('leaves ←/→ to %s', (_, make) => {
    const { onChange } = setup();
    fireEvent.keyDown(make(), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('handles Esc but leaves it to inputs', () => {
    const { onEscape } = setup();
    fireEvent.keyDown(element('input'), { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('ignores all keys while disabled (a dialog is stacked on top)', () => {
    const { onChange, onEscape } = setup(false);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onEscape).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
