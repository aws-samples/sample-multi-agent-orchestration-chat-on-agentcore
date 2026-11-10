import { describe, expect, it } from '@jest/globals';
import { GATEWAY_TOOL_NAMES } from '@moca/tool-definitions';
import { buildDefaultAgents } from '../default-agents.js';

const TAVILY_TOOLS: string[] = [
  GATEWAY_TOOL_NAMES.TAVILY_SEARCH,
  GATEWAY_TOOL_NAMES.TAVILY_EXTRACT,
  GATEWAY_TOOL_NAMES.TAVILY_CRAWL,
];

const countUsing = (provider: 'tavily' | 'agentcore', tool: string): number =>
  buildDefaultAgents(provider).filter((a) => a.enabledTools?.includes(tool)).length;

describe('buildDefaultAgents', () => {
  it('references only Tavily tools for the tavily provider', () => {
    const json = JSON.stringify(buildDefaultAgents('tavily'));
    expect(json).toContain(GATEWAY_TOOL_NAMES.TAVILY_EXTRACT);
    expect(json).not.toContain(GATEWAY_TOOL_NAMES.WEB_SEARCH);
  });

  it('references only the AgentCore Web Search tool for the agentcore provider', () => {
    const json = JSON.stringify(buildDefaultAgents('agentcore'));
    for (const name of TAVILY_TOOLS) expect(json).not.toContain(name);
    expect(countUsing('agentcore', GATEWAY_TOOL_NAMES.WEB_SEARCH)).toBe(
      countUsing('tavily', GATEWAY_TOOL_NAMES.TAVILY_SEARCH)
    );
  });
});
