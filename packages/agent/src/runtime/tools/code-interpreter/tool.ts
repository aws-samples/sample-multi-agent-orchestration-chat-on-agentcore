/**
 * CodeInterpreter Strands tool definition
 */

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { logger } from '../../../libs/logger/index.js';
import { AgentCoreCodeInterpreterClient } from './client.js';
import { requireStoragePath, ToolContextError } from '../_shared/index.js';
import type {
  InitSessionAction,
  ExecuteCodeAction,
  ExecuteCommandAction,
  ReadFilesAction,
  ListFilesAction,
  RemoveFilesAction,
  WriteFilesAction,
  DownloadFilesAction,
} from './types.js';
import { codeInterpreterDefinition } from '@moca/tool-definitions';

/**
 * CodeInterpreter tool schema definition
 * Using z.object() format for Bedrock API compatibility
 */

/**
 * CodeInterpreter Tool
 */
export const codeInterpreterTool = tool({
  name: codeInterpreterDefinition.name,
  description: codeInterpreterDefinition.description,
  inputSchema: codeInterpreterDefinition.zodSchema,
  callback: async (input: z.infer<typeof codeInterpreterDefinition.zodSchema>) => {
    logger.info(`CodeInterpreter execution started: ${input.action}`);

    try {
      // Get storage path from request context (always populated by requestContextMiddleware)
      const storagePath = requireStoragePath();

      // Create client (with default settings and storagePath)
      const client = new AgentCoreCodeInterpreterClient({
        autoCreate: true,
        persistSessions: true,
        storagePath: storagePath,
      });

      // Branch processing by action
      let result;
      switch (input.action) {
        case 'initSession': {
          result = await client.initSession(input as InitSessionAction);
          break;
        }

        case 'executeCode': {
          result = await client.executeCode(input as ExecuteCodeAction);
          break;
        }

        case 'executeCommand': {
          result = await client.executeCommand(input as ExecuteCommandAction);
          break;
        }

        case 'readFiles': {
          result = await client.readFiles(input as ReadFilesAction);
          break;
        }

        case 'listFiles': {
          result = await client.listFiles(input as ListFilesAction);
          break;
        }

        case 'removeFiles': {
          result = await client.removeFiles(input as RemoveFilesAction);
          break;
        }

        case 'writeFiles': {
          result = await client.writeFiles(input as WriteFilesAction);
          break;
        }

        case 'downloadFiles': {
          result = await client.downloadFiles(input as DownloadFilesAction);
          break;
        }

        case 'listLocalSessions': {
          result = client.listLocalSessions();
          break;
        }

        default: {
          // TypeScript exhaustiveness check
          const exhaustiveCheck: never = input.action;
          throw new Error(`Unknown action: ${exhaustiveCheck}`);
        }
      }

      // Format result
      if (result.status === 'success') {
        logger.info(`CodeInterpreter execution successful: ${input.action}`);

        // Add warning for executeCode and executeCommand about downloadFiles requirement
        const needsDownloadWarning =
          input.action === 'executeCode' || input.action === 'executeCommand';

        // Format content appropriately
        const content = result.content[0];
        let formattedResult = '';

        if (content.json) {
          formattedResult = `Execution Result:\nOperation: ${input.action}\nResult: ${JSON.stringify(content.json, null, 2)}`;
        } else if (content.text) {
          formattedResult = `Execution Result:\nOperation: ${input.action}\nOutput:\n${content.text}`;
        } else {
          formattedResult = `Execution Result:\nOperation: ${input.action}\nResult: ${JSON.stringify(content)}`;
        }

        // Add warning if needed
        if (needsDownloadWarning) {
          formattedResult += `\n\n⚠️ IMPORTANT: If you created files (images, videos, data files, etc.), you MUST use the 'downloadFiles' action before referencing them in your response. Files remain in the isolated CodeInterpreter environment until downloaded to your workspace.`;
        }

        return formattedResult;
      } else {
        logger.error(`CodeInterpreter execution error: ${input.action}`);
        const errorText = result.content[0]?.text || JSON.stringify(result.content);
        return `Execution Error:\nOperation: ${input.action}\nError: ${errorText}`;
      }
    } catch (error: unknown) {
      // A ToolContextError carries an actionable, user-facing message (e.g.
      // missing request context); surface it verbatim rather than burying it
      // under the generic "unexpected error" header.
      if (error instanceof ToolContextError) {
        logger.warn({ err: error.message }, `CodeInterpreter context error: ${input.action}`);
        return error.message;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: errorMessage }, `CodeInterpreter unexpected error: ${input.action}`);
      return `An unexpected error occurred:\nOperation: ${input.action}\nError: ${errorMessage}`;
    }
  },
});
