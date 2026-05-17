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
