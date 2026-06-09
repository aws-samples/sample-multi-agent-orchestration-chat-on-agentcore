/**
 * generate_ui tool - Generate rich UI components for chat display
 *
 * Two modes:
 * - "spec": AI provides a json-render UI spec directly
 * - "code": AI provides code that generates a UI spec via CodeInterpreter
 */

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { logger } from '../../../libs/logger/index.js';
import { AgentCoreCodeInterpreterClient } from '../code-interpreter/client.js';
import { requireStoragePath } from '../_shared/index.js';
import { generateUiDefinition } from '@moca/tool-definitions';
import { validateUISpec } from './catalog.js';
import { extractJsonFromOutput } from './extract-json.js';
import type { UISpecOutput } from '@moca/generative-ui-catalog';

/**
 * generate_ui Tool
 */
export const generateUiTool = tool({
  name: generateUiDefinition.name,
  description: generateUiDefinition.description,
  inputSchema: generateUiDefinition.zodSchema,
  callback: async (input: z.infer<typeof generateUiDefinition.zodSchema>) => {
    logger.info(`generate_ui execution started: mode=${input.mode}`);

    try {
      let specData: unknown;

      if (input.mode === 'spec') {
        // Direct spec mode
        if (!input.spec) {
          return JSON.stringify({
            error: 'spec is required when mode="spec"',
          });
        }
        specData = input.spec;
      } else if (input.mode === 'code') {
        // Code mode - delegate to CodeInterpreter
        if (!input.code) {
          return JSON.stringify({
            error: 'code is required when mode="code"',
          });
        }

        const language = input.language || 'python';
        const sessionName = input.sessionName || `generate-ui-${Date.now()}`;

        logger.info(`generate_ui code mode: language=${language}, session=${sessionName}`);

        // Always populated by requestContextMiddleware
        const storagePath = requireStoragePath();
        const client = new AgentCoreCodeInterpreterClient({
          autoCreate: true,
          persistSessions: true,
          storagePath: storagePath,
          sessionName,
        });

        // Execute code (ensureSession handles session creation/reuse automatically)
        const result = await client.executeCode({
          action: 'executeCode',
          sessionName,
          language: language as 'python' | 'javascript' | 'typescript',
          code: input.code,
        });

        if (result.status === 'error') {
          const errorText = result.content.map((c) => c.text || JSON.stringify(c.json)).join('\n');
          logger.error(`generate_ui code execution failed: ${errorText}`);
          return JSON.stringify({
            error: `Code execution failed: ${errorText}`,
          });
        }

        // Extract output
        const outputText = result.content
          .map((c) => c.text || (c.json ? JSON.stringify(c.json) : ''))
          .join('\n');

        logger.info(`generate_ui code output length: ${outputText.length}`);

        // Parse JSON spec from output
        specData = extractJsonFromOutput(outputText);
        if (!specData) {
          logger.error(`generate_ui failed to parse spec from code output`);
          return JSON.stringify({
            error:
              'Failed to parse UI spec from code output. Make sure the code prints valid JSON to stdout.',
            output: outputText.substring(0, 500),
          });
        }
      } else {
        return JSON.stringify({
          error: `Unknown mode: ${input.mode}`,
        });
      }

      // Validate spec
      const validation = validateUISpec(specData);
      if (validation.errors.length > 0) {
        logger.warn(`generate_ui spec validation warnings: ${validation.errors.join(', ')}`);
      }

      if (!validation.spec) {
        return JSON.stringify({
          error: `Invalid UI spec: ${validation.errors.join(', ')}`,
        });
      }

      // Return spec with marker
      const output: UISpecOutput = {
        __generative_ui_spec: true,
        spec: validation.spec,
      };

      logger.info(`generate_ui success: ${Object.keys(validation.spec.elements).length} elements`);

      return JSON.stringify(output);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`generate_ui error: ${errorMessage}`);
      return JSON.stringify({
        error: `generate_ui failed: ${errorMessage}`,
      });
    }
  },
});
