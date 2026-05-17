import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

const todoItemUpdateSchema = z.object({
  id: z.string().describe('The ID of the task to update (e.g., "task-1")'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('The new status for the task'),
  description: z.string().optional().describe('Optional new description for the task'),
});

export const todoSchema = z.object({
  action: z
    .enum(['init', 'update'])
    .describe(
      "Action: 'init' to create/overwrite todo list, 'update' to modify existing task statuses"
    ),

  // For init action
  items: z
    .array(z.string())
    .optional()
    .describe(
      'Array of task descriptions to initialize the list with (required for init action). All tasks are initially marked as pending.'
    ),

  // For update action
  updates: z
    .array(todoItemUpdateSchema)
    .optional()
    .describe('Array of task updates to process in batch (required for update action).'),
});

export const todoDefinition: ToolDefinition<typeof todoSchema> = {
  name: 'todo',
  description: `Manage a todo list for tracking task progress during sessions.

**Available Actions:**
- 'init': Create a new todo list or overwrite the current one
- 'update': Update task statuses in the existing list

**For 'init' action (required parameters):**
- items: Array of task description strings. All tasks start as pending.

**For 'update' action (required parameters):**
- updates: Array of objects with id, status, and optional description

## Optimal Usage Scenarios
Deploy this functionality strategically under these conditions:

1. Intricate workflows requiring multiple phases - Apply when operations demand 3+ sequential actions or procedures
2. Sophisticated assignments needing orchestration - Utilize for endeavors requiring methodical coordination or compound operations
3. Direct user specification for task tracking - Activate when users explicitly request task list functionality
4. Multiple assignment batches - Engage when users present enumerated or delimited work items
5. Upon instruction receipt - Promptly document user specifications as actionable items. Modify todo list as new details emerge.
6. Following task completion - Update status and incorporate subsequent follow-up activities
7. During task initiation - Transition items to active status. Maintain singular active task focus. Finalize current work before advancing to new items.

## Inappropriate Usage Contexts

Avoid this utility when:
1. Only one straightforward operation exists
2. Work is elementary and tracking offers no structural advantage
3. Completion requires fewer than 3 basic steps
4. Interaction is purely discussion-based or informational

IMPORTANT: Refrain from using this tool for single elementary tasks. Direct execution is more efficient in such cases.

## Examples

**Init:**
\`\`\`json
{
  "action": "init",
  "items": ["Design the database schema", "Implement the API endpoints", "Write unit tests"]
}
\`\`\`

**Update:**
\`\`\`json
{
  "action": "update",
  "updates": [
    { "id": "task-1", "status": "completed" },
    { "id": "task-2", "status": "in_progress" }
  ]
}
\`\`\``,
  zodSchema: todoSchema,
  jsonSchema: zodToJsonSchema(todoSchema),
};
