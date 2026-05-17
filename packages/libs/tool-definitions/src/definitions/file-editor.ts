import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

export const fileEditorSchema = z.object({
  filePath: z.string().describe('Absolute path of the file to edit (relative paths not allowed)'),
  oldString: z
    .string()
    .describe(
      'Text to replace. Must be unique within the file and must match exactly including whitespace and indentation. Specify empty string to create a new file.'
    ),
  newString: z
    .string()
    .describe('Replacement text. For new file creation, this content will be written to the file.'),
});

export const fileEditorDefinition: ToolDefinition<typeof fileEditorSchema> = {
  name: 'file_editor',
  description:
    'Edit or create new files. For moving or renaming files, use the mv command with the execute_command tool. Before use, confirm file contents with the cat command, and for new files, check the directory with the ls command. Replaces text specified in oldString with newString. oldString must be unique within the file and must match exactly including whitespace and indentation. Can only change one location at a time; for multiple changes, call multiple times.',
  zodSchema: fileEditorSchema,
  jsonSchema: zodToJsonSchema(fileEditorSchema),
};
