/**
 * Layered layout for a run_workflow spec: each step sits one column after its
 * deepest dependency, and steps within a column are ordered by the average
 * position of their parents to keep edges from crossing.
 */

import type { WorkflowGraphSpec, WorkflowGraphStep } from '../types/workflow';

export type { WorkflowGraphSpec, WorkflowGraphStep };

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
  // The input is whatever the model emitted, even when zod rejected it, so
  // every field the layout dereferences is checked.
  const isString = (v: unknown): v is string => typeof v === 'string';
  const valid = spec.steps.every((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const s = raw as unknown as Record<string, unknown>;
    if (!isString(s.id) || !isString(s.agentId) || !isString(s.prompt)) return false;
    if (s.dependsOn !== undefined && !(Array.isArray(s.dependsOn) && s.dependsOn.every(isString))) {
      return false;
    }
    if (s.review !== undefined) {
      const r = s.review as Record<string, unknown> | null;
      if (!r || typeof r !== 'object' || !isString(r.agentId) || !isString(r.criteria))
        return false;
      if (r.maxIterations !== undefined && typeof r.maxIterations !== 'number') return false;
    }
    return true;
  });
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
