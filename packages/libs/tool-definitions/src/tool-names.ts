/**
 * AgentCore Runtime Tool Names (built-in tools provided by the agent runtime).
 *
 * These names are defined in packages/libs/tool-definitions/src/definitions/.
 * Use these constants instead of raw string literals in enabledTools arrays to
 * catch typos at compile time and enable IDE auto-completion.
 */
export const RUNTIME_TOOL_NAMES = {
  EXECUTE_COMMAND: 'execute_command',
  FILE_EDITOR: 'file_editor',
  S3_LIST_FILES: 's3_list_files',
  CODE_INTERPRETER: 'code_interpreter',
  IMAGE_TO_TEXT: 'image_to_text',
  CALL_AGENT: 'call_agent',
  MANAGE_AGENT: 'manage_agent',
  MANAGE_TRIGGER: 'manage_trigger',
  MEMORY_SEARCH: 'memory_search',
  BROWSER: 'browser',
  TODO: 'todo',
  THINK: 'think',
  GENERATE_UI: 'generate_ui',
} as const;

export type RuntimeToolName = (typeof RUNTIME_TOOL_NAMES)[keyof typeof RUNTIME_TOOL_NAMES];

/**
 * AgentCore Gateway Tool Names
 *
 * AgentCore Gateway automatically composes the final tool name visible to agents as:
 *   {targetName}__{toolName}
 *
 * These constants are the single source of truth for Gateway-side tool names.
 * Always reference these constants instead of writing raw string literals to prevent
 * typos and stale references when target names or tool names change.
 *
 * Corresponding CDK definitions: packages/cdk/lib/agentcore-gateway-target-stack.ts
 */

export const GATEWAY_TOOL_NAMES = {
  // ── Utility Tools (always deployed) ──
  /** utility-tools__echo */
  UTILITY_ECHO: 'utility-tools___echo',
  /** utility-tools__ping */
  UTILITY_PING: 'utility-tools___ping',

  // ── Knowledge Base Tools (opt-in: requires knowledgeBaseIds in environments.ts) ──
  /** knowledge-base-tools__retrieve */
  KB_RETRIEVE: 'knowledge-base-tools___retrieve',

  // ── Nova Canvas Tools (always deployed) ──
  /** nova-canvas-tools__nova_canvas */
  NOVA_CANVAS: 'nova-canvas-tools___nova_canvas',

  // ── Nova Reel Tools (always deployed) ──
  /** nova-reel-tools__nova_reel */
  NOVA_REEL: 'nova-reel-tools___nova_reel',

  // ── Tavily Tools (opt-in: webSearchProvider 'tavily' + tavilyApiKeySecretName) ──
  /** tavily-tools___tavily_search */
  TAVILY_SEARCH: 'tavily-tools___tavily_search',
  /** tavily-tools___tavily_extract */
  TAVILY_EXTRACT: 'tavily-tools___tavily_extract',
  /** tavily-tools___tavily_crawl */
  TAVILY_CRAWL: 'tavily-tools___tavily_crawl',

  // ── AgentCore Web Search connector (webSearchProvider 'agentcore', the default) ──
  // Mutually exclusive with the Tavily tools: only one provider is deployed per environment.
  /** web-search___WebSearch */
  WEB_SEARCH: 'web-search___WebSearch',

  // ── Athena Tools (opt-in: requires athenaSourceBuckets in environments.ts) ──
  // Tool names are defined by the athena-tools Lambda package (athena-tools__*)

  // ── Built-in AgentCore Gateway Tools ──
  // Built-in tool provided by AgentCore Gateway itself for searching available tools.
  // See: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-tools.html
  /** x_amz_bedrock_agentcore_search */
  AGENTCORE_SEARCH: 'x_amz_bedrock_agentcore_search',
} as const;

export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[keyof typeof GATEWAY_TOOL_NAMES];

/**
 * Web search provider deployed to the Gateway. Mirrors `webSearchProvider` in
 * packages/cdk/config (CDK does not depend on this package, so the union is duplicated).
 */
export const WEB_SEARCH_PROVIDERS = ['tavily', 'agentcore'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchToolNames {
  /** The single web search tool */
  search: string;
  /** URL content extraction tools (empty when the provider has none) */
  extract: string[];
  /** Site crawl tools (empty when the provider has none) */
  crawl: string[];
}

/**
 * Gateway tool names exposed by the given web search provider.
 * Only one provider's target exists on the Gateway, so tools of the other one never resolve.
 */
export function getWebSearchToolNames(provider: WebSearchProvider): WebSearchToolNames {
  if (provider === 'agentcore') {
    return { search: GATEWAY_TOOL_NAMES.WEB_SEARCH, extract: [], crawl: [] };
  }
  return {
    search: GATEWAY_TOOL_NAMES.TAVILY_SEARCH,
    extract: [GATEWAY_TOOL_NAMES.TAVILY_EXTRACT],
    crawl: [GATEWAY_TOOL_NAMES.TAVILY_CRAWL],
  };
}

export function isWebSearchProvider(value: string): value is WebSearchProvider {
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}
