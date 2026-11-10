/**
 * Runtime side of a workflow step.
 *
 * The workflow orchestrator (a Lambda durable function) invokes this Runtime
 * once per step with `workflowStep` in the body and suspends on a durable
 * callback. This module gives the step agent a `submit_workflow_result` tool,
 * keeps the callback alive with heartbeats while the turn runs, and completes
 * the callback with the step result when the turn ends.
 */

import {
  LambdaClient,
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackHeartbeatCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import {
  AfterToolsEvent,
  tool,
  type Agent,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk';
import {
  WORKFLOW_LIMITS,
  WORKFLOW_SUBMIT_TOOL_NAME,
  workflowSubmitResultSchema,
  type WorkflowStepInvocation,
  type WorkflowStepResult,
  type WorkflowSubmitResult,
} from '@moca/tool-definitions';
import { config } from '../../config/index.js';
import { logger } from '../../libs/logger/index.js';

/** Must stay well under the orchestrator's callback heartbeatTimeout. */
export const WORKFLOW_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Prefix of the assistant message that ends a submitted turn (not part of the reply). */
const END_TURN_PREFIX = 'Submitted workflow step result';

/**
 * Per-turn submit tool plus a plugin that ends the turn right after it.
 *
 * The deliverable is the agent's reply text, not a tool argument: Claude
 * buffers a string argument until it is complete, so a long report passed as
 * an argument streams nothing for minutes and trips the Bedrock client's idle
 * timeout ("Stream ended without completing a message").
 *
 * The submission lives in a closure, not in `appState` (persisted with the
 * session, so a revision turn would read the previous round's). Ending the
 * turn from AfterToolsEvent keeps the model from answering the tool result
 * with an empty text block, which Bedrock rejects when the history is replayed
 * on the next revision.
 */
export function createSubmitResultTool() {
  let submitted: WorkflowSubmitResult | undefined;
  let endTurnPending = false;
  const submitTool = tool({
    name: WORKFLOW_SUBMIT_TOOL_NAME,
    description:
      'Submit the result of your workflow step. First write your complete deliverable as your ' +
      'reply text, then call this exactly once with the status. Your turn ends when you call it.',
    inputSchema: workflowSubmitResultSchema,
    callback: (input) => {
      submitted = input;
      endTurnPending = true;
      return 'Result recorded.';
    },
  });
  const plugin: Plugin = {
    name: 'moca:workflow-submit-end-turn',
    initAgent(agent: LocalAgent) {
      agent.addHook(AfterToolsEvent, (event) => {
        if (!endTurnPending) return;
        endTurnPending = false;
        event.endTurn = `${END_TURN_PREFIX} (${submitted?.status ?? 'done'}).`;
      });
    },
  };
  return { tool: submitTool, plugin, getSubmitted: () => submitted };
}

type Messages = Pick<Agent, 'messages'>['messages'];

function textOf(message: Messages[number]): string {
  return message.content
    .filter((b): b is typeof b & { type: 'textBlock'; text: string } => b.type === 'textBlock')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Assistant text written since the turn's prompt (the last user message with text). */
export function turnReplyText(messages: Messages): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user') {
      if (textOf(message)) break;
      continue;
    }
    const text = textOf(message);
    if (text && !text.startsWith(END_TURN_PREFIX)) parts.unshift(text);
  }
  return parts.join('\n\n');
}

function truncate(text: string): string {
  const max = WORKFLOW_LIMITS.MAX_OUTPUT_LENGTH;
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Text of the last assistant message — the fallback when the agent never submitted. */
export function lastAssistantText(agent: Pick<Agent, 'messages'>): string {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const message = agent.messages[i];
    if (message.role !== 'assistant') continue;
    const text = textOf(message);
    if (text) return text;
  }
  return '';
}

export function buildStepResult(
  submitted: WorkflowSubmitResult | undefined,
  agent: Pick<Agent, 'messages'>,
  sessionId: string | undefined
): WorkflowStepResult {
  if (submitted) {
    const reply = turnReplyText(agent.messages);
    return { ...submitted, output: truncate(reply || submitted.output || ''), sessionId };
  }
  return { status: 'done', output: truncate(lastAssistantText(agent)), implicit: true, sessionId };
}

let client: LambdaClient | undefined;
function getClient(): LambdaClient {
  client ??= new LambdaClient({ region: config.AWS_REGION });
  return client;
}

/**
 * Send heartbeats until the returned stop function is called. A missed
 * heartbeat lets the orchestrator detect a dead microVM in minutes instead of
 * waiting for the step's hard timeout.
 */
export function startCallbackHeartbeat(step: WorkflowStepInvocation): () => void {
  const timer = setInterval(() => {
    getClient()
      .send(new SendDurableExecutionCallbackHeartbeatCommand({ CallbackId: step.callbackId }))
      .catch((err: unknown) =>
        logger.warn({ err, stepId: step.stepId }, 'Workflow callback heartbeat failed')
      );
  }, WORKFLOW_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function completeStepCallback(
  step: WorkflowStepInvocation,
  outcome: { ok: true; result: WorkflowStepResult } | { ok: false; error: string }
): Promise<void> {
  const log = { workflowId: step.workflowId, stepId: step.stepId, role: step.role };
  try {
    if (outcome.ok) {
      await getClient().send(
        new SendDurableExecutionCallbackSuccessCommand({
          CallbackId: step.callbackId,
          Result: new TextEncoder().encode(JSON.stringify(outcome.result)),
        })
      );
      logger.info({ ...log, status: outcome.result.status }, 'Workflow step callback completed');
    } else {
      await getClient().send(
        new SendDurableExecutionCallbackFailureCommand({
          CallbackId: step.callbackId,
          Error: { ErrorType: 'StepFailed', ErrorMessage: outcome.error.slice(0, 1000) },
        })
      );
      logger.warn({ ...log, error: outcome.error }, 'Workflow step callback failed');
    }
  } catch (err) {
    // The orchestrator falls back to its heartbeat timeout, so this is
    // recoverable — but it delays the workflow, hence error level.
    logger.error({ ...log, err }, 'Failed to deliver workflow step callback');
  }
}
