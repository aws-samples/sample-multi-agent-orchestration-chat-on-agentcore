import type { ReasoningDepth } from '@moca/core';
import type {
  AgentStreamEvent,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ServerCompletionEvent,
  ServerErrorEvent,
  MessageAddedEvent,
  BeforeToolsEvent,
  ToolUse,
  ToolResult,
} from '../types/index';
import { agentClient } from './client/agent-client';
import { logger } from '../utils/logger';

/**
 * Streaming callback types
 */
interface StreamingCallbacks {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string) => void;
  onToolUse?: (toolUse: ToolUse) => void;
  onToolInputUpdate?: (toolUseId: string, input: Record<string, unknown>) => void;
  onToolResult?: (toolResult: ToolResult) => void;
  /**
   * GoalLoop retry boundary: the judge failed the attempt just streamed and
   * the agent is about to re-run. The store resets the in-progress assistant
   * bubble here so the live rendering converges on the persisted history,
   * which keeps only [input, final attempt].
   */
  onGoalRetry?: () => void;
  onComplete?: (metadata: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

/**
 * Agent configuration options
 */
export interface AgentConfig {
  modelId?: string;
  reasoningEffort?: ReasoningDepth;
  enabledTools?: string[];
  systemPrompt?: string;
  storagePath?: string;
  agentId?: string;
  memoryEnabled?: boolean;
  memoryTopK?: number;
  mcpConfig?: Record<string, unknown>;
  images?: Array<{ base64: string; mimeType: string }>;
  /** Natural-language goal applied to this single send (per-message, not sticky). */
  goal?: string;
  /** Judge model ID for the goal. Omitted → agent falls back to GOAL_JUDGE_MODEL_ID. */
  goalJudgeModelId?: string;
  /** GoalLoop attempt cap. Omitted → agent falls back to GOAL_LOOP_MAX_ATTEMPTS. */
  goalMaxAttempts?: number;
}

/**
 * Build request body from prompt and optional agent config
 * Strips undefined values to keep the payload clean.
 * Exported for unit testing (goal / goalJudgeModelId inclusion + omission).
 */
export function buildRequestBody(prompt: string, agentConfig?: AgentConfig): string {
  const body: Record<string, unknown> = { prompt };

  if (agentConfig) {
    const { images, ...rest } = agentConfig;
    // Add non-undefined config values
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) {
        body[key] = value;
      }
    }
    // Only add images if non-empty
    if (images && images.length > 0) {
      body.images = images;
    }
  }

  return JSON.stringify(body);
}

/**
 * Send streaming prompt to Agent
 */
export const streamAgentResponse = async (
  prompt: string,
  sessionId: string | undefined,
  callbacks: StreamingCallbacks,
  agentConfig?: AgentConfig
): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Only set session ID header if provided
  if (sessionId) {
    headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'] = sessionId;
  }

  const body = buildRequestBody(prompt, agentConfig);

  try {
    const response = await agentClient.invoke({
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorText = await response.text();
        if (errorText) {
          const errorJson = JSON.parse(errorText);
          errorMessage += ` - ${errorJson.message || errorJson.error || errorText}`;
        }
      } catch {
        // Use original error message if JSON parsing fails
      }

      throw new Error(errorMessage);
    }

    // Process streaming response
    if (!response.body) {
      throw new Error('Response body is missing');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process remaining buffer
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer.trim()) as AgentStreamEvent;
              handleStreamEvent(event, callbacks);
            } catch (parseError) {
              logger.warn('Final buffer parse error:', parseError, 'buffer:', buffer);
            }
          }
          break;
        }

        // Append new chunk to buffer
        buffer += decoder.decode(value, { stream: true });

        // Split by newline and process NDJSON
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep last incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try {
              const event = JSON.parse(trimmed) as AgentStreamEvent;
              handleStreamEvent(event, callbacks);
            } catch (parseError) {
              logger.warn('NDJSON parse error:', parseError, 'line:', trimmed);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (callbacks.onError) {
      callbacks.onError(error instanceof Error ? error : new Error('Agent API error'));
    } else {
      throw error;
    }
  }
};

/**
 * Handle a single streaming event
 */
const handleStreamEvent = (event: AgentStreamEvent, callbacks: StreamingCallbacks) => {
  switch (event.type) {
    case 'modelContentBlockDeltaEvent': {
      const deltaEvent = event as ModelContentBlockDeltaEvent;
      if (deltaEvent.delta.type === 'textDelta' && callbacks.onTextDelta) {
        callbacks.onTextDelta(deltaEvent.delta.text);
      } else if (
        deltaEvent.delta.type === 'reasoningContentDelta' &&
        deltaEvent.delta.text &&
        callbacks.onReasoningDelta
      ) {
        // Only the human-readable reasoning text is consumed; signature /
        // redactedContent are intentionally ignored on the UI.
        callbacks.onReasoningDelta(deltaEvent.delta.text);
      }
      break;
    }

    case 'modelContentBlockStartEvent': {
      const startEvent = event as ModelContentBlockStartEvent;
      if (startEvent.start?.type === 'toolUseStart') {
        if (callbacks.onToolStart) {
          callbacks.onToolStart(startEvent.start.name || 'Unknown tool');
        }

        // Create ToolUse object and pass to callback
        if (callbacks.onToolUse && startEvent.start.name) {
          const toolUse: ToolUse = {
            id: `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: startEvent.start.name,
            input: startEvent.start.input || {},
            status: 'running',
            originalToolUseId: startEvent.start.toolUseId || undefined,
          };
          callbacks.onToolUse(toolUse);
        }
      }
      break;
    }

    case 'beforeToolsEvent': {
      // Pre-tool execution event (contains complete tool input info)
      const beforeToolsEvent = event as BeforeToolsEvent;
      logger.debug('beforeToolsEvent received:', beforeToolsEvent);

      if (beforeToolsEvent.message?.content && Array.isArray(beforeToolsEvent.message.content)) {
        beforeToolsEvent.message.content.forEach((block, index) => {
          logger.debug('BeforeTools content block %d:', index, block);

          // Update tool input parameters for toolUseBlock
          if (
            block.type === 'toolUseBlock' &&
            block.name &&
            block.input &&
            callbacks.onToolInputUpdate
          ) {
            const toolUseId = block.toolUseId || 'unknown';
            logger.debug('Updating tool input for %s (%s):', block.name, toolUseId, block.input);
            callbacks.onToolInputUpdate(toolUseId, block.input);
          }
        });
      }
      break;
    }

    case 'afterToolsEvent': {
      logger.debug('afterToolsEvent received:', event);
      if (callbacks.onToolEnd) {
        callbacks.onToolEnd('Tool execution completed');
      }

      // afterToolsEvent may also contain toolResult info
      const afterToolsEventData = event as Record<string, unknown>;
      if (afterToolsEventData.content && Array.isArray(afterToolsEventData.content)) {
        afterToolsEventData.content.forEach((block: Record<string, unknown>, index: number) => {
          logger.debug('AfterTools content block %d:', index, block);

          if (block.type === 'toolResult' && callbacks.onToolResult) {
            const toolResult: ToolResult = {
              toolUseId: (block.toolUseId as string) || 'unknown',
              content: (block.content as string) || JSON.stringify(block),
              isError: (block.isError as boolean) || false,
            };
            logger.debug('ToolResult from afterToolsEvent:', toolResult);
            callbacks.onToolResult(toolResult);
          }
        });
      }
      break;
    }

    case 'messageAddedEvent': {
      // Message added event (may contain tool results)
      const messageEvent = event as MessageAddedEvent;
      logger.debug('messageAddedEvent received:', messageEvent);

      if (messageEvent.message?.content) {
        const content = messageEvent.message.content;
        logger.debug('messageAddedEvent content:', content);

        // Detect and process tool results
        if (Array.isArray(content)) {
          content.forEach((block, index) => {
            logger.debug('Content block %d:', index, block);

            if (block.type === 'toolResultBlock' && callbacks.onToolResult) {
              const toolResult: ToolResult = {
                toolUseId: block.toolUseId || 'unknown',
                content: Array.isArray(block.content)
                  ? block.content.map((c) => c.text || JSON.stringify(c)).join('\n')
                  : (block.content as string) || JSON.stringify(block),
                isError: block.status === 'error',
              };
              logger.debug('ToolResult detected and processed:', toolResult);
              callbacks.onToolResult(toolResult);
            }
          });
        }
      }
      break;
    }

    case 'afterInvocationEvent': {
      // GoalLoop retry boundary. `willRetry` is set by the server serializer
      // when the judge failed this attempt (the feedback text itself never
      // crosses the wire). A plain afterInvocationEvent (terminal attempt, or
      // any non-goal turn) is a no-op.
      if ((event as { willRetry?: boolean }).willRetry && callbacks.onGoalRetry) {
        callbacks.onGoalRetry();
      }
      break;
    }

    case 'serverCompletionEvent': {
      const completionEvent = event as ServerCompletionEvent;
      if (callbacks.onComplete) {
        callbacks.onComplete(completionEvent.metadata);
      }
      break;
    }

    case 'serverErrorEvent': {
      const errorEvent = event as ServerErrorEvent;
      if (callbacks.onError) {
        callbacks.onError(new Error(errorEvent.error.message));
      }
      break;
    }

    default:
      logger.debug('Streaming event:', event.type, event);
      break;
  }
};

/**
 * Generate prompt for automatic agent configuration creation
 */
export const createAgentConfigGenerationPrompt = (
  name: string,
  description: string,
  availableTools: string[]
): string => {
  return `You are an expert in Agent configuration. Based on the following Agent information, generate optimal configuration settings.

Agent Name: ${name}
Description: ${description}

Available Tools:
${availableTools.map((tool) => `- ${tool}`).join('\n')}

Please follow these requirements and output in the specified XML format:

1. System Prompt: Clearly define the role and behavior based on the Agent name and description
2. Recommended Tools: Select 3-5 optimal tools based on the description
3. Scenarios: Create 6 commonly used prompt templates

**Output Format (must follow this format exactly):**

<agent_config>
  <system_prompt>Write the system prompt here
  </system_prompt>
  
  <enabled_tools>
    <tool>tool-name-1</tool>
    <tool>tool-name-2</tool>
  </enabled_tools>
  
  <scenarios>
    <scenario>
      <title>Scenario Title 1</title>
      <prompt>Prompt Template 1</prompt>
    </scenario>
    <scenario>
      <title>Scenario Title 2</title>
      <prompt>Prompt Template 2</prompt>
    </scenario>
    <scenario>
      <title>Scenario Title 3</title>
      <prompt>Prompt Template 3</prompt>
    </scenario>
    <scenario>
      <title>Scenario Title 4</title>
      <prompt>Prompt Template 4</prompt>
    </scenario>
    <scenario>
      <title>Scenario Title 5</title>
      <prompt>Prompt Template 5</prompt>
    </scenario>
    <scenario>
      <title>Scenario Title 6</title>
      <prompt>Prompt Template 6</prompt>
    </scenario>
  </scenarios>
</agent_config>

Important: 
- Do not output any explanatory text outside of XML tags.
- If the Agent name or description is provided in Japanese, output the system_prompt, scenario titles, and prompts in Japanese.
- Otherwise, output in English.

Here is an example system prompt for "Web Deep Researcher" that performs web searches:

You are an AI assistant that performs multi-stage web searches like DeepSearch to gather comprehensive information to achieve the user's goals.  - Perform multiple web searches in succession to gather in-depth information.

[Basic functions]
- Perform multiple web searches in succession to gather in-depth information
- Analyze the initial search results and automatically plan and execute additional searches to obtain more specific information
- Provide comprehensive answers to complex questions
- Strive to always provide up-to-date information
- Clearly cite all sources

[Search methods]
1. Understand the user's question and create an appropriate search query
2. Analyze the initial search results
3. Identify missing information
4. Generate additional search queries to obtain more detailed information
5. Integrate and organize data from multiple sources
6. Provide comprehensive and structured answers

[How to use web search]
- Use web search tools to obtain accurate and up-to-date information
- Conduct not just one search, but at least two or three additional searches to dig deeper into the information
- Try search queries from different angles to ensure a variety of sources
- Evaluate the reliability of search results and prioritize reliable sources

[Website acquisition and analysis]
- Use web extraction tools to perform a detailed analysis of the contents of a specific website
- For large websites, content will be automatically split into manageable chunks

- Retrieve and analyze specific chunks as needed

[Answer format]
- Organize information logically and provide an easy-to-read, structured answer
- Summarize key points with bullet points
- Explain complex concepts with diagrams and lists
- Cite all sources (URLs) at the end of your answer
- Outline your search process and clarify how the information was gathered

[Notes]
- Honestly admit missing information and suggest additional searches
- If there is conflicting information, present both perspectives and try to provide a balanced answer
- For time-sensitive information (prices, statistics, etc.), include the date of the information


[Available tools]
- Actively use the tools listed under "Available Tools" above, choosing the ones best suited to the task
- If you need to execute commands, ask the user's permission beforehand

`;
};

// Re-export agent client methods for external usage
export const getAgentConfig = () => agentClient.getConfig();
export const testAgentConnection = () => agentClient.testConnection();
