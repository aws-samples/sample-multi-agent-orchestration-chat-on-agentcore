import type { Message } from '../types/index';
import { deepParseJsonStrings, toolBaseName } from './tool-steps';

const WORKFLOW_ID_PATTERN = /^wf-[0-9a-f-]{36}$/;

/**
 * workflowId from a run_workflow start result, or null when it did not start one.
 * The content is the tool's JSON either as-is (live stream) or wrapped in
 * content blocks (`[{ text: "<json>" }]`) when restored from history.
 */
export function parseStartedWorkflowId(content: string | undefined): string | null {
  if (!content) return null;
  const parsed = deepParseJsonStrings(content);
  const candidates = Array.isArray(parsed)
    ? parsed.map((block) =>
        block && typeof block === 'object' ? (block.text ?? block.json ?? block) : block
      )
    : [parsed];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { success, workflowId } = candidate as { success?: unknown; workflowId?: unknown };
    if (
      success === true &&
      typeof workflowId === 'string' &&
      WORKFLOW_ID_PATTERN.test(workflowId)
    ) {
      return workflowId;
    }
  }
  return null;
}

/**
 * Workflows started in this session, oldest first. The run_workflow start
 * results in the history are the source of truth, so no session index is
 * needed on the Backend.
 */
export function extractSessionWorkflowIds(messages: readonly Message[]): string[] {
  const startUseIds = new Set<string>();
  const ids: string[] = [];
  for (const message of messages) {
    for (const content of message.contents) {
      const use = content.toolUse;
      if (use && toolBaseName(use.name) === 'run_workflow' && use.input?.action === 'start') {
        startUseIds.add(use.id);
        if (use.originalToolUseId) startUseIds.add(use.originalToolUseId);
      }
      const result = content.toolResult;
      if (result && startUseIds.has(result.toolUseId)) {
        const id = parseStartedWorkflowId(result.content);
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}
