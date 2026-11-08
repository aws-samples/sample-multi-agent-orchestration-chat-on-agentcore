import type { ImageAttachment, Message, MessageContent, ToolResult } from '../types/index';
import { extractUISpec } from './generative-ui';

export type ToolStepStatus = 'running' | 'completed' | 'error' | 'incomplete';

export interface ToolStep {
  kind: 'tool';
  key: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  status: ToolStepStatus;
}

export interface ReasoningStep {
  kind: 'reasoning';
  key: string;
  text: string;
  status: 'running' | 'completed';
}

export type Step = ToolStep | ReasoningStep;

export type Segment =
  | { type: 'text'; key: string; text: string }
  | { type: 'image'; key: string; image: ImageAttachment }
  /** Generative UI output is a user-facing artifact, so it is never folded into a step group. */
  | { type: 'ui'; key: string; content: string }
  | { type: 'steps'; key: string; steps: Step[] }
  | { type: 'unknown'; key: string; contentType: string };

const isToolResultOnly = (m: Message): boolean =>
  m.type === 'user' && m.contents.length > 0 && m.contents.every((c) => c.type === 'toolResult');

/**
 * History stores a tool round-trip as assistant(toolUse) → user(toolResult) →
 * assistant(...), following the Converse role convention. Live streaming puts
 * the same turn in a single assistant message. Merge history into the live
 * shape so one turn renders as one message and its steps can be grouped.
 *
 * Why not merge every consecutive assistant message: unrelated assistant
 * messages (e.g. an error notice) can be adjacent; only continue a turn whose
 * last block is a toolResult.
 */
export function mergeToolTurnMessages(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    const continuesTurn =
      prev?.type === 'assistant' &&
      (isToolResultOnly(m) ||
        (m.type === 'assistant' && prev.contents[prev.contents.length - 1]?.type === 'toolResult'));
    if (prev && continuesTurn) {
      merged[merged.length - 1] = {
        ...prev,
        contents: [...prev.contents, ...m.contents],
        isStreaming: m.isStreaming,
        isError: Boolean(prev.isError || m.isError),
      };
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/**
 * Split message contents into render segments. Consecutive reasoning / toolUse /
 * toolResult blocks become one `steps` segment; text, images and generative UI
 * break the run.
 */
export function buildSegments(contents: MessageContent[], isStreaming: boolean): Segment[] {
  const segments: Segment[] = [];
  const stepById = new Map<string, ToolStep>();
  let current: Step[] | null = null;

  const pushStep = (step: Step, index: number) => {
    if (!current) {
      current = [];
      segments.push({ type: 'steps', key: `steps-${index}`, steps: current });
    }
    current.push(step);
  };

  contents.forEach((content, index) => {
    switch (content.type) {
      case 'text':
        // Whitespace-only text between tool calls must not split the group.
        if (!content.text?.trim()) return;
        current = null;
        segments.push({ type: 'text', key: `text-${index}`, text: content.text });
        return;

      case 'image':
        if (!content.image) return;
        current = null;
        segments.push({ type: 'image', key: `image-${index}`, image: content.image });
        return;

      case 'reasoning':
        if (!content.reasoning?.text) return;
        pushStep(
          {
            kind: 'reasoning',
            key: `reasoning-${index}`,
            text: content.reasoning.text,
            status: isStreaming && index === contents.length - 1 ? 'running' : 'completed',
          },
          index
        );
        return;

      case 'toolUse': {
        const tu = content.toolUse;
        if (!tu) return;
        const step: ToolStep = {
          kind: 'tool',
          key: `tool-${index}`,
          name: tu.name,
          input: tu.input,
          status: tu.status === 'error' ? 'error' : isStreaming ? 'running' : 'incomplete',
        };
        stepById.set(tu.id, step);
        if (tu.originalToolUseId) stepById.set(tu.originalToolUseId, step);
        pushStep(step, index);
        return;
      }

      case 'toolResult': {
        const tr = content.toolResult;
        if (!tr) return;
        const owner = stepById.get(tr.toolUseId);
        if (owner) {
          owner.result = tr;
          owner.status = tr.isError ? 'error' : 'completed';
        }
        if (extractUISpec(tr.content) !== null) {
          current = null;
          segments.push({ type: 'ui', key: `ui-${index}`, content: tr.content });
          return;
        }
        if (!owner) {
          // Result whose toolUse is not in this message: keep it visible as its own step.
          pushStep(
            {
              kind: 'tool',
              key: `tool-result-${index}`,
              name: '',
              input: {},
              result: tr,
              status: tr.isError ? 'error' : 'completed',
            },
            index
          );
        }
        return;
      }

      default:
        current = null;
        segments.push({ type: 'unknown', key: `unknown-${index}`, contentType: content.type });
    }
  });

  return segments;
}

/** Gateway tools are exposed as `{target}___{tool}`; the label only cares about `{tool}`. */
export const toolBaseName = (name: string): string => {
  const i = name.lastIndexOf('___');
  return i >= 0 ? name.slice(i + 3) : name;
};

export interface StepGroupSummary {
  /** Failed steps that a later successful call of the same tool did not recover. */
  failed: number;
  /** Failed steps followed by a successful call of the same tool (i.e. retried). */
  recovered: number;
}

export function summarizeSteps(steps: Step[]): StepGroupSummary {
  let failed = 0;
  let recovered = 0;
  steps.forEach((s, i) => {
    if (s.kind !== 'tool' || s.status !== 'error') return;
    const retried = steps
      .slice(i + 1)
      .some(
        (later) => later.kind === 'tool' && later.name === s.name && later.status === 'completed'
      );
    if (retried) recovered++;
    else failed++;
  });
  return { failed, recovered };
}

const SUMMARY_KEYS = [
  'query',
  'url',
  'path',
  'command',
  'agent',
  'task',
  'prompt',
  'title',
  'code',
  'text',
];

/** The single most telling argument of a call, as one line. */
export function stepSummary(step: Step): string {
  if (step.kind === 'reasoning') return firstLine(step.text);
  const input = step.input;
  for (const k of SUMMARY_KEYS) {
    const v = input[k];
    // file_editor's `command` is a verb (view / create); the path says more.
    if (k === 'command' && typeof input.path === 'string') continue;
    if (typeof v === 'string' && v.trim()) return firstLine(v);
  }
  const first = Object.values(input).find((v): v is string => typeof v === 'string' && !!v.trim());
  return first ? firstLine(first) : '';
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/**
 * Recursively parse string values that look like JSON, so tool output shaped
 * like `{ text: JSON.stringify({...}) }` pretty-prints as structure.
 */
export function deepParseJsonStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return deepParseJsonStrings(JSON.parse(trimmed));
      } catch {
        // Not JSON — keep as-is.
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(deepParseJsonStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepParseJsonStrings(v)])
    );
  }
  return value;
}

export function formatToolResult(content: string): { isJson: boolean; text: string } {
  try {
    return {
      isJson: true,
      text: JSON.stringify(deepParseJsonStrings(JSON.parse(content)), null, 2),
    };
  } catch {
    return { isJson: false, text: content };
  }
}
