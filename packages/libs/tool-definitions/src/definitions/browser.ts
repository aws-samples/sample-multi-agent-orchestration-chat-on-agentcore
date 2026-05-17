import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

const browserSchema = z.object({
  // Action type (required)
  action: z
    .enum([
      'startSession',
      'navigate',
      'click',
      'type',
      'screenshot',
      'getContent',
      'scroll',
      'back',
      'forward',
      'waitForElement',
      'stopSession',
      'getSessionStatus',
      'snapshot',
    ])
    .describe(
      'The browser operation to perform. Prefer `snapshot` over `screenshot` for understanding page content (cheaper + more reliable). Valid values: startSession, navigate, click, type, screenshot, getContent, scroll, back, forward, waitForElement, stopSession, getSessionStatus, snapshot.'
    ),

  // Session name (for multi-session management)
  sessionName: z
    .string()
    .optional()
    .describe(
      'Session name for the browser environment. If not specified, a default session is used. Sessions auto-start on first action.'
    ),

  // For startSession
  viewportWidth: z
    .number()
    .optional()
    .describe('Browser viewport width in pixels (for startSession, default: 1280)'),
  viewportHeight: z
    .number()
    .optional()
    .describe('Browser viewport height in pixels (for startSession, default: 720)'),

  // For navigate
  url: z.string().optional().describe('URL to navigate to (REQUIRED for navigate action)'),

  // For click / type / waitForElement
  selector: z
    .string()
    .optional()
    .describe(
      'CSS selector of the element to interact with. For click/type/waitForElement, you may pass either `selector` or `uid` (from a prior `snapshot`). Prefer `uid` when available because it is decoupled from fragile CSS paths.'
    ),

  // For click / type / waitForElement / screenshot(elementUid)
  uid: z
    .string()
    .optional()
    .describe(
      'Element UID returned by a prior `snapshot` call (e.g. "e42"). Alternative to `selector` for click/type/waitForElement.'
    ),

  // For type
  text: z
    .string()
    .optional()
    .describe('Text to type into the selected element (REQUIRED for type action)'),

  // For scroll
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Scroll direction (for scroll action, default: down)'),
  amount: z
    .number()
    .optional()
    .describe('Scroll amount in pixels (for scroll action, default: 500)'),

  // For waitForElement
  timeoutMs: z
    .number()
    .optional()
    .describe('Timeout in milliseconds for waitForElement (default: 10000)'),

  // For screenshot
  fullPage: z
    .boolean()
    .optional()
    .describe(
      'Screenshot the full scrollable page instead of just the viewport (for screenshot action, default: false).'
    ),
  scrollX: z
    .number()
    .optional()
    .describe('Absolute X to scroll to BEFORE taking the screenshot (for screenshot action).'),
  scrollY: z
    .number()
    .optional()
    .describe('Absolute Y to scroll to BEFORE taking the screenshot (for screenshot action).'),
  elementUid: z
    .string()
    .optional()
    .describe(
      'UID of the element to screenshot. Overrides fullPage/scrollY (for screenshot action).'
    ),

  // For snapshot
  maxNodes: z
    .number()
    .optional()
    .describe('Hard cap on the number of nodes returned by `snapshot` (default: 400).'),
  includeStructural: z
    .boolean()
    .optional()
    .describe(
      'When true (default), `snapshot` also includes non-interactive structural nodes (headings, images, regions). Set false to return only interactive elements.'
    ),
});

export const browserDefinition: ToolDefinition<typeof browserSchema> = {
  name: 'browser',
  description: `AgentCore Browser tool for interacting with web applications through a managed Chrome browser.

This tool gives the agent a cloud Chrome browser. **Prefer the accessibility snapshot over screenshots** — it is cheaper, deterministic, and gives stable UIDs you can click on.

## Recommended workflow
1. \`startSession\` (or just call \`navigate\` — it auto-starts the session).
2. \`navigate\` to the target URL.
3. \`snapshot\` to see what is on the page. Returned nodes look like:
   \`{ "uid": "e7", "role": "link", "name": "Getting started", "href": "/..." }\`
4. \`click\` / \`type\` using either \`uid\` (preferred) or a CSS \`selector\`.
5. \`scroll\` to reveal more content, then \`snapshot\` again.
6. \`screenshot\` only when you explicitly need a pixel image (e.g. for the user to view).
7. \`stopSession\` when done.

## Scroll semantics
\`scroll\` tries, in order:
  (1) \`window.scrollBy()\`
  (2) the nearest scrollable ancestor of the element at the viewport center
  (3) CDP \`Input.dispatchMouseEvent(mouseWheel)\`
It returns \`scrollYBefore\` / \`scrollYAfter\` / \`didScroll\` so you can verify movement.

## Screenshot options
- \`fullPage: true\` — capture entire scrollable height
- \`scrollX\` / \`scrollY\` — scroll absolutely before capture
- \`elementUid\` — capture only the element with that UID

## Notes
- Sessions auto-timeout after 15 minutes.
- Screenshots are saved to the user's S3 storage; the returned \`imagePath\` can be referenced in replies.
- After \`navigate\`, previously-returned UIDs become invalid. Take a new \`snapshot\`.`,
  zodSchema: browserSchema,
  jsonSchema: zodToJsonSchema(browserSchema),
};
