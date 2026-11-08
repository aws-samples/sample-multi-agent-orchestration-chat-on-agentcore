/**
 * Shared contract between the mock page and every pattern implementation.
 * A pattern only ever receives one StepGroup (a consecutive run of reasoning /
 * tool calls between two text blocks) and decides how to render it.
 */

export type StepStatus = 'running' | 'completed' | 'error';

export interface ToolStep {
  kind: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Undefined while running. */
  result?: string;
  status: StepStatus;
  /** Epoch ms. The real app does not track this yet — patterns must degrade gracefully without it. */
  startedAt?: number;
  /** Set once finished. */
  durationMs?: number;
  /** For call_agent: nested steps of the sub-agent (optional). */
  children?: Step[];
}

export interface ReasoningStep {
  kind: 'reasoning';
  id: string;
  text: string;
  status: Exclude<StepStatus, 'error'>;
  startedAt?: number;
  durationMs?: number;
}

export type Step = ToolStep | ReasoningStep;

export interface StepGroup {
  id: string;
  steps: Step[];
}

export interface StepGroupViewProps {
  group: StepGroup;
  /**
   * True while this group is the tail of a still-streaming turn (the agent is
   * still working inside it). Once text follows, it becomes false.
   */
  isLive: boolean;
}

export type Segment =
  | { type: 'text'; id: string; text: string }
  | { type: 'steps'; group: StepGroup }
  /** Generative UI output — a user-facing artifact that must never be folded away. */
  | { type: 'ui'; id: string; title: string };
