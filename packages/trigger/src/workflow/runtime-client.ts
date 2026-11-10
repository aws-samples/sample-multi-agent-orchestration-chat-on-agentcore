/**
 * Starts agent turns on the AgentCore Runtime on behalf of a user, using the
 * same credentials as event-driven triggers: a machine-user access token plus
 * a developer-auth OpenID token, both minted per turn so a workflow is never
 * bounded by a browser session's 1 h tokens.
 */

import { RUNTIME_TOOL_NAMES, type WorkflowStepInvocation } from '@moca/tool-definitions';
import { AuthService } from '../services/auth-service.js';
import { AgentsService } from '../services/agents-service.js';
import { encodeAgentUrl } from '../services/agent-invoker.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('WorkflowRuntimeClient');

/** How long to wait for the first stream line when probing for a running turn. */
const FIRST_LINE_TIMEOUT_MS = 20_000;

export interface StartTurnParams {
  userId: string;
  sessionId: string;
  sessionType: string;
  agentId: string;
  prompt: string;
  modelId?: string;
  storagePath?: string;
  workflowStep?: WorkflowStepInvocation;
}

export class AgentNotFoundError extends Error {}

export class RuntimeClient {
  private machineToken?: { value: string; expiresAt: number };

  constructor(
    private readonly auth: AuthService,
    private readonly agents: AgentsService,
    private readonly agentApiUrl: string
  ) {}

  private async getMachineToken(): Promise<string> {
    if (this.machineToken && this.machineToken.expiresAt > Date.now() + 60_000) {
      return this.machineToken.value;
    }
    const token = await this.auth.getMachineUserToken();
    this.machineToken = {
      value: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
    };
    return token.accessToken;
  }

  /**
   * StopRuntimeSession over HTTPS with the machine token: a JWT-authorized
   * runtime rejects the SigV4 SDK call ("Authorization method mismatch").
   */
  async stopSession(sessionId: string): Promise<StopSessionResult> {
    const accessToken = await this.getMachineToken();
    const url = encodeAgentUrl(this.agentApiUrl).replace('/invocations', '/stopruntimesession');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
      },
      body: '{}',
    });
    if (!response.ok) {
      log.warn(
        { sessionId, status: response.status, body: (await response.text()).slice(0, 300) },
        'StopRuntimeSession failed'
      );
    }
    return { ok: response.ok, status: response.status };
  }

  /**
   * Send the turn and return once the Runtime accepted it; the turn keeps
   * running server-side after this Lambda invocation suspends.
   * `inProgress` is true when the session already had a running turn.
   */
  async startTurn(params: StartTurnParams): Promise<{ inProgress: boolean }> {
    const agent = await this.agents.getAgent(params.userId, params.agentId);
    if (!agent) throw new AgentNotFoundError(`Agent not found: ${params.agentId}`);

    // Steps never fan out further: nested workflows would multiply runtime
    // sessions without bound.
    const enabledTools = params.workflowStep
      ? agent.enabledTools.filter(
          (t) => t !== RUNTIME_TOOL_NAMES.CALL_AGENT && t !== RUNTIME_TOOL_NAMES.RUN_WORKFLOW
        )
      : agent.enabledTools;

    const [accessToken, { openIdToken }] = await Promise.all([
      this.getMachineToken(),
      this.auth.getOpenIdTokenForUser(params.userId),
    ]);

    const response = await fetch(encodeAgentUrl(this.agentApiUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': params.sessionId,
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Type': params.sessionType,
        'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token': openIdToken,
      },
      body: JSON.stringify({
        prompt: params.prompt,
        targetUserId: params.userId,
        agentId: params.agentId,
        modelId: params.modelId,
        storagePath: params.storagePath ?? '/',
        systemPrompt: agent.systemPrompt,
        enabledTools,
        mcpConfig: agent.mcpConfig,
        workflowStep: params.workflowStep,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Agent API returned ${response.status}: ${text.slice(0, 500)}`);
    }

    const firstLine = await readFirstLine(response, FIRST_LINE_TIMEOUT_MS);
    const inProgress = firstLine?.includes('"serverTurnInProgressEvent"') ?? false;
    log.info(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
        stepId: params.workflowStep?.stepId,
        role: params.workflowStep?.role,
        inProgress,
      },
      'Runtime accepted turn'
    );
    return { inProgress };
  }
}

export interface StopSessionResult {
  ok: boolean;
  status: number;
}

async function readFirstLine(response: Response, timeoutMs: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const newline = buffer.indexOf('\n');
    if (newline >= 0) return buffer.slice(0, newline);
  }
  return buffer || undefined;
}
