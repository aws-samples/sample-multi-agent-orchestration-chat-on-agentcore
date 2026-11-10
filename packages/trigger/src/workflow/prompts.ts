/**
 * Prompts sent to step agents. Each re-run repeats the original task because
 * the step session's history may have been trimmed by the conversation window.
 */

import {
  WORKFLOW_SUBMIT_TOOL_NAME,
  type WorkflowSpec,
  type WorkflowStep,
} from '@moca/tool-definitions';

export type WorkerRunReason =
  | { kind: 'initial' }
  | { kind: 'review'; feedback: string; round: number }
  | { kind: 'downstream'; fromStepId: string; feedback: string }
  | { kind: 'upstreamChanged'; changedStepIds: string[] };

/** Replace {{step_id.output}} placeholders with upstream outputs. */
export function renderTemplate(
  prompt: string,
  outputs: Record<string, string | undefined>
): string {
  return prompt.replace(/\{\{\s*([a-z][a-z0-9_]*)\.output\s*\}\}/g, (match, id: string) =>
    outputs[id] !== undefined ? (outputs[id] as string) : match
  );
}

export function ancestorsOf(spec: WorkflowSpec, stepId: string): Set<string> {
  const byId = new Map(spec.steps.map((s) => [s.id, s]));
  const result = new Set<string>();
  const stack = [...(byId.get(stepId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return result;
}

function upstreamSection(step: WorkflowStep, outputs: Record<string, string | undefined>): string {
  const deps = step.dependsOn ?? [];
  if (deps.length === 0) return '';
  const parts = deps.map((id) => `### ${id}\n${outputs[id] ?? '(no output)'}`);
  return `\n\n## Outputs of upstream steps\n${parts.join('\n\n')}`;
}

export function buildWorkerPrompt(
  spec: WorkflowSpec,
  step: WorkflowStep,
  outputs: Record<string, string | undefined>,
  reason: WorkerRunReason
): string {
  const ancestors = [...ancestorsOf(spec, step.id)];
  const header = [
    `You are executing step "${step.id}" of a multi-agent workflow.`,
    `Workflow goal: ${spec.goal}`,
  ];
  const situation: Record<WorkerRunReason['kind'], string> = {
    initial: '',
    review:
      reason.kind === 'review'
        ? `\n\n## Reviewer feedback (round ${reason.round})\nYour previous output was sent back. Revise it to address this feedback:\n${reason.feedback}`
        : '',
    downstream:
      reason.kind === 'downstream'
        ? `\n\n## Feedback from downstream step "${reason.fromStepId}"\nYour previous output could not be used. Redo the task addressing this:\n${reason.feedback}`
        : '',
    upstreamChanged:
      reason.kind === 'upstreamChanged'
        ? `\n\n## Upstream outputs changed\nSteps ${reason.changedStepIds.join(', ')} were redone. Redo your task using the updated outputs below.`
        : '',
  };
  const blockedHint =
    ancestors.length > 0
      ? `\n- If you cannot complete the task because the output of an upstream step (${ancestors.join(', ')}) is wrong or missing, call \`${WORKFLOW_SUBMIT_TOOL_NAME}\` with status "blocked", targetStepId set to that step, and concrete feedback on what must change.`
      : '';
  return `${header.join('\n')}

## Your task
${renderTemplate(step.prompt, outputs)}${upstreamSection(step, outputs)}${situation[reason.kind]}

## How to finish
- Write the complete deliverable as your reply text (the full text, not a summary or a file pointer — downstream steps only see this text).
- Then call \`${WORKFLOW_SUBMIT_TOOL_NAME}\` exactly once with status "done". Do not repeat the deliverable in the tool arguments.${blockedHint}`;
}

export function buildReviewerPrompt(
  spec: WorkflowSpec,
  step: WorkflowStep,
  outputs: Record<string, string | undefined>,
  workerOutput: string,
  round: number
): string {
  return `You are the reviewer for step "${step.id}" of a multi-agent workflow.
Workflow goal: ${spec.goal}

## Task given to the worker
${renderTemplate(step.prompt, outputs)}

## Acceptance criteria
${step.review?.criteria ?? ''}

## Worker output (round ${round})
${workerOutput}

## How to finish
Check the output strictly against the acceptance criteria and write a short review as your reply text. Then call \`${WORKFLOW_SUBMIT_TOOL_NAME}\` exactly once:
- status "done" if it meets the criteria, or
- status "needs_revision" with concrete, actionable \`feedback\`.`;
}
