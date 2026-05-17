import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';
import { generateComponentPrompt } from '@moca/generative-ui-catalog';

export const generateUiSchema = z.object({
  mode: z
    .enum(['spec', 'code'])
    .describe(
      'Execution mode. "spec": provide a json-render UI spec directly. "code": provide code that generates a json-render UI spec via stdout.'
    ),
  spec: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'json-render UI spec JSON object (required when mode="spec"). Must follow the flat element tree format with "root" and "elements" keys.'
    ),
  code: z
    .string()
    .optional()
    .describe(
      'Code that generates a json-render UI spec and prints it to stdout as JSON (required when mode="code"). The code should print ONLY the JSON spec, nothing else.'
    ),
  language: z
    .enum(['python', 'javascript', 'typescript'])
    .optional()
    .describe('Programming language for the code (used when mode="code", default: "python")'),
  sessionName: z
    .string()
    .optional()
    .describe(
      'CodeInterpreter session name (used when mode="code"). Reuse an existing session to access previously uploaded files.'
    ),
});

/**
 * Build the tool description dynamically from the shared catalog.
 * catalog.prompt() generates a complete description of all available components,
 * their props, and usage guidelines — derived from the Zod schemas in the catalog.
 *
 * customRules constrain the AI's spec generation to avoid patterns that the
 * current runtime cannot support:
 *
 * 1. "on" event restriction:
 *    Only MetricCard implements emit("press") in its React component.
 *    Other components (Stack, Grid, DataTable, charts) are pure display/layout
 *    and ignore "on" bindings. Without this rule, the AI attaches on.press to
 *    Grid/Stack for tab switching, which silently does nothing.
 *    See: packages/agent/src/tools/generate-ui/catalog.ts (INTERACTIVE_COMPONENTS)
 *
 * 2. $state data reference restriction:
 *    The streaming layer (Strands SDK → stream-serializer → NDJSON → frontend)
 *    strips the spec.state field during transport. The tool output correctly
 *    includes state (verified via agent logs), but by the time the toolResult
 *    reaches the frontend, only root + elements survive. As a result, $state
 *    references to data arrays (e.g., chart data) resolve to undefined.
 *    Simple scalar $state values (e.g., activeTab) work because they are set
 *    at runtime via setState actions, not read from initial state.
 *    See: packages/agent/src/utils/stream-serializer.ts (afterToolsEvent drops content)
 */
const catalogPrompt = generateComponentPrompt({
  customRules: [
    // Rule 1: Prevent AI from attaching "on" events to non-interactive components
    'Only MetricCard supports "on" event bindings (e.g., on.press for setState). Layout components (Stack, Grid) and display components (DataTable, BarChart, LineChart, PieChart) do NOT support "on" events — never attach "on" to them.',
    // Rule 2: Prevent AI from using $state for data arrays (lost during streaming)
    'Do NOT use {"$state": "/path"} to reference data arrays in component props (e.g., chart data, table rows). Always embed data directly in props. The "state" field and $state expressions are ONLY reliable for simple scalar values used in $cond, visible, and setState (e.g., tracking the active tab name). For chart/table data, put the arrays directly in the "data"/"rows" prop.',
  ],
});

const toolDescription =
  'Generate rich UI components for display in the chat interface. ' +
  'Use this tool to render structured data as tables, metric cards, charts, and other visual components. ' +
  'Two modes are available:\n' +
  '- "spec" mode: Provide a json-render UI spec directly (for simple/static UI)\n' +
  '- "code" mode: Provide code that reads data files and generates a UI spec (for data-heavy scenarios like CSV/DB queries - saves tokens)\n\n' +
  'The UI spec uses a flat element tree format:\n' +
  '```json\n' +
  '{\n' +
  '  "root": "root_key",\n' +
  '  "elements": {\n' +
  '    "root_key": { "type": "Stack", "props": { "gap": 4 }, "children": ["child1"] },\n' +
  '    "child1": { "type": "DataTable", "props": { "columns": ["A","B"], "rows": [["1","2"]] }, "children": [] }\n' +
  '  }\n' +
  '}\n' +
  '```\n\n' +
  'Available components (auto-generated from catalog):\n' +
  catalogPrompt +
  '\n\n' +
  'In "code" mode, the code runs in a sandboxed CodeInterpreter. Print ONLY the JSON spec to stdout.';

export const generateUiDefinition: ToolDefinition<typeof generateUiSchema> = {
  name: 'generate_ui',
  description: toolDescription,
  zodSchema: generateUiSchema,
  jsonSchema: zodToJsonSchema(generateUiSchema),
};
