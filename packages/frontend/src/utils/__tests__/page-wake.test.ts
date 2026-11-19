import { describe, it, expect, vi, afterEach } from 'vitest';
import { onPageWake } from '../page-wake';

afterEach(() => vi.unstubAllGlobals());

function stubPage(visibility: 'visible' | 'hidden') {
  const doc = Object.assign(new EventTarget(), { visibilityState: visibility });
  const win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  return { doc, win };
}

describe('onPageWake', () => {
  it('fires on becoming visible, bfcache restore and reconnecting to the network', () => {
    const { doc, win } = stubPage('visible');
    const onWake = vi.fn();
    onPageWake(onWake);

    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('online'));

    expect(onWake).toHaveBeenCalledTimes(3);
  });

  it('ignores the page going to the background', () => {
    const { doc } = stubPage('hidden');
    const onWake = vi.fn();
    onPageWake(onWake);

    doc.dispatchEvent(new Event('visibilitychange'));

    expect(onWake).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', () => {
    const { win } = stubPage('visible');
    const onWake = vi.fn();
    onPageWake(onWake)();

    win.dispatchEvent(new Event('online'));

    expect(onWake).not.toHaveBeenCalled();
  });
});
