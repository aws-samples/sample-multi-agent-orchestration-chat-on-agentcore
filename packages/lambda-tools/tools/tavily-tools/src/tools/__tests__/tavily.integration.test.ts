/**
 * Integration tests that hit the real Tavily API.
 *
 * Run with:
 *   npm run -w @moca/lambda-tools-tavily test:integration
 *
 * Requires TAVILY_API_KEY in `packages/lambda-tools/tools/tavily-tools/.env`
 * (loaded by jest.integration.setup.cjs). Without the key, all suites are
 * skipped so CI stays green on machines without the secret.
 *
 * Scope: assertions focus on behavior that CANNOT be faithfully reproduced with
 * a fetch mock — i.e. things that depend on the real Tavily contract:
 *   - Output-header contract consumed by LLMs (formatters wired to real shapes)
 *   - Invariants that bridge API response → formatted result (e.g.
 *     succeeded + failed === requested)
 *   - Failure-path reason fallbacks (Tavily omits `reason` on some 4xx)
 *   - Parameter passthrough (includeDomains / topic / excludePaths actually
 *     reach the API and shape the response)
 *
 * Details of string formatting that ARE deterministic with a stub response
 * belong in unit tests (see `tavily-common.test.ts`). Do not duplicate them
 * here — integration runs cost Tavily credits.
 */

// Stub out Secrets Manager so `getTavilyApiKey()` returns process.env.TAVILY_API_KEY
// instead of calling AWS. The mock must be declared before importing the tools.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    async send(): Promise<{ SecretString: string }> {
      const key = process.env.TAVILY_API_KEY;
      if (!key) throw new Error('TAVILY_API_KEY env var not set');
      return { SecretString: key };
    }
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// getTavilyApiKey() requires TAVILY_API_KEY_SECRET_NAME to be set (it rejects
// otherwise). The value itself is unused because the SecretsManagerClient is
// mocked above.
process.env.TAVILY_API_KEY_SECRET_NAME =
  process.env.TAVILY_API_KEY_SECRET_NAME ?? 'integration-test-stub';

import { ToolValidationError } from '@moca/lambda-tools-shared';
import { tavilySearchTool } from '../tavily-search.js';
import { tavilyExtractTool } from '../tavily-extract.js';
import { tavilyCrawlTool } from '../tavily-crawl.js';
import { __resetApiKeyCacheForTests } from '../tavily-common.js';

const hasKey = Boolean(process.env.TAVILY_API_KEY);
const describeIfKey = hasKey ? describe : describe.skip;

if (!hasKey) {
  console.warn('[tavily.integration] TAVILY_API_KEY not set — integration suite skipped');
}

beforeEach(() => {
  __resetApiKeyCacheForTests();
});

// -----------------------------------------------------------------------------
// Zod validation path (no API call, no credits) — verified against the real
// handler to guarantee malformed inputs are rejected BEFORE network I/O. Kept
// in the integration file so it always runs together with the other tool
// smoke checks; placed outside `describeIfKey` because no API key is needed.
// -----------------------------------------------------------------------------
describe('Tavily integration: input validation (no API call)', () => {
  it('tavily_search: rejects a 1-character query before making a request', async () => {
    // Guards the explicit `min(2)` on `tavilySearchSchema.query`. The Tavily
    // API itself responds to 1-char queries with an opaque
    // "undefined - undefined" error, which we pre-empt at the edge.
    await expect(
      tavilySearchTool.handler({
        query: 'a',
        searchDepth: 'basic',
        topic: 'general',
        maxResults: 3,
        includeAnswer: false,
        includeImages: false,
        maxContentLength: 500,
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it('tavily_extract: rejects an empty urls array', async () => {
    await expect(
      tavilyExtractTool.handler({
        urls: [],
        extractDepth: 'basic',
        format: 'markdown',
        chunksPerSource: 3,
        includeImages: false,
        timeout: 30,
        maxContentLength: 1000,
      })
    ).rejects.toBeInstanceOf(ToolValidationError);
  });
});

// -----------------------------------------------------------------------------
// Output contract: asserts the headers/metadata LLMs rely on are present
// after a round-trip against the real API. Keeps assertions structural so they
// tolerate Tavily response-content variation.
// -----------------------------------------------------------------------------
describeIfKey('Tavily integration: output contract', () => {
  it('tavily_search: formatted output carries the documented headers and metadata', async () => {
    const result = await tavilySearchTool.handler({
      query: 'AWS Lambda overview',
      searchDepth: 'basic',
      topic: 'general',
      maxResults: 3,
      includeAnswer: true,
      includeImages: false,
      maxContentLength: 500,
    });

    const content = result.content as string;
    expect(typeof content).toBe('string');

    expect(content).toContain('🔍 Tavily Search Results');
    expect(content).toContain('Search Query: AWS Lambda overview');
    expect(content).toMatch(/Execution Time: [\d.]+s/);
    expect(content).toMatch(/📋 Search Results \(\d+ items\):/);

    expect(typeof result.resultCount).toBe('number');
    expect((result.resultCount as number) >= 0).toBe(true);
    expect(typeof result.executionTimeMs).toBe('number');
    expect((result.executionTimeMs as number) > 0).toBe(true);

    // Cross-check: the "(N items)" in the header matches result.resultCount.
    const match = content.match(/📋 Search Results \((\d+) items\):/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(result.resultCount);
  });

  it('tavily_extract: succeededCount + failedCount equals number of requested URLs', async () => {
    const urls = ['https://aws.amazon.com/lambda/'];
    const result = await tavilyExtractTool.handler({
      urls,
      extractDepth: 'basic',
      format: 'markdown',
      chunksPerSource: 3,
      includeImages: false,
      timeout: 30,
      maxContentLength: 2000,
    });

    expect(result.urlCount).toBe(urls.length);
    expect(typeof result.succeededCount).toBe('number');
    expect(typeof result.failedCount).toBe('number');
    expect((result.succeededCount as number) + (result.failedCount as number)).toBe(urls.length);

    const content = result.content as string;
    expect(content).toContain('🔍 Tavily Extract Results');
    expect(content).toMatch(
      new RegExp(`Success: ${result.succeededCount} items, Failed: ${result.failedCount} items`)
    );
  });

  it('tavily_crawl: returns a base_url and pagesDiscovered, and formatter renders them', async () => {
    const result = await tavilyCrawlTool.handler({
      url: 'https://example.com',
      maxDepth: 1,
      maxBreadth: 3,
      limit: 3,
      allowExternal: false,
      extractDepth: 'basic',
      format: 'markdown',
      includeImages: false,
      chunksPerSource: 3,
      timeout: 60,
      maxContentLength: 1000,
    });

    const content = result.content as string;
    expect(content).toContain('🕷️ Tavily Crawl Results');
    expect(content).toMatch(/Base URL: https?:\/\//);
    expect(content).toMatch(/Pages Discovered: \d+ items/);

    expect(typeof result.baseUrl).toBe('string');
    expect((result.baseUrl as string).length).toBeGreaterThan(0);
    expect(typeof result.pagesDiscovered).toBe('number');
    // We do not assert > 0: example.com is tiny and Tavily occasionally returns
    // 0 pages. The goal here is that the plumbing succeeds end-to-end.
    expect((result.pagesDiscovered as number) >= 0).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Image formatting regression. Previously the formatter dereferenced `.url`
// on bare string image entries (Tavily's default shape when
// include_image_descriptions=false), leaking the literal "undefined" into the
// LLM-facing output. See `normalizeTavilyImage` in tavily-common.ts.
// -----------------------------------------------------------------------------
describeIfKey('Tavily integration: image formatting regression', () => {
  it('tavily_search: image list lines must not contain literal "undefined"', async () => {
    const result = await tavilySearchTool.handler({
      query: 'AWS Lambda overview',
      searchDepth: 'basic',
      topic: 'general',
      maxResults: 3,
      includeAnswer: false,
      includeImages: true,
      maxContentLength: 500,
    });

    const content = result.content as string;
    expect(typeof content).toBe('string');

    // Only assert when the API actually returned images. Tavily does not
    // guarantee images for every query.
    if (content.includes('🖼️ Related Images')) {
      // "1. undefined" / "2. undefined" etc. must not appear.
      expect(content).not.toMatch(/^\s*\d+\.\s+undefined\s*$/m);
    }
  });

  it('tavily_extract: image list lines must not contain literal "undefined"', async () => {
    const result = await tavilyExtractTool.handler({
      urls: ['https://aws.amazon.com/lambda/'],
      extractDepth: 'basic',
      format: 'markdown',
      chunksPerSource: 3,
      includeImages: true,
      timeout: 30,
      maxContentLength: 2000,
    });

    const content = result.content as string;
    expect(typeof content).toBe('string');

    if (content.includes('🖼️ Images')) {
      expect(content).not.toMatch(/^\s*\d+\.\s+undefined\s*$/m);
    }
  });

  it('tavily_crawl: image list lines must not contain literal "undefined"', async () => {
    const result = await tavilyCrawlTool.handler({
      url: 'https://example.com',
      maxDepth: 1,
      maxBreadth: 3,
      limit: 3,
      allowExternal: false,
      extractDepth: 'basic',
      format: 'markdown',
      includeImages: true,
      chunksPerSource: 3,
      timeout: 60,
      maxContentLength: 2000,
    });

    const content = result.content as string;
    expect(typeof content).toBe('string');

    if (content.includes('🖼️ Images')) {
      expect(content).not.toMatch(/^\s*\d+\.\s+undefined\s*$/m);
    }
  });
});

// -----------------------------------------------------------------------------
// Error & edge cases that only surface against the real API (failure-path
// reason fallbacks, mixed success/failure URL batches).
// -----------------------------------------------------------------------------
describeIfKey('Tavily integration: error & edge cases', () => {
  it('tavily_extract: unreachable URL produces a Reason line with non-undefined fallback', async () => {
    // Regression guard for `formatExtractResults` where Tavily omits `reason`
    // on some 4xx/network-level failures — the formatter must emit the generic
    // fallback string rather than literal "undefined".
    const unreachable =
      'https://this-domain-should-never-resolve-moca-integration-test.invalid/abc';

    const result = await tavilyExtractTool.handler({
      urls: [unreachable],
      extractDepth: 'basic',
      format: 'markdown',
      chunksPerSource: 3,
      includeImages: false,
      timeout: 30,
      maxContentLength: 1000,
    });

    // Tavily occasionally "succeeds" with stub content rather than reporting a
    // failure for DNS-level errors; only assert on the failure path when the
    // API actually reported it.
    expect((result.succeededCount as number) + (result.failedCount as number)).toBe(1);

    if ((result.failedCount as number) > 0) {
      const content = result.content as string;
      expect(content).toContain('❌ URLs that failed extraction:');
      expect(content).toMatch(/Reason: .+/);
      expect(content).not.toMatch(/Reason:\s*undefined/);
    }
  });

  it('tavily_extract: mixed valid + invalid URLs splits into both sections', async () => {
    const urls = [
      'https://aws.amazon.com/lambda/',
      'https://this-domain-should-never-resolve-moca-integration-test.invalid/xyz',
    ];

    const result = await tavilyExtractTool.handler({
      urls,
      extractDepth: 'basic',
      format: 'markdown',
      chunksPerSource: 3,
      includeImages: false,
      timeout: 30,
      maxContentLength: 1000,
    });

    expect(result.urlCount).toBe(urls.length);
    expect((result.succeededCount as number) + (result.failedCount as number)).toBe(urls.length);

    // As above, Tavily may silently succeed on the bogus URL. We only assert
    // the stronger invariant (sum equals total). When the API does bifurcate,
    // the formatter must render both sections.
    const content = result.content as string;
    if ((result.succeededCount as number) > 0) {
      expect(content).toContain('📄 Extracted Content:');
    }
    if ((result.failedCount as number) > 0) {
      expect(content).toContain('❌ URLs that failed extraction:');
    }
  });
});

// -----------------------------------------------------------------------------
// Parameter passthrough: confirms optional parameters we add conditionally in
// `handleTavilySearch` / `handleTavilyCrawl` actually reach the API and shape
// the response (i.e. the keys map to the snake_case names Tavily expects).
// These are smoke checks — Tavily's filtering is best-effort, so we use loose
// invariants rather than exact match counts.
// -----------------------------------------------------------------------------
describeIfKey('Tavily integration: parameter passthrough', () => {
  it('tavily_search: includeDomains constrains results to the listed domain', async () => {
    const result = await tavilySearchTool.handler({
      query: 'Lambda overview',
      searchDepth: 'basic',
      topic: 'general',
      maxResults: 5,
      includeAnswer: false,
      includeImages: false,
      includeDomains: ['aws.amazon.com'],
      maxContentLength: 500,
    });

    const content = result.content as string;
    // Best-effort check: when any result URL is shown, at least one must be on
    // the requested domain. Tavily is not guaranteed to respect the filter
    // perfectly, but 0 matches out of 5 would indicate the parameter was not
    // forwarded at all (regression signal).
    if ((result.resultCount as number) > 0) {
      expect(content).toMatch(/URL: https?:\/\/[^\s]*aws\.amazon\.com[^\s]*/);
    }
  });

  it('tavily_search: topic=news with timeRange returns a well-formed response', async () => {
    // Smoke test: news topic takes a different code path on Tavily's side
    // (different ranking, `published_date` on results). We only need to verify
    // the formatter does not crash and emits the standard headers.
    const result = await tavilySearchTool.handler({
      query: 'AWS announcements',
      searchDepth: 'basic',
      topic: 'news',
      maxResults: 3,
      includeAnswer: false,
      includeImages: false,
      timeRange: 'week',
      maxContentLength: 500,
    });

    const content = result.content as string;
    expect(content).toContain('🔍 Tavily Search Results');
    expect(content).toMatch(/📋 Search Results \(\d+ items\):/);
  });

  it('tavily_crawl: excludePaths filters out matching paths from results', async () => {
    const result = await tavilyCrawlTool.handler({
      url: 'https://example.com',
      maxDepth: 1,
      maxBreadth: 3,
      limit: 3,
      allowExternal: false,
      extractDepth: 'basic',
      format: 'markdown',
      includeImages: false,
      chunksPerSource: 3,
      // Regex: must not match any crawled URL. example.com has no /excluded/
      // path, so the exclusion is trivially satisfied — the assertion here is
      // that (a) the parameter is accepted, (b) the formatter renders normally.
      excludePaths: ['/excluded/.*'],
      timeout: 60,
      maxContentLength: 1000,
    });

    const content = result.content as string;
    expect(content).toContain('🕷️ Tavily Crawl Results');
    expect(content).not.toMatch(/https?:\/\/[^\s]*\/excluded\/[^\s]*/);
  });
});
