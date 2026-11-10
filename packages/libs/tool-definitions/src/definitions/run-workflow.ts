import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

/**
 * Workflow limits. Shared by the tool schema, the Backend validator and the
 * orchestrator so a spec accepted at the edge is never rejected mid-run.
 */
export const WORKFLOW_LIMITS = {
  MAX_STEPS: 10,
  MAX_CONCURRENCY: 3,
  DEFAULT_CONCURRENCY: 3,
  MAX_REVIEW_ITERATIONS: 3,
  DEFAULT_REVIEW_ITERATIONS: 2,
  /** Upstream re-runs requested by downstream steps, across the whole workflow. */
  MAX_ESCALATIONS: 3,
  MAX_PROMPT_LENGTH: 20_000,
  /** Step output kept in the workflow record and passed to dependants. */
  MAX_OUTPUT_LENGTH: 20_000,
} as const;

const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const workflowReviewSchema = z.object({
  agentId: z.string().min(1).describe('Agent ID of the reviewer'),
  criteria: z
    .string()
    .min(1)
    .max(4000)
    .describe('Acceptance criteria the reviewer checks the output against'),
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_LIMITS.MAX_REVIEW_ITERATIONS)
    .optional()
    .describe(
      `Max work→review rounds (default ${WORKFLOW_LIMITS.DEFAULT_REVIEW_ITERATIONS}, max ${WORKFLOW_LIMITS.MAX_REVIEW_ITERATIONS})`
    ),
});

export const workflowStepSchema = z.object({
  id: z
    .string()
    .regex(STEP_ID_PATTERN, 'Step id must be snake_case (a-z, 0-9, _), max 40 chars')
    .describe('Unique step id in snake_case, e.g. "research_a"'),
  agentId: z.string().min(1).describe('Agent ID that performs this step (from list_agents)'),
  prompt: z
    .string()
    .min(1)
    .max(WORKFLOW_LIMITS.MAX_PROMPT_LENGTH)
    .describe(
      'Task for the agent. Reference outputs of dependencies with {{step_id.output}}; ' +
        'outputs of all dependencies are also appended automatically.'
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe('Step ids that must complete first. Steps without dependencies run in parallel.'),
  modelId: z.string().optional().describe('Model ID override (defaults to the agent config)'),
  review: workflowReviewSchema
    .optional()
    .describe('Optional reviewer loop: the reviewer approves or sends feedback for a revision'),
});

export const workflowSpecSchema = z.object({
  goal: z.string().min(1).max(4000).describe('Overall goal of the workflow'),
  steps: z
    .array(workflowStepSchema)
    .min(1)
    .max(WORKFLOW_LIMITS.MAX_STEPS)
    .describe(`Workflow steps (max ${WORKFLOW_LIMITS.MAX_STEPS})`),
  maxConcurrency: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_LIMITS.MAX_CONCURRENCY)
    .optional()
    .describe(`Max steps running at once (default ${WORKFLOW_LIMITS.DEFAULT_CONCURRENCY})`),
  notifyOnComplete: z
    .boolean()
    .optional()
    .describe(
      'When true (default), the calling agent is resumed in this session with the workflow result once it finishes'
    ),
});

export type WorkflowReview = z.infer<typeof workflowReviewSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;

/**
 * Structural checks zod cannot express: unique ids, known dependencies and an
 * acyclic graph. Returns human-readable problems (empty = valid) so the tool
 * can hand them back to the model verbatim.
 */
export function validateWorkflowSpec(spec: WorkflowSpec): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of spec.steps) {
    if (ids.has(step.id)) problems.push(`Duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of spec.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) problems.push(`Step "${step.id}" depends on unknown step "${dep}"`);
      if (dep === step.id) problems.push(`Step "${step.id}" depends on itself`);
    }
  }
  if (problems.length > 0) return problems;

  // Kahn's algorithm: anything left over sits on a cycle.
  const indegree = new Map(spec.steps.map((s) => [s.id, (s.dependsOn ?? []).length]));
  const queue = spec.steps.filter((s) => (s.dependsOn ?? []).length === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const step of spec.steps) {
      if ((step.dependsOn ?? []).includes(id)) {
        const next = indegree.get(step.id)! - 1;
        indegree.set(step.id, next);
        if (next === 0) queue.push(step.id);
      }
    }
  }
  if (visited !== spec.steps.length) {
    const cyclic = [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
    problems.push(`Dependency cycle among steps: ${cyclic.join(', ')}`);
  }
  return problems;
}

// ── Step ↔ Runtime contract ────────────────────────────────────────────────

/** Tool injected into agents that run a workflow step. Not user-selectable. */
export const WORKFLOW_SUBMIT_TOOL_NAME = 'submit_workflow_result';

export type WorkflowStepRole = 'worker' | 'reviewer';

/**
 * Carried in the `/invocations` body when the orchestrator runs a step.
 * The Runtime honours it only for machine-user callers.
 */
export interface WorkflowStepInvocation {
  workflowId: string;
  stepId: string;
  role: WorkflowStepRole;
  /** Lambda durable execution callback id the Runtime completes when the turn ends. */
  callbackId: string;
}

export const workflowSubmitResultSchema = z.object({
  status: z
    .enum(['done', 'needs_revision', 'blocked'])
    .describe(
      "'done': task complete (reviewer: output approved). " +
        "'needs_revision': reviewer only — the output must be revised, explain why in feedback. " +
        "'blocked': you cannot finish because an upstream step's output is wrong or missing; " +
        'set targetStepId and explain what must change in feedback.'
    ),
  output: z
    .string()
    .optional()
    .describe(
      'Optional short note. Write your deliverable (worker) or review (reviewer) as your normal ' +
        'reply text BEFORE calling this tool — that text is used as the output. Do not paste ' +
        'long content here.'
    ),
  feedback: z
    .string()
    .optional()
    .describe('Required for needs_revision / blocked: concrete, actionable changes'),
  targetStepId: z
    .string()
    .optional()
    .describe('For blocked: id of the upstream step that must be redone'),
});

export type WorkflowSubmitResult = z.infer<typeof workflowSubmitResultSchema>;

/** Payload the Runtime sends back through the durable callback. */
export interface WorkflowStepResult extends Omit<WorkflowSubmitResult, 'output'> {
  /** Reply text of the turn (or the submitted note when the reply was empty). */
  output: string;
  /** True when the agent ended its turn without calling the submit tool. */
  implicit?: boolean;
  sessionId?: string;
}

// ── Tool exposed to the parent agent ───────────────────────────────────────

export const runWorkflowSchema = z.object({
  action: z
    .enum(['start', 'status', 'list', 'cancel'])
    .describe(
      "'start' a new workflow, check 'status' of one, 'list' recent workflows, or 'cancel' a running one"
    ),
  workflow: workflowSpecSchema.optional().describe('Workflow definition (required for start)'),
  workflowId: z.string().optional().describe('Workflow ID (required for status / cancel)'),
});

export const runWorkflowDefinition: ToolDefinition<typeof runWorkflowSchema> = {
  name: 'run_workflow',
  description: `Run a multi-agent workflow in the background. Steps are executed by specialist agents, in parallel when independent and in sequence when they depend on each other. Workflows can run for hours; this tool returns immediately.

**How it works**
- Each step runs one agent (use call_agent action='list_agents' to find agentIds) in its own isolated runtime session.
- dependsOn orders steps; outputs of dependencies are passed to the dependant step automatically.
- review: a reviewer agent checks the step output against criteria and can send it back with feedback (up to maxIterations).
- A step may report that an upstream step is wrong; that upstream step is redone with the feedback, then its dependants re-run.
- With notifyOnComplete (default true), you are resumed in this session with the results when the workflow finishes, so do NOT poll in a loop — tell the user it started and end your turn.

**Actions**
- start: workflow={ goal, steps:[{ id, agentId, prompt, dependsOn?, review? }] } → returns workflowId
- status: workflowId → overall status and per-step status/output
- list: recent workflows
- cancel: workflowId → stops the workflow and its running steps

**Example**
{ "action": "start", "workflow": { "goal": "Compare A and B", "steps": [
  { "id": "research_a", "agentId": "<id>", "prompt": "Research A" },
  { "id": "research_b", "agentId": "<id>", "prompt": "Research B" },
  { "id": "report", "agentId": "<id>", "dependsOn": ["research_a", "research_b"],
    "prompt": "Write a comparison report",
    "review": { "agentId": "<id>", "criteria": "Every claim cites a source" } } ] } }`,
  zodSchema: runWorkflowSchema,
  jsonSchema: zodToJsonSchema(runWorkflowSchema),
};
