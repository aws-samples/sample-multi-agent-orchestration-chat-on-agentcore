/**
 * Integration test: AgentCore Gateway built-in Web Search connector
 * (`webSearchProvider: 'agentcore'`).
 *
 * Two layers, both through the production code paths:
 *
 * 1. Tool unit — AgentCoreMCPClient against the deployed Gateway:
 *    exactly one web search tool is exposed (no Tavily alongside it), and
 *    tools/call returns results that carry the citation fields (title / URL /
 *    publication date) the acceptable-use terms require us to surface.
 * 2. Agent — createAgent() with only the web search tool enabled: the injected
 *    acceptable-use rules make the final answer cite URLs from the search
 *    results, even under a terse custom system prompt.
 *
 * Required env vars (the Gateway must be deployed with webSearchProvider 'agentcore'):
 *   AGENTCORE_GATEWAY_ENDPOINT  Gateway MCP endpoint (GatewayMcpEndpoint stack output)
 *   COGNITO_DOMAIN              <prefix>.auth.<region>.amazoncognito.com
 *   COGNITO_CLIENT_ID           Machine user client ID (MachineUserClientId output)
 *   COGNITO_CLIENT_SECRET       Machine user client secret
 * The agent layer additionally calls Bedrock with the default model.
 *
 * Run:
 *   cd packages/agent && npm run test:integration -- agentcore-web-search
 */

import { it, expect, beforeAll } from '@jest/globals';
import { GATEWAY_TOOL_NAMES } from '@moca/tool-definitions';
import { describeIfEnv } from '../../../tests/integration-helpers.js';
import { AgentCoreMCPClient } from '../../../libs/mcp/client.js';
import { createRequestContext, runWithContext } from '../../../libs/context/request-context.js';
import { createAgent } from '../../../agent.js';

const describeWithWebSearch = describeIfEnv(
  ['AGENTCORE_GATEWAY_ENDPOINT', 'COGNITO_DOMAIN', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET'],
  'AgentCore Web Search integration'
);

interface SearchResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
}

const URL_PATTERN = /https?:\/\/[^\s)\]"'>]+/g;

async function getMachineUserToken(): Promise<string> {
  const basic = Buffer.from(
    `${process.env.COGNITO_CLIENT_ID}:${process.env.COGNITO_CLIENT_SECRET}`
  ).toString('base64');
  const res = await fetch(`https://${process.env.COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: process.env.COGNITO_SCOPE || 'agent/invoke agent/tools',
    }),
  });
  if (!res.ok) throw new Error(`Cognito token request failed: HTTP ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/** The connector returns one text block holding `{ id, results: SearchResult[] }`. */
function parseResults(content: Array<{ type: string; text?: string }>): SearchResult[] {
  const text = content.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`No text content in tool result: ${JSON.stringify(content)}`);
  return (JSON.parse(text) as { results: SearchResult[] }).results;
}

const hostOf = (url: string): string => new URL(url).hostname;

describeWithWebSearch('AgentCore Web Search connector', () => {
  let authorizationHeader: string;
  const client = new AgentCoreMCPClient();

  const inContext = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(createRequestContext(authorizationHeader), fn);

  const search = async (args: Record<string, unknown>) => {
    const result = await inContext(() => client.callTool(GATEWAY_TOOL_NAMES.WEB_SEARCH, args));
    expect(result.isError).toBe(false);
    return parseResults(result.content as Array<{ type: string; text?: string }>);
  };

  beforeAll(async () => {
    authorizationHeader = `Bearer ${await getMachineUserToken()}`;
  }, 30000);

  describe('tool unit (Gateway tools/list + tools/call)', () => {
    it('exposes exactly one web search tool and no Tavily tools', async () => {
      const tools = await inContext(() => client.listTools());
      const names = tools.map((t) => t.name);

      expect(names.filter((n) => n === GATEWAY_TOOL_NAMES.WEB_SEARCH)).toHaveLength(1);
      expect(names.filter((n) => n.startsWith('tavily-tools___'))).toEqual([]);
    });

    it('publishes the query / maxResults / filters input schema', async () => {
      const tools = await inContext(() => client.listTools());
      const tool = tools.find((t) => t.name === GATEWAY_TOOL_NAMES.WEB_SEARCH)!;
      const schema = tool.inputSchema as {
        required?: string[];
        properties: Record<string, unknown>;
      };

      expect(schema.required).toEqual(['query']);
      expect(Object.keys(schema.properties)).toEqual(
        expect.arrayContaining(['query', 'maxResults', 'filters'])
      );
    });

    it('returns results carrying title, URL, and publication date for citation', async () => {
      const results = await search({ query: 'Amazon Bedrock AgentCore', maxResults: 3 });

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(3);
      for (const r of results) {
        expect(r.title).toEqual(expect.any(String));
        expect(r.url).toMatch(/^https?:\/\//);
        expect(r.text).toEqual(expect.any(String));
      }
      // Dates are optional per result, but the field must be populated for typical news/docs hits.
      expect(results.some((r) => typeof r.publishedDate === 'string')).toBe(true);
    }, 60000);

    // The connector rejects (not truncates) queries over 200 characters and surfaces
    // it as a tool error, so the model sees why and can retry with a shorter query.
    it('rejects queries longer than 200 characters as a tool error', async () => {
      const result = await inContext(() =>
        client.callTool(GATEWAY_TOOL_NAMES.WEB_SEARCH, { query: 'a'.repeat(201), maxResults: 1 })
      );

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/less than or equal to 200/);
    }, 60000);

    it('restricts results to the per-call domain include filter', async () => {
      const results = await search({
        query: 'AgentCore Gateway',
        maxResults: 5,
        filters: { domainFilter: { include: ['aws.amazon.com'] } },
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(hostOf(r.url!)).toMatch(/(^|\.)aws\.amazon\.com$/);
      }
    }, 60000);
  });

  describe('agent (createAgent + acceptable-use citation rules)', () => {
    it('cites URLs from the search results even under a terse custom prompt', async () => {
      const answer = await inContext(async () => {
        const { agent } = await createAgent({
          enabledTools: [GATEWAY_TOOL_NAMES.WEB_SEARCH],
          // Deliberately does not ask for sources: the citation requirement must
          // come from the runtime-injected rules, not from the agent's prompt.
          systemPrompt: 'You are a concise assistant. Answer in two sentences.',
        });
        for await (const event of agent.stream(
          'Use web search: what is Amazon Bedrock AgentCore Gateway?'
        )) {
          void event;
        }
        return agent.messages;
      });

      const blocks = answer.flatMap((m) => m.content as unknown as Array<Record<string, unknown>>);
      const searchedUrls = new Set(
        blocks
          .filter((b) => b.type === 'toolResultBlock')
          .flatMap((b) => JSON.stringify(b).match(URL_PATTERN) ?? [])
          .map((u) => u.replace(/\\+$/, ''))
      );
      const finalText = (answer[answer.length - 1].content as unknown as Array<{ text?: string }>)
        .map((b) => b.text ?? '')
        .join('');

      expect(searchedUrls.size).toBeGreaterThan(0);
      // Exact match (minus trailing punctuation): a bare domain must not count as a citation.
      const citedUrls = (finalText.match(URL_PATTERN) ?? [])
        .map((u) => u.replace(/[.,;:]+$/, ''))
        .filter((u) => searchedUrls.has(u));
      expect(citedUrls.length).toBeGreaterThan(0);
    }, 180000);
  });
});
