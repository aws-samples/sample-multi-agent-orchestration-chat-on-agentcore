/**
 * AgentCore Browser tool type definitions
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';

/**
 * Tool execution result
 */
export interface ToolResult {
  status: 'success' | 'error';
  content: Array<{ text?: string; json?: unknown }>;
}

/**
 * A single node captured in the accessibility/DOM snapshot.
 *
 * `uid` is stable only within the lifetime of a single page (until the next
 * navigation / snapshot that regenerates UIDs). Callers may pass `uid`
 * instead of a CSS `selector` to `click`/`type`/`waitForElement`/`screenshot`.
 */
export interface SnapshotNode {
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
  // Children are rendered as indented lines in the flattened output
  children?: SnapshotNode[];
}

/**
 * Browser session information
 */
export interface SessionInfo {
  sessionId: string;
  sessionName: string;
  browserIdentifier: string;
  automationEndpoint: string;
  liveViewEndpoint?: string;
  createdAt: Date;
  // Playwright CDP connection instances
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  /**
   * Maps UID → metadata of the element tagged with `data-moca-uid="<uid>"`.
   * Regenerated on every `snapshot` action and cleared on navigation.
   */
  uidMap?: Map<string, { role: string; name?: string; tag?: string }>;
}

// ─── Action type definitions ───

export interface StartSessionAction {
  action: 'startSession';
  sessionName?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface NavigateAction {
  action: 'navigate';
  sessionName?: string;
  url: string;
}

export interface ClickAction {
  action: 'click';
  sessionName?: string;
  /** CSS selector — mutually exclusive with `uid` */
  selector?: string;
  /** UID from a prior `snapshot` — mutually exclusive with `selector` */
  uid?: string;
}

export interface TypeAction {
  action: 'type';
  sessionName?: string;
  selector?: string;
  uid?: string;
  text: string;
}

export interface ScreenshotAction {
  action: 'screenshot';
  sessionName?: string;
  /** Capture full scrollable page instead of viewport. Default false. */
  fullPage?: boolean;
  /** Absolute X to scroll to BEFORE capturing (optional). */
  scrollX?: number;
  /** Absolute Y to scroll to BEFORE capturing (optional). */
  scrollY?: number;
  /** Screenshot a specific element (by uid from `snapshot`). Takes precedence over fullPage. */
  elementUid?: string;
}

export interface GetContentAction {
  action: 'getContent';
  sessionName?: string;
}

export interface ScrollAction {
  action: 'scroll';
  sessionName?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface BackAction {
  action: 'back';
  sessionName?: string;
}

export interface ForwardAction {
  action: 'forward';
  sessionName?: string;
}

export interface WaitForElementAction {
  action: 'waitForElement';
  sessionName?: string;
  selector?: string;
  uid?: string;
  timeoutMs?: number;
}

export interface StopSessionAction {
  action: 'stopSession';
  sessionName?: string;
}

export interface GetSessionStatusAction {
  action: 'getSessionStatus';
  sessionName?: string;
}

/**
 * Capture an accessibility tree snapshot with stable UIDs.
 *
 * Returns a compact JSON describing interactive/structural elements of the
 * current page. Subsequent `click` / `type` / `screenshot` calls can refer
 * to these UIDs instead of fragile CSS selectors.
 */
export interface SnapshotAction {
  action: 'snapshot';
  sessionName?: string;
  /** Hard cap on returned nodes. Default 400. */
  maxNodes?: number;
  /** Also include pure text/heading/image nodes, not only interactive ones. Default true. */
  includeStructural?: boolean;
}

/**
 * Union of all browser actions
 */
export type BrowserAction =
  | StartSessionAction
  | NavigateAction
  | ClickAction
  | TypeAction
  | ScreenshotAction
  | GetContentAction
  | ScrollAction
  | BackAction
  | ForwardAction
  | WaitForElementAction
  | StopSessionAction
  | GetSessionStatusAction
  | SnapshotAction;

/**
 * Browser client options
 */
export interface BrowserClientOptions {
  region?: string;
  browserIdentifier?: string;
  storagePath?: string;
}
