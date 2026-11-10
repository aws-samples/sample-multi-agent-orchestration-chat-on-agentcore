/**
 * Generative UI Catalog — Single Source of Truth
 *
 * This shared package defines the component catalog for the generate_ui tool.
 * It is consumed by:
 *   - Frontend: defineRegistry(catalog, { React components }) for rendering
 *   - Agent: catalog.prompt() for AI prompt generation
 *   - Agent: catalog.componentNames for validation
 */

import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react';
import { z } from 'zod';

// --- Interaction component props (shared with the frontend via z.infer) ---

const replyOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  value: z.string().optional(),
});

const replyQuestionFields = {
  options: z.array(replyOptionSchema).min(1),
  multiSelect: z.boolean().optional(),
  allowOther: z.boolean().optional(),
};

const suggestedRepliesPropsSchema = z.object({
  question: z.string().optional(),
  ...replyQuestionFields,
});

const questionnairePropsSchema = z.object({
  title: z.string().optional(),
  questions: z
    .array(
      z.object({
        header: z.string().optional(),
        question: z.string(),
        ...replyQuestionFields,
      })
    )
    .min(1),
});

export type ReplyOption = z.infer<typeof replyOptionSchema>;
export type SuggestedRepliesProps = z.infer<typeof suggestedRepliesPropsSchema>;
export type QuestionnaireProps = z.infer<typeof questionnairePropsSchema>;
export type QuestionnaireQuestion = QuestionnaireProps['questions'][number];

/**
 * Props schemas the agent enforces before returning a spec. Limited to the
 * interactive components: they index into their props unconditionally, so a
 * malformed spec renders an empty block, whereas the display components have
 * always been lenient and tightening them could reject specs that render fine.
 */
export const STRICT_PROPS_SCHEMAS: Record<string, z.ZodType> = {
  SuggestedReplies: suggestedRepliesPropsSchema,
  Questionnaire: questionnairePropsSchema,
};

export const catalog = defineCatalog(schema, {
  components: {
    // --- Layout ---
    Stack: {
      props: z.object({
        gap: z.number().optional(),
      }),
      slots: ['default'],
      description:
        'Vertical layout container. Stacks children vertically with configurable gap. Layout only — does NOT support "on" events.',
    },
    Grid: {
      props: z.object({
        cols: z.number().optional(),
        gap: z.number().optional(),
      }),
      slots: ['default'],
      description:
        'Responsive grid layout container. Arranges children in a grid with configurable column count and gap. Layout only — does NOT support "on" events.',
    },

    // --- Data Display ---
    DataTable: {
      props: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.string())),
        caption: z.string().optional(),
      }),
      slots: [],
      description:
        'Table display for tabular data. Columns are header strings, rows are arrays of cell strings. Display only — does NOT support "on" events.',
    },
    MetricCard: {
      props: z.object({
        title: z.string(),
        value: z.string(),
        description: z.string().optional(),
        change: z.string().optional(),
        changeType: z.enum(['positive', 'negative', 'neutral']).optional(),
      }),
      slots: [],
      description:
        'KPI/metric display card with title, value, optional description, and change indicator with trend direction. Supports "on.press" event for interactive use (e.g., tab switching with setState).',
    },

    // --- Charts ---
    BarChart: {
      props: z.object({
        title: z.string().optional(),
        data: z.array(z.record(z.string(), z.unknown())),
        xKey: z.string(),
        bars: z
          .array(
            z.object({
              key: z.string(),
              color: z.string().optional(),
              name: z.string().optional(),
            })
          )
          .optional(),
        yKey: z.string().optional(),
        color: z.string().optional(),
        height: z.number().optional(),
        stacked: z.boolean().optional(),
      }),
      slots: [],
      description:
        'Bar chart for comparing values across categories. Use "bars" array for multiple series or "yKey"+"color" shorthand for a single bar. Set stacked=true for stacked bars. Display only — does NOT support "on" events.',
    },
    LineChart: {
      props: z.object({
        title: z.string().optional(),
        data: z.array(z.record(z.string(), z.unknown())),
        xKey: z.string(),
        lines: z
          .array(
            z.object({
              key: z.string(),
              color: z.string().optional(),
              name: z.string().optional(),
              dashed: z.boolean().optional(),
            })
          )
          .optional(),
        yKey: z.string().optional(),
        color: z.string().optional(),
        height: z.number().optional(),
      }),
      slots: [],
      description:
        'Line chart for trends over time. Use "lines" array for multiple series or "yKey"+"color" shorthand for a single line. Set dashed=true for dashed lines. Display only — does NOT support "on" events.',
    },
    PieChart: {
      props: z.object({
        title: z.string().optional(),
        data: z.array(
          z.object({
            name: z.string(),
            value: z.number(),
            color: z.string().optional(),
          })
        ),
        height: z.number().optional(),
        showLabels: z.boolean().optional(),
        innerRadius: z.number().optional(),
      }),
      slots: [],
      description:
        'Pie/donut chart for showing proportions. Each data item has name and value. Set innerRadius > 0 for donut style. Display only — does NOT support "on" events.',
    },

    // --- Interaction ---
    SuggestedReplies: {
      props: suggestedRepliesPropsSchema,
      slots: [],
      description:
        'Clickable reply choices for the user\'s NEXT message. Clicking an option sends its "value" (defaults to "label") as the user\'s reply immediately. Each option: short "label" (shown on the button), optional "description" (one-line explanation), optional "value" (the exact message text to send, when it should differ from the label; write it in the user\'s voice). Set multiSelect=true to let the user pick several options and send them together. An "Other" entry that lets the user type a free-form answer is shown unless allowOther=false. Handles clicks itself — does NOT support "on" events.',
    },
    Questionnaire: {
      props: questionnairePropsSchema,
      slots: [],
      description:
        'Multi-step form for asking the user SEVERAL questions at once (use SuggestedReplies for a single question). Shows one question per page with Back/Next, then a review page; all answers are sent together as ONE user message formatted as "Q. <question>" followed by "- <answer>" lines per question. Each question: "question" text, optional short "header" (1-3 word tab label, e.g. "Dates"), "options" (same shape as SuggestedReplies: label / description / value), optional multiSelect=true for pick-several, and an inline free-text "Other" entry unless allowOther=false. Keep it to 2-5 questions with 2-4 options each. Handles clicks itself — does NOT support "on" events.',
    },
  },
  actions: {},
});

/**
 * Component type names derived from the catalog (SSoT).
 * Use this instead of maintaining a separate COMPONENT_TYPES array.
 */
export const COMPONENT_NAMES = catalog.componentNames;

/**
 * Generate an AI system prompt describing all available components.
 * This replaces the hand-maintained description in tool definitions.
 */
export function generateComponentPrompt(options?: {
  mode?: 'generate' | 'chat';
  customRules?: string[];
}): string {
  return catalog.prompt(options);
}

// --- Shared Types ---

export interface UIElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  visible?: unknown;
}

export interface UISpec {
  root: string;
  elements: Record<string, UIElement>;
  state?: Record<string, unknown>;
}

export interface UISpecOutput {
  __generative_ui_spec: true;
  spec: UISpec;
}

// --- Type Guards ---

export function isUISpec(obj: unknown): obj is UISpec {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    typeof (obj as Record<string, unknown>).root === 'string' &&
    typeof (obj as Record<string, unknown>).elements === 'object' &&
    (obj as Record<string, unknown>).elements !== null
  );
}

export function isUISpecOutput(obj: unknown): obj is UISpecOutput {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    (obj as Record<string, unknown>).__generative_ui_spec === true &&
    isUISpec((obj as Record<string, unknown>).spec)
  );
}
