// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildSandboxedSrcDoc, sandboxCsp } from '../htmlSandbox';

function parse(srcDoc: string) {
  return new DOMParser().parseFromString(srcDoc, 'text/html');
}

describe('buildSandboxedSrcDoc', () => {
  it('puts the CSP meta first in <head>, before the page’s own elements', () => {
    const out = parse(
      buildSandboxedSrcDoc(
        '<!DOCTYPE html><html><head><script src="https://evil.test/x.js"></script></head><body>hi</body></html>',
        { allowRemote: false }
      )
    );
    const first = out.head.firstElementChild;
    expect(first?.tagName).toBe('META');
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(sandboxCsp(false));
    expect(out.body.textContent).toBe('hi');
  });

  it('always emits a standards doctype (srcdoc ignores legacy ones anyway)', () => {
    expect(buildSandboxedSrcDoc('<p>x</p>', { allowRemote: false })).toMatch(
      /^<!DOCTYPE html><html>/
    );
  });

  it('wraps a bare fragment in a full document with the CSP', () => {
    const out = parse(buildSandboxedSrcDoc('<div id="a">frag</div>', { allowRemote: false }));
    expect(out.head.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull();
    expect(out.getElementById('a')?.textContent).toBe('frag');
  });

  it('removes meta refresh, which would navigate outside the CSP', () => {
    const out = parse(
      buildSandboxedSrcDoc(
        '<head><meta http-equiv="Refresh" content="0;url=https://evil.test"></head>',
        { allowRemote: false }
      )
    );
    expect(out.querySelector('meta[http-equiv="Refresh"]')).toBeNull();
  });

  it('turns off-page links into (blocked) popups and leaves in-page anchors alone', () => {
    const out = parse(
      buildSandboxedSrcDoc(
        '<a id="toc" href="#s2">TOC</a><a id="ext" href="https://x.test" target="_self">x</a>' +
          '<a id="rel" href="other.html">rel</a><h2 id="s2">S2</h2>',
        { allowRemote: false }
      )
    );
    expect(out.getElementById('toc')?.hasAttribute('target')).toBe(false);
    expect(out.getElementById('ext')?.getAttribute('target')).toBe('_blank');
    expect(out.getElementById('rel')?.getAttribute('target')).toBe('_blank');
    expect(out.querySelector('base')).toBeNull();
  });

  it('injects the fragment-link handler right after the CSP, before page scripts', () => {
    const out = parse(
      buildSandboxedSrcDoc('<head><script>page()</script></head>', { allowRemote: false })
    );
    const [csp, handler, page] = Array.from(out.head.children);
    expect(csp.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(handler.textContent).toContain('scrollIntoView');
    expect(page.textContent).toBe('page()');
  });

  it('preserves inline scripts verbatim', () => {
    const out = buildSandboxedSrcDoc('<script>if (1 < 2) document.title = "a&b";</script>', {
      allowRemote: false,
    });
    expect(out).toContain('<script>if (1 < 2) document.title = "a&b";</script>');
  });
});

describe('sandboxCsp', () => {
  it('blocks every network fetch by default', () => {
    const csp = sandboxCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('https:');
  });

  it('allows https assets in remote mode but keeps connect/form/base closed', () => {
    const csp = sandboxCsp(true);
    expect(csp).toMatch(/script-src [^;]*https:/);
    expect(csp).toMatch(/img-src [^;]*https:/);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});
