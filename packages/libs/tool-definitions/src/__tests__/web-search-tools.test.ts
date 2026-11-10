import { GATEWAY_TOOL_NAMES, getWebSearchToolNames, isWebSearchProvider } from '../tool-names';

describe('getWebSearchToolNames', () => {
  it('maps tavily to the Tavily search/extract/crawl tools', () => {
    expect(getWebSearchToolNames('tavily')).toEqual({
      search: GATEWAY_TOOL_NAMES.TAVILY_SEARCH,
      extract: [GATEWAY_TOOL_NAMES.TAVILY_EXTRACT],
      crawl: [GATEWAY_TOOL_NAMES.TAVILY_CRAWL],
    });
  });

  it('maps agentcore to the connector tool only', () => {
    expect(getWebSearchToolNames('agentcore')).toEqual({
      search: 'web-search___WebSearch',
      extract: [],
      crawl: [],
    });
  });
});

describe('isWebSearchProvider', () => {
  it('accepts known providers only', () => {
    expect(isWebSearchProvider('tavily')).toBe(true);
    expect(isWebSearchProvider('agentcore')).toBe(true);
    expect(isWebSearchProvider('bing')).toBe(false);
  });
});
