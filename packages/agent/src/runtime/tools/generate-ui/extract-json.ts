/**
 * JSON extraction utilities for CodeInterpreter output parsing.
 *
 * Handles the various formats that CodeInterpreter may return:
 *  - A raw JSON UI spec string: '{"root":"main","elements":{...}}'
 *  - A CodeInterpreter content array: '[{"type":"text","text":"{...}"}]'
 *  - Mixed text with embedded JSON
 */

import { isUISpec } from '@moca/generative-ui-catalog';

export function extractJsonFromOutput(output: string): unknown {
  // Try to parse the entire output as JSON first
  try {
    const parsed = JSON.parse(output.trim());

    // If it's already a valid UI spec, return directly
    if (isUISpec(parsed)) {
      return parsed;
    }

    // If it's an array (CodeInterpreter response envelope), unwrap text items
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object') {
          // Handle {type:"text", text:"..."} format
          const textValue = item.text || item.resource?.text;
          if (typeof textValue === 'string') {
            const nested = extractJsonFromOutput(textValue);
            if (nested && isUISpec(nested)) {
              return nested;
            }
          }
        }
      }
    }

    // Return whatever we parsed (caller will validate)
    return parsed;
  } catch {
    // Look for the last JSON object in the output
    const jsonMatches = output.match(/\{[\s\S]*\}/g);
    if (jsonMatches && jsonMatches.length > 0) {
      // Try from the last match (most likely to be the spec)
      for (let i = jsonMatches.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(jsonMatches[i]);
          if (isUISpec(parsed)) {
            return parsed;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}
