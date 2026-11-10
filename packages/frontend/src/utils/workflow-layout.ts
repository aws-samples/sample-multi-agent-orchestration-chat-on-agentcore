/**
 * Layered layout for a run_workflow spec: each step sits one column after its
 * deepest dependency, and steps within a column are ordered by the average
 * position of their parents to keep edges from crossing.
 */

export interface WorkflowGraphStep {
  id: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  modelId?: string;
  review?: { agentId: string; criteria: string; maxIterations?: number };
}

export interface WorkflowGraphSpec {
  goal: string;
  steps: WorkflowGraphStep[];
  maxConcurrency?: number;
  notifyOnComplete?: boolean;
}

export interface LaidOutStep {
  step: WorkflowGraphStep;
  /** Column (stage) index, 0-based. */
  level: number;
  /** Row within the column, 0-based. */
  row: number;
}

export interface WorkflowLayout {
  nodes: LaidOutStep[];
  /** Steps per column, in row order. */
  levels: WorkflowGraphStep[][];
  edges: Array<{ from: string; to: string }>;
}

/** Parse a tool input into a spec, or null when it is not a renderable start. */
export function parseWorkflowInput(input: unknown): WorkflowGraphSpec | null {
  if (!input || typeof input !== 'object') return null;
  const { action, workflow } = input as { action?: unknown; workflow?: unknown };
  if (action !== 'start' || !workflow || typeof workflow !== 'object') return null;
  const spec = workflow as Partial<WorkflowGraphSpec>;
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) return null;
  const valid = spec.steps.every(
    (s) =>
      s && typeof s.id === 'string' && typeof s.agentId === 'string' && typeof s.prompt === 'string'
  );
  return valid ? (spec as WorkflowGraphSpec) : null;
}

/** Returns null for an unrenderable spec (unknown dependency or cycle). */
export function layoutWorkflow(spec: WorkflowGraphSpec): WorkflowLayout | null {
  const byId = new Map(spec.steps.map((s) => [s.id, s]));
  if (byId.size !== spec.steps.length) return null;
  for (const s of spec.steps) {
    if ((s.dependsOn ?? []).some((d) => !byId.has(d))) return null;
  }

  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error('cycle');
    visiting.add(id);
    const deps = byId.get(id)!.dependsOn ?? [];
    const value = deps.length === 0 ? 0 : Math.max(...deps.map(depth)) + 1;
    visiting.delete(id);
    level.set(id, value);
    return value;
  };
  try {
    spec.steps.forEach((s) => depth(s.id));
  } catch {
    return null;
  }

  const levelCount = Math.max(...level.values()) + 1;
  const levels: WorkflowGraphStep[][] = Array.from({ length: levelCount }, () => []);
  for (const s of spec.steps) levels[level.get(s.id)!].push(s);

  const row = new Map<string, number>();
  levels.forEach((column, li) => {
    if (li > 0) {
      const weight = (s: WorkflowGraphStep) => {
        const parents = (s.dependsOn ?? []).map((d) => row.get(d) ?? 0);
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : 0;
      };
      // Stable sort keeps the author's order for ties.
      column.sort((a, b) => weight(a) - weight(b));
    }
    column.forEach((s, i) => row.set(s.id, i));
  });

  return {
    levels,
    nodes: spec.steps.map((step) => ({
      step,
      level: level.get(step.id)!,
      row: row.get(step.id)!,
    })),
    edges: spec.steps.flatMap((s) => (s.dependsOn ?? []).map((d) => ({ from: d, to: s.id }))),
  };
}
