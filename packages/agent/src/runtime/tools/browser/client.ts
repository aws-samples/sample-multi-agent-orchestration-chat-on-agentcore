/// <reference lib="dom" />
/**
 * AgentCore Browser client implementation
 *
 * Functions passed to `page.evaluate(...)` are serialized and executed inside
 * the browser page, not in Node.js. They need DOM typings, which is why this
 * file carries a `/// <reference lib="dom" />` directive. The rest of the
 * file runs in Node and uses only the explicit DOM symbols referenced inside
 * the evaluate callbacks.
 *
 * Uses @aws-sdk/client-bedrock-agentcore to manage browser sessions

 * and Playwright CDP connection for browser automation.
 *
 * Architecture:
 *   StartBrowserSessionCommand → creates session, returns automationStream endpoint
 *   Playwright connect_over_cdp → connects via WebSocket to control the browser
 *   StopBrowserSessionCommand → terminates session
 *
 * The automation stream endpoint provides a WebSocket-based CDP (Chrome DevTools Protocol)
 * connection that Playwright uses for all browser interactions (navigate, click, screenshot, etc.).
 *
 * ## Design notes: why the page resolution logic is more elaborate than it looks
 *
 * When Playwright connects to a managed Chrome over CDP, the browser often has
 * an existing `chrome://new-tab-page/` (or `about:blank`) target. Depending on
 * timing, `page.goto()` may succeed on one target while a different target
 * stays as the user-visible page. We therefore
 *
 *   1. ALWAYS open a fresh tab with `context.newPage()` on session start
 *   2. Close any stray chrome:// / about: targets
 *   3. After `navigate`, verify `page.url()` matches what we requested and
 *      fall back to finding the correct target by URL if it doesn't.
 *
 * Similarly, many real-world pages (AWS docs, etc.) scroll an inner
 * `overflow: auto` container rather than `window`. `window.scrollBy()` alone
 * is not sufficient, so `scroll` falls back to CDP wheel events on the
 * nearest scrollable ancestor.
 */

import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
  GetBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createUserScopedS3Client } from '../../../libs/utils/scoped-credentials.js';
import { formatFileSize } from '../../../libs/utils/format-size.js';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { chromium } from 'playwright-core';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { getCurrentContext, requireIdentityId } from '../../../libs/context/request-context.js';
import { v7 as uuidv7 } from 'uuid';
import type { Page } from 'playwright-core';
import type {
  ToolResult,
  SessionInfo,
  BrowserClientOptions,
  StartSessionAction,
  NavigateAction,
  ClickAction,
  TypeAction,
  ScreenshotAction,
  GetContentAction,
  ScrollAction,
  BackAction,
  ForwardAction,
  WaitForElementAction,
  StopSessionAction,
  GetSessionStatusAction,
  SnapshotAction,
} from './types.js';

// Module-level session cache - persists across objects within the same process
const sessionMapping: Map<string, SessionInfo> = new Map();

/**
 * URLs of pages that are never the user's target (internal Chrome pages).
 * If our Page reference points at one of these after a navigation attempt,
 * we know we're looking at the wrong target.
 */
const STRAY_URL_PATTERN = /^(about:|chrome:|data:)/;

/**
 * Centralized timeouts. All values are milliseconds unless noted.
 *
 * WHY: Each Playwright call takes its own `timeout` option and these used to
 * be scattered as magic numbers throughout the file. Collecting them here
 * makes it easy to tune for slow networks / heavy SPAs and keeps the
 * rationale for each number in one place next to its use-case.
 */
const BROWSER_TIMEOUTS = {
  /** AgentCore Browser session lifetime (seconds, passed to AWS API). */
  sessionLifetimeSeconds: 900,
  /** `page.goto(url)` — initial navigation to a brand-new page. */
  navigation: 30_000,
  /**
   * `page.goBack()` / `page.goForward()`.
   * Slightly shorter than fresh navigation because history navigation
   * should be instant if cached; if it isn't, we'd rather fail and fall
   * back to URL-change detection.
   */
  historyNavigation: 15_000,
  /** `page.click()` / `page.fill()` element-resolution timeout. */
  interaction: 10_000,
  /** `page.waitForSelector()` default when caller does not specify. */
  elementWait: 10_000,
  /** Settling delay after `scroll` / `screenshot(scrollTo)` to let
   *  scroll-linked animations / lazy-load scripts catch up. */
  scrollSettle: 200,
  /** Settling delay after `click` to absorb quick DOM updates. */
  clickSettle: 500,
  /** Timeout for `resolveNavigatedPage` polling across context.pages(). */
  targetResolution: 3_000,
} as const;

/**
 * Derive a stable browser session name from the current request.
 *
 * WHY: Each `browser` tool invocation creates a new `AgentCoreBrowserClient`.
 * Previously the constructor minted a random `defaultSessionName` via
 * `uuidv7()`, so when the LLM omitted `sessionName` (the common case), every
 * action got a different name and therefore a different AgentCore Browser
 * session and a different Chrome. The LLM's "navigate" succeeded in one
 * throw-away Chrome while its "screenshot" ran against another still parked
 * on `about:blank`, producing fully-white screenshots.
 *
 * We now derive the default session name from the request context's
 * `sessionId` (the AgentCore Runtime conversation id), which is stable for
 * the whole user conversation. This single-keyed Map entry is shared by all
 * `browser` tool calls in the conversation, so navigate → screenshot → scroll
 * all operate on the same Chrome tab.
 */
function deriveDefaultSessionName(fallback: string): string {
  const ctx = getCurrentContext();
  // Prefer the AgentCore Runtime sessionId so every tool call in one
  // conversation shares one Chrome. Strip characters the AgentCore API
  // may disallow in session names.
  const raw = ctx?.sessionId ?? ctx?.requestId ?? fallback;
  const safe = String(raw)
    .replace(/[^A-Za-z0-9-]/g, '-')
    .slice(-40);
  return `browser-${safe || 'default'}`;
}

/**
 * AgentCore Browser client
 */
export class AgentCoreBrowserClient {
  private region: string;
  private browserIdentifier: string;
  private client: BedrockAgentCoreClient;
  private storagePath: string;
  private defaultSessionName: string;

  constructor(options: BrowserClientOptions = {}) {
    this.region = options.region || config.AWS_REGION;
    this.browserIdentifier = options.browserIdentifier || 'aws.browser.v1';
    this.storagePath = options.storagePath || '';
    // Derive a stable default session name from the request context so all
    // tool calls in one conversation share the same Chrome. Only fall back
    // to a random name when there is no context at all (e.g. integration
    // tests that construct the client directly).
    this.defaultSessionName = deriveDefaultSessionName(
      `${uuidv7().replace(/-/g, '').slice(0, 12)}`
    );
    this.client = new BedrockAgentCoreClient({ region: this.region });

    logger.info(
      `[BROWSER] Client initialized: identifier='${this.browserIdentifier}', ` +
        `region='${this.region}', storagePath='${this.storagePath}', ` +
        `defaultSessionName='${this.defaultSessionName}'`
    );
  }

  /**
   * Start a new browser session and connect via Playwright CDP
   */
  async startSession(action: StartSessionAction): Promise<ToolResult> {
    const sessionName = action.sessionName || this.defaultSessionName;

    logger.info(`[BROWSER] Starting session: ${sessionName}`);

    // Check if session already exists and has a live Playwright connection
    if (sessionMapping.has(sessionName)) {
      const existing = sessionMapping.get(sessionName)!;
      if (existing.browser?.isConnected()) {
        return {
          status: 'success',
          content: [
            {
              json: {
                message: `Session '${sessionName}' already exists and is connected`,
                sessionName,
                sessionId: existing.sessionId,
                liveViewUrl: existing.liveViewEndpoint,
              },
            },
          ],
        };
      }
      // Session exists but Playwright is disconnected - clean up and recreate
      logger.info(`[BROWSER] Session '${sessionName}' exists but disconnected, recreating`);
      sessionMapping.delete(sessionName);
    }

    try {
      // Step 1: Create browser session via AgentCore API
      const command = new StartBrowserSessionCommand({
        browserIdentifier: this.browserIdentifier,
        name: sessionName,
        sessionTimeoutSeconds: BROWSER_TIMEOUTS.sessionLifetimeSeconds,
        viewPort: {
          width: action.viewportWidth ?? 1280,
          height: action.viewportHeight ?? 720,
        },
      });

      const response = await this.client.send(command);

      const automationEndpoint = response.streams?.automationStream?.streamEndpoint || '';
      const liveViewEndpoint = response.streams?.liveViewStream?.streamEndpoint;

      if (!automationEndpoint) {
        throw new Error('No automation stream endpoint returned from StartBrowserSession');
      }

      logger.info(
        `[BROWSER] Session created: ${sessionName} (ID: ${response.sessionId}), ` +
          `automation endpoint: ${automationEndpoint}`
      );

      // Step 2: Generate SigV4-signed WebSocket URL and headers for CDP connection
      const { wsUrl, headers } = await this.generateSignedWebSocketHeaders(automationEndpoint);

      logger.info(`[BROWSER] Connecting to browser via CDP: ${wsUrl}`);

      // Step 3: Connect Playwright via CDP
      const browser = await chromium.connectOverCDP(wsUrl, {
        headers,
      });

      // Get or create context
      const context =
        browser.contexts().length > 0 ? browser.contexts()[0] : await browser.newContext();

      // ALWAYS create a fresh page. Relying on the browser's pre-existing
      // `chrome://new-tab-page/` target leads to goto() applying to a
      // different target than the one our subsequent calls operate on.
      const page = await context.newPage();

      // Close any stray internal Chrome tabs so they can't confuse us later.
      for (const p of context.pages()) {
        if (p === page) continue;
        const url = p.url();
        if (STRAY_URL_PATTERN.test(url)) {
          p.close().catch((err) => {
            logger.debug(
              `[BROWSER] Failed to close stray page ${url}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
        }
      }

      const sessionInfo: SessionInfo = {
        sessionId: response.sessionId!,
        sessionName,
        browserIdentifier: response.browserIdentifier || this.browserIdentifier,
        automationEndpoint,
        liveViewEndpoint,
        createdAt: response.createdAt || new Date(),
        browser,
        context,
        page,
        uidMap: new Map(),
      };

      sessionMapping.set(sessionName, sessionInfo);

      logger.info(
        `[BROWSER] Session started and CDP connected: ${sessionName} (ID: ${sessionInfo.sessionId})`
      );

      return {
        status: 'success',
        content: [
          {
            json: {
              sessionName,
              sessionId: sessionInfo.sessionId,
              liveViewUrl: sessionInfo.liveViewEndpoint,
              message:
                'Browser session started and CDP connected successfully. You can now navigate to URLs.',
            },
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[BROWSER] Failed to start session: ${errorMessage}`);
      return {
        status: 'error',
        content: [{ text: `Failed to start browser session: ${errorMessage}` }],
      };
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(action: NavigateAction): Promise<ToolResult> {
    if (!action.url) {
      return { status: 'error', content: [{ text: 'URL is required for navigate action' }] };
    }

    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    logger.info(`[BROWSER] Navigating to: ${action.url}`);

    try {
      const response = await page.goto(action.url, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_TIMEOUTS.navigation,
      });

      // After navigation, UIDs from prior snapshots become stale.
      session.uidMap?.clear();

      // Verify we actually landed on the target. If Chrome opened the real
      // page in a different target (common when CDP is attached while a
      // new-tab-page is loading), find that target and re-bind.
      let currentUrl = page.url();
      if (STRAY_URL_PATTERN.test(currentUrl) && !STRAY_URL_PATTERN.test(action.url)) {
        const resolved = await this.resolveNavigatedPage(session, action.url);
        if (resolved) {
          session.page = resolved;
          currentUrl = resolved.url();
          logger.info(`[BROWSER] Re-bound to navigated target: ${currentUrl}`);
        }
      }

      const finalPage = this.getPage(session);
      const title = await finalPage.title().catch(() => '');

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'navigate',
              url: action.url,
              finalUrl: currentUrl,
              title,
              statusCode: response?.status(),
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('navigate', error);
    }
  }

  /**
   * Click an element (via `selector` OR `uid`)
   */
  async click(action: ClickAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    const target = this.resolveSelector(action.selector, action.uid);
    if (!target) {
      return {
        status: 'error',
        content: [{ text: 'Either `selector` or `uid` is required for click action' }],
      };
    }

    logger.info(`[BROWSER] Clicking: ${target}`);

    try {
      await page.click(target, { timeout: BROWSER_TIMEOUTS.interaction });

      // Wait briefly for any navigation or DOM updates
      await page.waitForTimeout(BROWSER_TIMEOUTS.clickSettle);

      const title = await page.title();
      const url = page.url();

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'click',
              selector: target,
              currentUrl: url,
              currentTitle: title,
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('click', error);
    }
  }

  /**
   * Type text into an element (via `selector` OR `uid`)
   */
  async type(action: TypeAction): Promise<ToolResult> {
    if (!action.text) {
      return { status: 'error', content: [{ text: 'Text is required for type action' }] };
    }

    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    const target = this.resolveSelector(action.selector, action.uid);
    if (!target) {
      return {
        status: 'error',
        content: [{ text: 'Either `selector` or `uid` is required for type action' }],
      };
    }

    logger.info(`[BROWSER] Typing into: ${target}`);

    try {
      // Clear existing content and type new text
      await page.fill(target, action.text, { timeout: BROWSER_TIMEOUTS.interaction });

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'type',
              selector: target,
              textLength: action.text.length,
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('type', error);
    }
  }

  /**
   * Take a screenshot using CDP and save to S3.
   *
   * Options:
   *   - `scrollX` / `scrollY`: absolute scroll position before capture
   *   - `fullPage`: capture entire scrollable height
   *   - `elementUid`: capture a specific UID'd element
   */
  async screenshot(action: ScreenshotAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    logger.info(
      `[BROWSER] Taking screenshot (fullPage=${action.fullPage ?? false}, ` +
        `scrollX=${action.scrollX ?? 'none'}, scrollY=${action.scrollY ?? 'none'}, ` +
        `elementUid=${action.elementUid ?? 'none'})`
    );

    try {
      // Optional: scroll to an absolute position before capture.
      if (typeof action.scrollX === 'number' || typeof action.scrollY === 'number') {
        const x = action.scrollX ?? 0;
        const y = action.scrollY ?? 0;
        await page.evaluate(
          ({ x: sx, y: sy }: { x: number; y: number }) => window.scrollTo(sx, sy),
          { x, y }
        );
        await page.waitForTimeout(BROWSER_TIMEOUTS.scrollSettle);
      }

      // Element-scoped screenshot via Playwright's native elementHandle API.
      if (action.elementUid) {
        const buffer = await this.screenshotElementByUid(page, action.elementUid);
        if (!buffer) {
          return {
            status: 'error',
            content: [
              { text: `No element with uid='${action.elementUid}' found in current page.` },
            ],
          };
        }
        return await this.finalizeScreenshot(page, buffer.toString('base64'));
      }

      // Full-page or viewport screenshot via Playwright (which uses CDP internally
      // but handles layout/resize correctly for fullPage).
      const buffer = await page.screenshot({
        type: 'png',
        fullPage: !!action.fullPage,
      });

      return await this.finalizeScreenshot(page, buffer.toString('base64'));
    } catch (error) {
      return this.handleError('screenshot', error);
    }
  }

  /**
   * Get text content from the current page
   */
  async getContent(action: GetContentAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    logger.info(`[BROWSER] Getting page content`);

    try {
      const title = await page.title();
      const url = page.url();

      // Null-safe: non-HTML documents (e.g. chrome://new-tab-page/) may not
      // have a body. Pass a function literal (NOT a string) — a string
      // argument would be evaluated as an expression, leaving us with a
      // non-serializable function object and an undefined result, which was
      // the root cause of the historical
      // "Cannot read properties of undefined (reading 'length')" error.
      const textContent = (await page.evaluate(() => {
        return (document.body?.innerText ?? '') as string;
      })) as string;

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'getContent',
              url,
              title,
              textContent: this.truncateContent(textContent, 10000),
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('getContent', error);
    }
  }

  /**
   * Scroll the page.
   *
   * Strategy: window.scrollBy → scrollable ancestor of viewport center →
   * CDP mouseWheel. Returns `scrollYBefore/After` and `didScroll` for
   * verification (many pages scroll an inner container, not `window`).
   */
  async scroll(action: ScrollAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    const direction = action.direction || 'down';
    const amount = action.amount ?? 500;

    logger.info(`[BROWSER] Scrolling ${direction} by ${amount}px`);

    try {
      let deltaX = 0;
      let deltaY = 0;
      switch (direction) {
        case 'down':
          deltaY = amount;
          break;
        case 'up':
          deltaY = -amount;
          break;
        case 'right':
          deltaX = amount;
          break;
        case 'left':
          deltaX = -amount;
          break;
      }

      // Capture a "scroll fingerprint" that aggregates scroll offset from
      // the window AND the most-likely scrollable ancestor of viewport
      // center. If any of these change, we count the scroll as effective.
      const before = await this.getScrollState(page);

      // Try 1 + 2 in one page.evaluate: window.scrollBy, then fallback to
      // the nearest scrollable ancestor of the element at the viewport center.

      const jsResult = (await page.evaluate(
        ({ dx, dy }: { dx: number; dy: number }) => {
          const docEl = document.documentElement;
          const beforeWinY = window.scrollY;

          window.scrollBy(dx, dy);

          if (window.scrollY !== beforeWinY) {
            return { strategy: 'window', scrolled: true };
          }

          // Find nearest scrollable ancestor of the element at the center.
          const cx = window.innerWidth / 2;
          const cy = window.innerHeight / 2;
          let node: Element | null = document.elementFromPoint(cx, cy);
          while (node && node !== docEl) {
            const s = getComputedStyle(node);
            const canY =
              /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight;
            const canX =
              /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth;
            if (canY || canX) {
              const beforeTop = node.scrollTop;
              const beforeLeft = node.scrollLeft;
              node.scrollBy({ top: dy, left: dx, behavior: 'instant' });
              if (node.scrollTop !== beforeTop || node.scrollLeft !== beforeLeft) {
                return { strategy: 'ancestor', scrolled: true };
              }
            }
            node = node.parentElement;
          }

          return { strategy: 'none', scrolled: false };
        },
        { dx: deltaX, dy: deltaY }
      )) as { strategy: 'window' | 'ancestor' | 'none'; scrolled: boolean };

      let strategy: 'window' | 'ancestor' | 'wheel' | 'none' = jsResult.strategy;

      // Settle any scroll-driven animations before measuring / CDP fallback.
      await page.waitForTimeout(BROWSER_TIMEOUTS.scrollSettle);

      // Fallback (3): dispatch a CDP mouseWheel event at the viewport center.
      // This drives scrollable containers that reject programmatic scrolls
      // (some SPAs listen only to wheel events to advance pagination).
      if (!jsResult.scrolled) {
        try {
          const vp = page.viewportSize() ?? { width: 1280, height: 720 };
          const cdp = await session.context!.newCDPSession(page);
          try {
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: vp.width / 2,
              y: vp.height / 2,
              deltaX,
              deltaY,
            });
          } finally {
            await cdp.detach().catch(() => {});
          }
          await page.waitForTimeout(BROWSER_TIMEOUTS.scrollSettle);
          strategy = 'wheel';
        } catch (wheelErr) {
          logger.debug(
            `[BROWSER] CDP wheel fallback failed: ${
              wheelErr instanceof Error ? wheelErr.message : String(wheelErr)
            }`
          );
        }
      }

      const after = await this.getScrollState(page);
      const didScroll =
        before.windowY !== after.windowY ||
        before.windowX !== after.windowX ||
        before.ancestorTop !== after.ancestorTop ||
        before.ancestorLeft !== after.ancestorLeft;

      if (!didScroll) {
        logger.warn(
          `[BROWSER] Scroll had no effect (direction=${direction}, amount=${amount}). ` +
            `Page may already be at edge or page uses a scroll strategy we don't support.`
        );
      }

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'scroll',
              direction,
              amount,
              strategy: didScroll ? strategy : 'none',
              didScroll,
              scrollYBefore: before.windowY,
              scrollYAfter: after.windowY,
              ancestorScrollTopBefore: before.ancestorTop,
              ancestorScrollTopAfter: after.ancestorTop,
              scrollHeight: after.scrollHeight,
              clientHeight: after.clientHeight,
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('scroll', error);
    }
  }

  /**
   * Navigate back in browser history.
   *
   * We use `waitUntil: 'commit'` rather than `'domcontentloaded'` because
   * browser history navigation is conceptually complete as soon as the new
   * URL is committed. Waiting for DOMContentLoaded on heavy SPA pages can
   * hit a 15s timeout even when the navigation itself succeeded, so we
   * additionally fall back to URL-change detection if `goBack` throws: if
   * the URL actually changed, we still report success.
   */
  async back(action: BackAction): Promise<ToolResult> {
    return this.historyNavigate('back', action.sessionName);
  }

  /**
   * Navigate forward in browser history. Same semantics as `back`.
   */
  async forward(action: ForwardAction): Promise<ToolResult> {
    return this.historyNavigate('forward', action.sessionName);
  }

  /**
   * Shared implementation for back/forward.
   *
   * Separated out because the only difference between the two is which
   * Playwright method we invoke; everything else (URL-change fallback,
   * uidMap invalidation, result payload) is identical.
   */
  private async historyNavigate(
    direction: 'back' | 'forward',
    sessionName: string | undefined
  ): Promise<ToolResult> {
    const session = await this.ensureSession(sessionName);
    const page = this.getPage(session);
    const urlBefore = page.url();

    logger.info(`[BROWSER] Navigating ${direction}`);

    const method = direction === 'back' ? page.goBack.bind(page) : page.goForward.bind(page);

    try {
      await method({ waitUntil: 'commit', timeout: BROWSER_TIMEOUTS.historyNavigation });
      session.uidMap?.clear();

      return await this.buildNavResult(page, direction);
    } catch (error) {
      // If the URL actually changed, the navigation succeeded even though
      // Playwright's `waitUntil` timed out. Treat this as a success with a
      // warning so the LLM is not blocked by heavy-SPA quirks.
      const urlAfter = page.url();
      if (urlAfter !== urlBefore && !STRAY_URL_PATTERN.test(urlAfter)) {
        logger.warn(
          `[BROWSER] ${direction} threw but URL changed (${urlBefore} -> ${urlAfter}); treating as success`
        );
        session.uidMap?.clear();
        return await this.buildNavResult(page, direction, /* fromFallback */ true);
      }
      return this.handleError(direction, error);
    }
  }

  /**
   * Build the standard success payload for back / forward.
   */
  private async buildNavResult(
    page: Page,
    action: 'back' | 'forward',
    fromFallback = false
  ): Promise<ToolResult> {
    const [title, url] = await Promise.all([
      page.title().catch(() => ''),
      Promise.resolve(page.url()),
    ]);
    return {
      status: 'success',
      content: [
        {
          json: {
            action,
            currentUrl: url,
            currentTitle: title,
            success: true,
            ...(fromFallback && {
              note: 'History navigation timed out waiting for load, but the URL changed — treating as success.',
            }),
          },
        },
      ],
    };
  }

  /**
   * Wait for an element to appear on the page (via `selector` OR `uid`)
   */
  async waitForElement(action: WaitForElementAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    const target = this.resolveSelector(action.selector, action.uid);
    if (!target) {
      return {
        status: 'error',
        content: [{ text: 'Either `selector` or `uid` is required for waitForElement action' }],
      };
    }

    const timeoutMs = action.timeoutMs || BROWSER_TIMEOUTS.elementWait;

    logger.info(`[BROWSER] Waiting for element: ${target} (timeout: ${timeoutMs}ms)`);

    try {
      await page.waitForSelector(target, {
        timeout: timeoutMs,
        state: 'visible',
      });

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'waitForElement',
              selector: target,
              found: true,
              success: true,
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('waitForElement', error);
    }
  }

  /**
   * Capture an accessibility snapshot of the current page and assign stable UIDs.
   *
   * Implementation: a single `page.evaluate` walks the DOM, picks interactive
   * and structural elements, tags each with `data-moca-uid="<id>"`, and returns
   * a compact JSON tree. Subsequent click/type calls can pass `uid: "e42"` and
   * we translate that to `[data-moca-uid="e42"]`.
   *
   * The UID tagging is idempotent per-snapshot: we clear prior tags first, so
   * UIDs never accumulate across snapshots.
   */
  async snapshot(action: SnapshotAction): Promise<ToolResult> {
    const session = await this.ensureSession(action.sessionName);
    const page = this.getPage(session);

    const maxNodes = action.maxNodes ?? 400;
    const includeStructural = action.includeStructural ?? true;

    logger.info(
      `[BROWSER] Taking snapshot (maxNodes=${maxNodes}, includeStructural=${includeStructural})`
    );

    try {
      // Make sure the polyfill for esbuild's `__name` helper is installed on
      // this page. When this file is transpiled by esbuild with keepNames
      // enabled, named function declarations inside the `page.evaluate`
      // callback below are rewritten as `var fn = __name(function() {}, "fn")`.
      // `__name` only exists in the Node build output as a module helper — it
      // does not exist in the browser context — so the serialized function
      // crashes with `ReferenceError: __name is not defined`. We install a
      // no-op `__name` on `globalThis` once per page.
      await this.ensureBrowserPolyfills(page);

      const result = (await page.evaluate(
        ({
          maxNodes: cap,
          includeStructural: incStruct,
        }: {
          maxNodes: number;
          includeStructural: boolean;
        }) => {
          // Belt-and-suspenders: even if `ensureBrowserPolyfills` didn't run,
          // this local shadow makes the callback self-sufficient.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const __name = <T>(fn: T): T => fn;

          // Clear previous tags so UIDs are regenerated.
          document.querySelectorAll('[data-moca-uid]').forEach((el) => {
            el.removeAttribute('data-moca-uid');
          });

          const INTERACTIVE_TAGS = new Set([
            'A',
            'BUTTON',
            'INPUT',
            'TEXTAREA',
            'SELECT',
            'LABEL',
            'SUMMARY',
          ]);
          const STRUCTURAL_TAGS = new Set([
            'H1',
            'H2',
            'H3',
            'H4',
            'H5',
            'H6',
            'NAV',
            'MAIN',
            'ARTICLE',
            'SECTION',
            'ASIDE',
            'FORM',
            'IMG',
            'VIDEO',
          ]);

          type OutNode = {
            uid: string;
            role: string;
            name?: string;
            value?: string;
            level?: number;
            href?: string;
            tag?: string;
            checked?: boolean;
            disabled?: boolean;
            expanded?: boolean;
            children?: OutNode[];
          };

          let counter = 0;
          const truncated = { value: false };

          function textOf(el: Element): string {
            // Prefer aria-label, then accessible name from attributes, then innerText
            const aria = el.getAttribute('aria-label');
            if (aria) return aria.trim().slice(0, 120);
            const labelledby = el.getAttribute('aria-labelledby');
            if (labelledby) {
              const parts = labelledby
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent?.trim() || '')
                .filter(Boolean);
              if (parts.length > 0) return parts.join(' ').slice(0, 120);
            }
            const alt = el.getAttribute('alt');
            if (alt) return alt.trim().slice(0, 120);
            const title = el.getAttribute('title');
            if (title && el.tagName !== 'BODY') return title.trim().slice(0, 120);
            // For images, no innerText → done above.
            const txt = (el as HTMLElement).innerText ?? el.textContent ?? '';
            return txt.trim().replace(/\s+/g, ' ').slice(0, 120);
          }

          function roleOf(el: Element): string | null {
            const explicit = el.getAttribute('role');
            if (explicit) return explicit;
            const t = el.tagName;
            switch (t) {
              case 'A':
                return (el as HTMLAnchorElement).href ? 'link' : 'generic';
              case 'BUTTON':
                return 'button';
              case 'INPUT': {
                const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
                if (type === 'checkbox') return 'checkbox';
                if (type === 'radio') return 'radio';
                if (type === 'submit' || type === 'button') return 'button';
                return 'textbox';
              }
              case 'TEXTAREA':
                return 'textbox';
              case 'SELECT':
                return 'combobox';
              case 'LABEL':
                return 'label';
              case 'SUMMARY':
                return 'button';
              case 'IMG':
                return 'img';
              case 'H1':
              case 'H2':
              case 'H3':
              case 'H4':
              case 'H5':
              case 'H6':
                return 'heading';
              case 'NAV':
                return 'navigation';
              case 'MAIN':
                return 'main';
              case 'ARTICLE':
                return 'article';
              case 'SECTION':
                return 'section';
              case 'ASIDE':
                return 'complementary';
              case 'FORM':
                return 'form';
              default:
                return null;
            }
          }

          function isVisible(el: Element): boolean {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = getComputedStyle(el);
            if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0')
              return false;
            return true;
          }

          function shouldInclude(el: Element): boolean {
            if (!isVisible(el)) return false;
            if (INTERACTIVE_TAGS.has(el.tagName)) return true;
            if (incStruct && STRUCTURAL_TAGS.has(el.tagName)) return true;
            if (el.getAttribute('role')) return true;
            return false;
          }

          function walk(el: Element, acc: OutNode[]): void {
            if (truncated.value) return;
            let node: OutNode | null = null;

            if (shouldInclude(el)) {
              counter += 1;
              if (counter > cap) {
                truncated.value = true;
                return;
              }
              const uid = `e${counter}`;
              el.setAttribute('data-moca-uid', uid);

              const role = roleOf(el) || 'generic';
              const name = textOf(el);
              const tag = el.tagName.toLowerCase();

              node = { uid, role, tag };
              if (name) node.name = name;

              if (el.tagName === 'A') {
                const href = (el as HTMLAnchorElement).getAttribute('href');
                if (href) node.href = href;
              }
              if (role === 'heading') {
                const m = /^H([1-6])$/.exec(el.tagName);
                if (m) node.level = parseInt(m[1], 10);
              }
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                if (el.value) node.value = el.value.slice(0, 80);
                if (el.disabled) node.disabled = true;
                if (
                  el instanceof HTMLInputElement &&
                  (el.type === 'checkbox' || el.type === 'radio')
                ) {
                  node.checked = el.checked;
                }
              }
              const expanded = el.getAttribute('aria-expanded');
              if (expanded !== null) node.expanded = expanded === 'true';

              acc.push(node);
            }

            for (const child of Array.from(el.children)) {
              const target = node ? (node.children ??= []) : acc;
              walk(child, target);
              if (truncated.value) break;
            }

            if (node && node.children && node.children.length === 0) {
              delete node.children;
            }
          }

          const out: OutNode[] = [];
          if (document.body) walk(document.body, out);

          return {
            url: location.href,
            title: document.title,
            scroll: {
              x: window.scrollX,
              y: window.scrollY,
              maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
              maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
              viewportW: window.innerWidth,
              viewportH: window.innerHeight,
            },
            nodes: out,
            totalTagged: counter,
            truncated: truncated.value,
          };
        },
        { maxNodes, includeStructural }
      )) as {
        url: string;
        title: string;
        scroll: {
          x: number;
          y: number;
          maxX: number;
          maxY: number;
          viewportW: number;
          viewportH: number;
        };
        nodes: unknown[];
        totalTagged: number;
        truncated: boolean;
      };

      // Rebuild uidMap server-side so `resolveSelector` can validate UIDs.
      session.uidMap = new Map();
      const walkNodes = (nodes: unknown[]): void => {
        for (const n of nodes) {
          const node = n as {
            uid: string;
            role: string;
            name?: string;
            tag?: string;
            children?: unknown[];
          };
          session.uidMap!.set(node.uid, {
            role: node.role,
            name: node.name,
            tag: node.tag,
          });
          if (node.children) walkNodes(node.children);
        }
      };
      walkNodes(result.nodes);

      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'snapshot',
              ...result,
              hint: 'Pass `uid` to click/type/waitForElement/screenshot instead of CSS selectors.',
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('snapshot', error);
    }
  }

  /**
   * Stop a browser session
   */
  async stopSession(action: StopSessionAction): Promise<ToolResult> {
    const sessionName = action.sessionName || this.defaultSessionName;
    const session = sessionMapping.get(sessionName);

    if (!session) {
      return {
        status: 'error',
        content: [{ text: `Session '${sessionName}' not found` }],
      };
    }

    logger.info(`[BROWSER] Stopping session: ${sessionName}`);

    try {
      // Step 1: Disconnect Playwright
      if (session.browser?.isConnected()) {
        try {
          await session.browser.close();
        } catch (closeError) {
          logger.warn(
            `[BROWSER] Error closing Playwright browser: ${closeError instanceof Error ? closeError.message : String(closeError)}`
          );
        }
      }

      // Step 2: Stop AgentCore browser session
      const command = new StopBrowserSessionCommand({
        browserIdentifier: session.browserIdentifier,
        sessionId: session.sessionId,
      });

      await this.client.send(command);
      sessionMapping.delete(sessionName);

      logger.info(`[BROWSER] Session stopped: ${sessionName}`);

      return {
        status: 'success',
        content: [{ text: `Browser session '${sessionName}' stopped successfully.` }],
      };
    } catch (error) {
      // Even if stop fails, remove from cache to prevent stale references
      sessionMapping.delete(sessionName);
      return this.handleError('stopSession', error);
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(action: GetSessionStatusAction): Promise<ToolResult> {
    const sessionName = action.sessionName || this.defaultSessionName;
    const session = sessionMapping.get(sessionName);

    if (!session) {
      return {
        status: 'success',
        content: [
          {
            json: {
              sessionName,
              exists: false,
              message: `No active session named '${sessionName}'. Use startSession to create one.`,
              activeSessions: Array.from(sessionMapping.keys()),
            },
          },
        ],
      };
    }

    logger.info(`[BROWSER] Getting session status: ${sessionName}`);

    try {
      const command = new GetBrowserSessionCommand({
        browserIdentifier: session.browserIdentifier,
        sessionId: session.sessionId,
      });

      const response = await this.client.send(command);

      return {
        status: 'success',
        content: [
          {
            json: {
              sessionName,
              sessionId: session.sessionId,
              exists: true,
              status: response.status || 'UNKNOWN',
              cdpConnected: session.browser?.isConnected() ?? false,
              createdAt: session.createdAt.toISOString(),
              liveViewUrl: session.liveViewEndpoint,
              activeSessions: Array.from(sessionMapping.keys()),
            },
          },
        ],
      };
    } catch (error) {
      return this.handleError('getSessionStatus', error);
    }
  }

  /**
   * List all active sessions (for debugging)
   */
  listSessions(): ToolResult {
    const sessions = Array.from(sessionMapping.entries()).map(([name, info]) => ({
      sessionName: name,
      sessionId: info.sessionId,
      cdpConnected: info.browser?.isConnected() ?? false,
      createdAt: info.createdAt.toISOString(),
    }));

    return {
      status: 'success',
      content: [
        {
          json: {
            activeSessions: sessions,
            count: sessions.length,
          },
        },
      ],
    };
  }

  // ─── Private helpers ───

  /**
   * Resolve a `selector` or `uid` into a CSS selector Playwright can use.
   * Returns null if neither is provided.
   */
  private resolveSelector(selector?: string, uid?: string): string | null {
    if (uid) {
      // We don't require uid to be in uidMap: a snapshot may have expired but
      // the data-moca-uid attribute could still be present in the DOM. We
      // translate anyway and let Playwright return a proper error if missing.
      return `[data-moca-uid="${uid.replace(/"/g, '\\"')}"]`;
    }
    if (selector) return selector;
    return null;
  }

  /**
   * Install a no-op `__name` shim on the page's `globalThis`.
   *
   * See the long comment in `snapshot` for context. This is cheap to run
   * repeatedly (a single `addInitScript` registration or evaluate) so we
   * just call it before any evaluate that contains named function
   * declarations. Playwright's `addInitScript` only applies to *future*
   * navigations so we also `evaluate` it on the current page.
   */
  private async ensureBrowserPolyfills(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = globalThis as any;
        if (typeof g.__name !== 'function') {
          g.__name = (fn: unknown) => fn;
        }
      });
    } catch {
      // Non-fatal: the inline `const __name` shadow in the actual
      // evaluate body provides a second line of defense.
    }
  }

  /**
   * Read the current scroll fingerprint: window offsets + the scroll offsets
   * of the element at the viewport center's nearest scrollable ancestor.
   */
  private async getScrollState(page: Page): Promise<{
    windowX: number;
    windowY: number;
    ancestorTop: number;
    ancestorLeft: number;
    scrollHeight: number;
    clientHeight: number;
  }> {
    return (await page.evaluate(() => {
      const docEl = document.documentElement;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      let node: Element | null = document.elementFromPoint(cx, cy);
      let ancestorTop = 0;
      let ancestorLeft = 0;
      while (node && node !== docEl) {
        const s = getComputedStyle(node);
        const canY =
          /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight;
        const canX =
          /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth;
        if (canY || canX) {
          ancestorTop = node.scrollTop;
          ancestorLeft = node.scrollLeft;
          break;
        }
        node = node.parentElement;
      }
      return {
        windowX: window.scrollX,
        windowY: window.scrollY,
        ancestorTop,
        ancestorLeft,
        scrollHeight: docEl.scrollHeight,
        clientHeight: docEl.clientHeight,
      };
    })) as {
      windowX: number;
      windowY: number;
      ancestorTop: number;
      ancestorLeft: number;
      scrollHeight: number;
      clientHeight: number;
    };
  }

  /**
   * Persist a screenshot to S3 and build a standardized success payload.
   */
  private async finalizeScreenshot(page: Page, imageBase64: string): Promise<ToolResult> {
    if (!imageBase64) {
      return {
        status: 'success',
        content: [
          {
            json: {
              action: 'screenshot',
              message: 'Screenshot captured but no image data was returned.',
            },
          },
        ],
      };
    }

    const screenshotPath = await this.saveScreenshotToS3(imageBase64);
    const [title, url] = await Promise.all([
      page.title().catch(() => ''),
      Promise.resolve(page.url()),
    ]);
    const scrollY = (await page.evaluate(() => window.scrollY).catch(() => 0)) as number;

    // Surface stale-tab screenshots loudly. If we capture on `about:blank`
    // or `chrome://`, the image is certainly not what the LLM wanted and it
    // should be told so it can retry the `navigate` step. This happened in
    // prod when multiple tool calls were racing across different sessions.
    const stalePage = STRAY_URL_PATTERN.test(url);
    if (stalePage) {
      logger.warn(`[BROWSER] Screenshot captured on a stale/internal page: ${url}`);
    }

    return {
      status: 'success',
      content: [
        {
          json: {
            action: 'screenshot',
            imagePath: screenshotPath ?? null,
            currentUrl: url,
            currentTitle: title,
            scrollY,
            ...(stalePage && {
              warning:
                'Screenshot was taken on a blank / internal Chrome page. Call `navigate` with your target URL first, then retry `screenshot`.',
            }),
            message: screenshotPath
              ? `Screenshot saved. Reference it as: ${screenshotPath}`
              : 'Screenshot captured but could not be saved to S3. Check S3 bucket configuration.',
          },
        },
      ],
    };
  }

  /**
   * Take a screenshot of a specific UID'd element via its bounding box.
   * Returns null if the element can't be located or has zero size.
   */
  private async screenshotElementByUid(page: Page, uid: string): Promise<Buffer | null> {
    const selector = `[data-moca-uid="${uid.replace(/"/g, '\\"')}"]`;
    const handle = await page.$(selector);
    if (!handle) return null;
    try {
      const box = await handle.boundingBox();
      if (!box || box.width === 0 || box.height === 0) return null;
      return await handle.screenshot({ type: 'png' });
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  /**
   * Get the active Page from a session, throwing if not available
   */
  private getPage(session: SessionInfo): Page {
    if (!session.page) {
      throw new Error(
        `No active page for session '${session.sessionName}'. The CDP connection may have been lost.`
      );
    }
    if (session.page.isClosed()) {
      throw new Error(
        `Page is closed for session '${session.sessionName}'. The browser session may have expired.`
      );
    }
    return session.page;
  }

  /**
   * After a navigation, if our Page reference still shows a chrome://... URL,
   * scan all pages in the context for one whose URL matches the requested
   * target (same origin or exact). Returns that page if found.
   */
  private async resolveNavigatedPage(
    session: SessionInfo,
    requestedUrl: string
  ): Promise<Page | null> {
    if (!session.context) return null;

    let targetOrigin: string;
    try {
      targetOrigin = new URL(requestedUrl).origin;
    } catch {
      return null;
    }

    // Wait briefly for the right target to appear.
    const deadline = Date.now() + BROWSER_TIMEOUTS.targetResolution;
    while (Date.now() < deadline) {
      for (const p of session.context.pages()) {
        const url = p.url();
        if (url === requestedUrl) return p;
        try {
          if (new URL(url).origin === targetOrigin) return p;
        } catch {
          // ignore malformed URLs
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return null;
  }

  /**
   * Ensure a session exists, creating one automatically if needed
   */
  private async ensureSession(sessionName?: string): Promise<SessionInfo> {
    const name = sessionName || this.defaultSessionName;

    if (sessionMapping.has(name)) {
      const session = sessionMapping.get(name)!;
      // Verify CDP connection is still alive
      if (session.browser?.isConnected()) {
        return session;
      }
      // Connection lost - clean up and recreate
      logger.warn(`[BROWSER] CDP connection lost for session '${name}', recreating`);
      sessionMapping.delete(name);
    }

    // Auto-create session
    logger.info(`[BROWSER] Auto-creating session: ${name}`);
    const result = await this.startSession({
      action: 'startSession',
      sessionName: name,
    });

    if (result.status === 'error') {
      throw new Error(`Failed to auto-create browser session: ${JSON.stringify(result.content)}`);
    }

    const session = sessionMapping.get(name);
    if (!session) {
      throw new Error(`Session '${name}' not found after creation`);
    }

    return session;
  }

  /**
   * Generate SigV4-signed WebSocket URL and headers for CDP connection
   */
  private async generateSignedWebSocketHeaders(
    automationEndpoint: string
  ): Promise<{ wsUrl: string; headers: Record<string, string> }> {
    const url = new URL(automationEndpoint);

    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: this.region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });

    const request = {
      method: 'GET' as const,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : 443,
      path: url.pathname + url.search,
      headers: {
        host: url.hostname,
      },
    };

    const signedRequest = await signer.sign(request);

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(signedRequest.headers)) {
      if (key.toLowerCase() !== 'host') {
        headers[key] = value as string;
      }
    }

    return { wsUrl: automationEndpoint, headers };
  }

  /**
   * Save screenshot base64 data to S3 storage
   */
  private async saveScreenshotToS3(imageBase64: string): Promise<string | null> {
    try {
      const bucketName = config.USER_STORAGE_BUCKET_NAME;
      if (!bucketName) {
        logger.warn('[BROWSER] S3 bucket not configured, skipping screenshot storage');
        return null;
      }

      // Get user context. `identityResolverMiddleware` guarantees both
      // `userId` (UserId brand) and `identityId` (IdentityId brand) are
      // populated for any `/invocations` request, so we fail fast if a
      // caller reaches this path without having run the middleware chain.
      const context = getCurrentContext();
      if (!context?.userId) {
        logger.warn(
          '[BROWSER] Skipping screenshot S3 upload: userId is not resolved — middleware chain did not run.'
        );
        return null;
      }
      const userId = context.userId;
      const storagePath = context.storagePath;

      // identityId (REGION:UUID) is the canonical key for per-user S3
      // storage — `${cognito-identity.amazonaws.com:sub}` expands to it
      // in IAM policies.
      const storageKey = requireIdentityId();
      const client = await createUserScopedS3Client(userId);

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `screenshot-${timestamp}.png`;
      const basePath = `users/${storageKey}/${storagePath}/browser-screenshots`;
      const s3Key = `${basePath}/${filename}`.replace(/\/+/g, '/');

      // Convert and upload
      const imageBuffer = Buffer.from(imageBase64, 'base64');

      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: imageBuffer,
        ContentType: 'image/png',
        Metadata: {
          'generated-by': 'agentcore-browser',
          'generated-at': new Date().toISOString(),
        },
      });

      await client.send(command);

      // Return user-facing path
      const userPath = `/${storagePath}/browser-screenshots/${filename}`.replace(/\/+/g, '/');
      logger.info(
        `[BROWSER] Screenshot saved to S3: ${s3Key} (${formatFileSize(imageBuffer.length)})`
      );

      return userPath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`[BROWSER] Failed to save screenshot to S3: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Handle errors from browser operations
   */
  private handleError(actionName: string, error: unknown): ToolResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[BROWSER] Error in ${actionName}: ${errorMessage}`);

    return {
      status: 'error',
      content: [{ text: `Browser ${actionName} failed: ${errorMessage}` }],
    };
  }

  /**
   * Truncate content to a safe size.
   *
   * Accepts `null`/`undefined` defensively. Callers should aim to pass a
   * string, but this guards against future page.evaluate regressions that
   * previously surfaced as "Cannot read properties of undefined (reading
   * 'length')" at this call site.
   */
  private truncateContent(content: string | null | undefined, maxLength: number = 10000): string {
    const s = content ?? '';
    if (s.length <= maxLength) {
      return s;
    }
    return `${s.substring(0, maxLength)}... (Content truncated. Original length: ${s.length} characters)`;
  }
}
