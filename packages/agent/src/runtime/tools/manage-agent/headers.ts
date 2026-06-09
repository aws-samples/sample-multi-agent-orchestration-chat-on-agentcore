/**
 * Request-header construction and the backend response shape for the
 * manage_agent tool.
 */

import { getCurrentContext } from '../../../libs/context/request-context.js';

/**
 * Build request headers for backend API calls.
 *
 * Forwards the Cognito ID Token from the current RequestContext as
 * X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token because the Backend
 * `authMiddleware` requires it to resolve the Identity Pool identityId.
 *
 * Automatically includes X-Target-User-Id when running as a machine user
 * (e.g., EventBridge Scheduler triggered execution).
 */
export function buildRequestHeaders(authHeader: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
  };
  const context = getCurrentContext();
  if (context?.idToken) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = context.idToken;
  }
  if (context?.userId) {
    headers['X-Target-User-Id'] = context.userId;
  }
  return headers;
}

/**
 * Backend API response type
 */
export interface AgentResponse {
  agent: {
    agentId: string;
    name: string;
    description: string;
    systemPrompt: string;
    enabledTools: string[];
    icon?: string;
    scenarios?: Array<{ id: string; title: string; prompt: string }>;
    createdAt: string;
    updatedAt: string;
  };
  metadata: {
    requestId: string;
    timestamp: string;
    userId: string;
  };
}
