/**
 * AgentCore Browser Strands tool definition
 */

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { browserDefinition } from '@moca/tool-definitions';
import { logger } from '../../../libs/logger/index.js';
import { AgentCoreBrowserClient } from './client.js';
import { requireStoragePath, ToolContextError } from '../_shared/index.js';
import type {
  StartSessionAction,
  NavigateAction,
  ClickAction,
  TypeAction,
  ScreenshotAction,
  GetContentAction,
  ScrollAction,
  BackAction,
  ForwardAction,
  WaitForElementAction,
  StopSessionAction,
  GetSessionStatusAction,
  SnapshotAction,
} from './types.js';

/**
 * AgentCore Browser Tool
 */
export const browserTool = tool({
  name: browserDefinition.name,
  description: browserDefinition.description,
  inputSchema: browserDefinition.zodSchema,
  callback: async (input: z.infer<typeof browserDefinition.zodSchema>) => {
    logger.info(`Browser execution started: ${input.action}`);

    try {
      // Get storage path from request context (always populated by requestContextMiddleware)
      const storagePath = requireStoragePath();

      // Create client
      const client = new AgentCoreBrowserClient({
        storagePath,
      });

      // Branch processing by action
      let result;
      switch (input.action) {
        case 'startSession': {
          result = await client.startSession(input as StartSessionAction);
          break;
        }

        case 'navigate': {
          result = await client.navigate(input as NavigateAction);
          break;
        }

        case 'click': {
          result = await client.click(input as ClickAction);
          break;
        }

        case 'type': {
          result = await client.type(input as TypeAction);
          break;
        }

        case 'screenshot': {
          result = await client.screenshot(input as ScreenshotAction);
          break;
        }

        case 'getContent': {
          result = await client.getContent(input as GetContentAction);
          break;
        }

        case 'scroll': {
          result = await client.scroll(input as ScrollAction);
          break;
        }

        case 'back': {
          result = await client.back(input as BackAction);
          break;
        }

        case 'forward': {
          result = await client.forward(input as ForwardAction);
          break;
        }

        case 'waitForElement': {
          result = await client.waitForElement(input as WaitForElementAction);
          break;
        }

        case 'stopSession': {
          result = await client.stopSession(input as StopSessionAction);
          break;
        }

        case 'getSessionStatus': {
          result = await client.getSessionStatus(input as GetSessionStatusAction);
          break;
        }

        case 'snapshot': {
          result = await client.snapshot(input as SnapshotAction);
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
        logger.info(`Browser execution successful: ${input.action}`);

        // Format content appropriately
        const content = result.content[0];
        let formattedResult = '';

        if (content.json) {
          formattedResult = `Browser Result:\nAction: ${input.action}\nResult: ${JSON.stringify(content.json, null, 2)}`;
        } else if (content.text) {
          formattedResult = `Browser Result:\nAction: ${input.action}\nOutput:\n${content.text}`;
        } else {
          formattedResult = `Browser Result:\nAction: ${input.action}\nResult: ${JSON.stringify(content)}`;
        }

        // Add session management reminder for certain actions
        if (input.action === 'startSession') {
          formattedResult +=
            '\n\n💡 TIP: Remember to use stopSession when you are done browsing to free resources.';
        }

        return formattedResult;
      } else {
        // Error case
        const errorContent = result.content[0];
        const errorMessage = errorContent.text || JSON.stringify(errorContent);
        logger.warn(`Browser execution failed: ${input.action} - ${errorMessage}`);
        return `Browser Error (${input.action}): ${errorMessage}`;
      }
    } catch (error) {
      // A ToolContextError carries an actionable, user-facing message; surface
      // it verbatim rather than wrapping it in the generic "Browser Error:".
      if (error instanceof ToolContextError) {
        logger.warn(`Browser context error: ${error.message}`);
        return error.message;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Browser tool error: ${errorMessage}`);
      return `Browser Error: ${errorMessage}`;
    }
  },
});
