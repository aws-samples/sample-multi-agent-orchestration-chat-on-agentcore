/**
 * System prompt consistency tests.
 *
 * The assembled prompt is the agent's primary interface, but it is plain string
 * concatenation across two modules and nothing type-checks its content. It had
 * accumulated three mutually contradictory rules for rendering a file path in
 * chat (one of them broken by a missing path separator) plus a mandate to call a
 * tool that no longer exists.
 *
 * These tests encode the invariants so the contradictions cannot grow back:
 * every chat-facing path example must equal the canonical join, and no removed
 * mechanism may be reintroduced by prose.
 */

import { describe, it, expect } from '@jest/globals';
import { buildSystemPrompt, toDisplayPath } from '../system-prompt.js';
import { generateDefaultContext } from '../default-context.js';
import { RUNTIME_TOOL_NAMES } from '@moca/tool-definitions';

const ALL_TOOLS = [
  { name: RUNTIME_TOOL_NAMES.S3_LIST_FILES },
  { name: RUNTIME_TOOL_NAMES.CODE_INTERPRETER },
  { name: RUNTIME_TOOL_NAMES.THINK },
];

/**
 * [storagePath, expected prefix for every chat-facing path].
 * Written out literally rather than derived from toDisplayPath, so a call site
 * that bypasses the helper still fails.
 */
const STORAGE_CASES: ReadonlyArray<readonly [string, string]> = [
  ['/', '/'],
  ['/aws-ai-update', '/aws-ai-update/'],
  ['/nested/project-a', '/nested/project-a/'],
  ['/trailing/', '/trailing/'],
];

const STORAGE_PATHS = STORAGE_CASES.map(([storagePath]) => storagePath);

/** Markdown image/link targets: ![alt](target) and [text](target). */
function markdownTargets(prompt: string): string[] {
  return [...prompt.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}

describe('toDisplayPath', () => {
  it.each([
    ['/aws-ai-update', 'plots/chart.png', '/aws-ai-update/plots/chart.png'],
    ['/aws-ai-update', 'chart.png', '/aws-ai-update/chart.png'],
    ['/', 'chart.png', '/chart.png'],
    [undefined, 'chart.png', '/chart.png'],
    ['/nested/project-a', 'report.md', '/nested/project-a/report.md'],
    ['/trailing/', 'report.md', '/trailing/report.md'],
  ])('joins %s + %s -> %s', (storagePath, relative, expected) => {
    expect(toDisplayPath(storagePath, relative)).toBe(expected);
  });

  it('never emits a missing or doubled separator', () => {
    for (const storagePath of STORAGE_PATHS) {
      const result = toDisplayPath(storagePath, 'a/b.png');
      expect(result).toMatch(/^\/(?!\/)/);
      expect(result).not.toContain('//');
      expect(result.endsWith('/a/b.png')).toBe(true);
    }
  });
});

describe('buildSystemPrompt file path examples', () => {
  it.each(STORAGE_PATHS)('emits no local or internal path in a link (storagePath=%s)', (p) => {
    const prompt = buildSystemPrompt({ tools: ALL_TOOLS, storagePath: p });

    // A broken link shown in link syntax is itself copy-pasteable; anti-patterns
    // are described as plain paths instead.
    for (const target of markdownTargets(prompt)) {
      expect(target.startsWith('/tmp/')).toBe(false);
      expect(target.startsWith('/opt/')).toBe(false);
    }
  });

  it.each(STORAGE_CASES)(
    'emits only paths under %s in links (expected prefix %s)',
    (storagePath, expectedPrefix) => {
      const prompt = buildSystemPrompt({ tools: ALL_TOOLS, storagePath });

      const targets = markdownTargets(prompt).filter((t) => !t.startsWith('http'));
      expect(targets.length).toBeGreaterThan(0);

      for (const target of targets) {
        // Rejects the concatenation bug ("/aws-ai-updateplots/chart.png"), which
        // starts with the storage path but is not separated from it.
        expect(target.startsWith(expectedPrefix)).toBe(true);
        expect(target).not.toContain('//');
      }
    }
  );
});

describe('buildSystemPrompt removed mechanisms', () => {
  const prompt = buildSystemPrompt({ tools: ALL_TOOLS, storagePath: '/aws-ai-update' });

  it('does not reference s3_upload_file, which is not a registered tool', () => {
    expect(Object.values(RUNTIME_TOOL_NAMES)).not.toContain('s3_upload_file');
    expect(prompt).not.toContain('s3_upload_file');
  });

  it('does not instruct the model to produce an S3 or presigned URL', () => {
    expect(prompt).not.toMatch(/s3[.-][a-z0-9-]*\.?amazonaws\.com/i);
    expect(prompt).not.toMatch(/(always|must).{0,40}presigned/i);
  });

  it('does not tell downloadFiles to target a directory outside the workspace', () => {
    const destinations = [...prompt.matchAll(/"destinationDir":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(destinations.length).toBeGreaterThan(0);
    for (const destination of destinations) {
      expect(destination.startsWith('/tmp/ws')).toBe(true);
    }
  });
});

describe('generateDefaultContext', () => {
  it('does not advertise an upload-then-link workflow', () => {
    const context = generateDefaultContext([{ name: RUNTIME_TOOL_NAMES.S3_LIST_FILES }]);
    expect(context).not.toContain('s3_upload_file');
    expect(context).not.toMatch(/amazonaws\.com/i);
  });

  it('omits the storage section entirely when no storage tool is enabled', () => {
    const context = generateDefaultContext([{ name: RUNTIME_TOOL_NAMES.THINK }]);
    expect(context).not.toContain('<user_storage>');
  });
});
