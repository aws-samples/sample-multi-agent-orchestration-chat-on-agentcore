import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema-converter.js';
import type { ToolDefinition } from '../types.js';

export const s3ListFilesSchema = z.object({
  path: z.string().default('/').describe('Directory path to list (default: root "/")'),
  recursive: z
    .boolean()
    .default(false)
    .describe('Whether to recursively include subdirectories (default: false)'),
  maxResults: z
    .number()
    .min(1)
    .max(1000)
    .default(100)
    .describe('Maximum number of results to retrieve (1-1000, default: 100)'),
  includePresignedUrls: z
    .boolean()
    .default(false)
    .describe(
      'Whether to generate presigned URLs for files (default: false). URLs allow direct browser access and expire after specified time.'
    ),
  presignedUrlExpiry: z
    .number()
    .min(60)
    .max(86400)
    .default(3600)
    .describe(
      'Presigned URL expiration time in seconds (60-86400, default: 3600 = 1 hour). Only used when includePresignedUrls is true.'
    ),
});

export const s3ListFilesDefinition: ToolDefinition<typeof s3ListFilesSchema> = {
  name: 's3_list_files',
  description:
    "Retrieve list of files and directories in user's S3 storage. Can explore contents under specified path.",
  zodSchema: s3ListFilesSchema,
  jsonSchema: zodToJsonSchema(s3ListFilesSchema),
};
