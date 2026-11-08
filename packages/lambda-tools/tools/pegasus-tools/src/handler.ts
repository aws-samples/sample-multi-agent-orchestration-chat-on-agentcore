import { createHandler } from '@moca/lambda-tools-shared';
import { getToolHandler } from './tools/index.js';

export const handler = createHandler({ getToolHandler, defaultToolName: 'video_to_text' });
