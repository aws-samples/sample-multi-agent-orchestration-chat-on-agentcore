/**
 * Service for invoking Agent API
 */

import { generateSessionId } from '@moca/core';
import { SchedulerEventPayload, EventDrivenContext } from '../types/index.js';
import { AgentsService, MCPConfig } from './agents-service.js';
import { buildEventDrivenPrompt } from './prompt-builder.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('AgentInvoker');

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
 * Agent invocation request
 */
interface AgentInvocationRequest {
  prompt: string;
  modelId?: string;
  storagePath?: string;
  enabledTools?: string[];
  targetUserId: string;
  sessionId?: string;
  systemPrompt?: string;
  mcpConfig?: MCPConfig;
  agentId?: string;
}

/**
 * Agent invocation response
 */
interface AgentInvocationResponse {
  requestId: string;
  sessionId?: string;
  success: boolean;
  error?: string;
}

/**
 * Prepared request for Agent API
 */
interface PreparedRequest {
  request: AgentInvocationRequest;
  sessionId: string;
}

/**
 * Service for invoking Agent /invocations API
 */
export class AgentInvoker {
  private readonly agentApiUrl: string;
  private readonly agentsService: AgentsService;

  constructor(agentApiUrl: string, agentsService: AgentsService) {
    // Encode ARN in URL if needed
    this.agentApiUrl = encodeAgentUrl(agentApiUrl);
    this.agentsService = agentsService;
    log.info({ url: this.agentApiUrl }, 'AgentInvoker initialized');
  }

  /**
   * Build Agent invocation request from payload and agent configuration
   */
  private async prepareRequest(
    payload: SchedulerEventPayload,
    eventContext?: EventDrivenContext
  ): Promise<PreparedRequest> {
    log.info({ userId: payload.userId, agentId: payload.agentId }, 'Fetching Agent configuration');

    const agent = await this.agentsService.getAgent(payload.userId, payload.agentId);

    if (!agent) {
      throw new Error(`Agent not found: ${payload.agentId}`);
    }

    log.info(
      {
        name: agent.name,
        systemPrompt: agent.systemPrompt.substring(0, 100) + '...',
        enabledTools: agent.enabledTools,
        hasMcpConfig: !!agent.mcpConfig,
      },
      'Agent configuration fetched'
    );

    const prompt = eventContext
      ? buildEventDrivenPrompt(payload.prompt, eventContext)
      : payload.prompt;

    log.info(
      {
        hasEventContext: !!eventContext,
        originalLength: payload.prompt.length,
        finalLength: prompt.length,
      },
      'Prompt preparation'
    );

    const sessionId = payload.sessionId || generateSessionId();

    return {
      request: {
        prompt,
        targetUserId: payload.userId,
        sessionId,
        modelId: payload.modelId,
        storagePath: payload.workingDirectory ?? '/',
        systemPrompt: agent.systemPrompt,
        enabledTools: agent.enabledTools,
        mcpConfig: agent.mcpConfig,
        agentId: payload.agentId,
      },
      sessionId,
    };
  }

  /**
   * Send HTTP request to Agent API
   */
  private async sendRequest(
    request: AgentInvocationRequest,
    sessionId: string,
    authToken: string,
    openIdToken?: string
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Type': 'event',
      'X-Amzn-Trace-Id': `trigger-${Date.now()}`,
    };

    // Forward the per-user OpenID Token so the AgentCore Runtime can exchange it
    // for Identity Pool credentials via GetCredentialsForIdentity.
    // This enables event-driven agent executions to read/write the user's S3
    // prefix and DynamoDB sessions table with the same per-user isolation as
    // frontend-initiated invocations.
    if (openIdToken) {
      headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token'] = openIdToken;
    }

    const response = await fetch(this.agentApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Agent API returned ${response.status}: ${errorText}`);
    }

    return response;
  }

  /**
   * Invoke Agent asynchronously (fire-and-forget)
   * Sends the request, verifies HTTP 200 acceptance, and returns immediately
   * without reading the NDJSON stream. AgentCore continues processing server-side.
   *
   * @param payload    Event payload from EventBridge Scheduler / custom event
   * @param authToken  Machine User access token (Client Credentials Flow)
   * @param eventContext Optional event-driven context for prompt augmentation
   * @param openIdToken Optional per-user OpenID Token from GetOpenIdTokenForDeveloperIdentity.
   *                    When provided, forwarded as X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token
   *                    so the Runtime can obtain per-user Identity Pool credentials.
   */
  async invokeAsync(
    payload: SchedulerEventPayload,
    authToken: string,
    eventContext?: EventDrivenContext,
    openIdToken?: string
  ): Promise<AgentInvocationResponse> {
    try {
      const { request, sessionId } = await this.prepareRequest(payload, eventContext);

      log.info(
        {
          url: this.agentApiUrl,
          triggerId: payload.triggerId,
          agentId: payload.agentId,
          sessionId,
          hasOpenIdToken: !!openIdToken,
        },
        'Invoking Agent API (async fire-and-forget)'
      );

      await this.sendRequest(request, sessionId, authToken, openIdToken);

      log.info('Agent API accepted invocation (HTTP 200); returning without reading stream');

      return { requestId: '', sessionId, success: true };
    } catch (error) {
      log.error({ err: error }, 'Failed to invoke Agent (async)');
      return {
        requestId: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create AgentInvoker from environment variables
   */
  static fromEnvironment(agentsService: AgentsService): AgentInvoker {
    const agentApiUrl = process.env.AGENT_API_URL;

    if (!agentApiUrl) {
      throw new Error('AGENT_API_URL environment variable is required');
    }

    return new AgentInvoker(agentApiUrl, agentsService);
  }
}
