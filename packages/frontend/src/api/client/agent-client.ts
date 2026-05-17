/**
 * Agent API Client
 * HTTP client for Agent Service (VITE_AGENT_ENDPOINT)
 */

import { BaseApiClient } from './base-client';

/**
 * Get Agent Service endpoint URL
 */
export function getAgentEndpoint(): string {
  return import.meta.env.VITE_AGENT_ENDPOINT || '';
}

/**
 * Encode ARN in Agent URL for AgentCore Runtime
 * @param url - URL to encode
 * @returns Encoded URL
 */
function encodeAgentUrl(url: string): string {
  if (url.includes('bedrock-agentcore') && url.includes('/runtimes/arn:')) {
    return url.replace(/\/runtimes\/(arn:[^/]+\/[^/]+)\//, (_match: string, arn: string) => {
      return `/runtimes/${encodeURIComponent(arn)}/`;
    });
  }
  return url;
}

/**
 * Agent API Client
 * Extends BaseApiClient for Agent Service (returns raw Response for streaming)
 */
class AgentClient extends BaseApiClient {
  constructor() {
    super('Agent');
  }

  /**
   * Make request to Agent Service
   * @param options - Fetch options
   * @returns Raw Response object (not JSON, for streaming support)
   */
  async invoke(options: RequestInit = {}): Promise<Response> {
    const url = encodeAgentUrl(getAgentEndpoint());
    return this.fetchWithAuth(url, options);
  }

  /**
   * Get agent configuration
   */
  getConfig() {
    return {
      endpoint: getAgentEndpoint(),
    };
  }

  /**
   * Test agent connection
   * @returns Connection status
   */
  async testConnection(): Promise<boolean> {
    try {
      let baseEndpoint = getAgentEndpoint()
        .replace('/invocations', '')
        .replace('?qualifier=DEFAULT', '');

      if (baseEndpoint.includes('bedrock-agentcore') && baseEndpoint.includes('/runtimes/arn:')) {
        baseEndpoint = baseEndpoint.replace(
          /\/runtimes\/(arn:[^/]+\/[^/]+)\//,
          (_match: string, arn: string) => {
            return `/runtimes/${encodeURIComponent(arn)}/`;
          }
        );
      }

      const response = await fetch(`${baseEndpoint}/ping`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

// Singleton instance
const agentClient = new AgentClient();

// Export instance for direct usage
export { agentClient };
