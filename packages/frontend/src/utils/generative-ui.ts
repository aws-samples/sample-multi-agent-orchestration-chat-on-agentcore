import { isUISpec, isUISpecOutput } from '@moca/generative-ui-catalog';
import type { UISpec } from '@moca/generative-ui-catalog';

/**
 * Extract a UISpec from tool result content.
 *
 * Handles two formats:
 *  - Direct JSON: '{"__generative_ui_spec":true,"spec":{...}}' or '{"root":"...","elements":{...}}'
 *  - textBlock array (session history API): '[{"type":"textBlock","text":"{...}"}]'
 */
export function extractUISpec(content: string): UISpec | null {
  try {
    let parsed = JSON.parse(content);

    // Unwrap textBlock array (session history format)
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const text = item?.text || item?.resource?.text;
        if (typeof text === 'string') {
          try {
            const inner = JSON.parse(text);
            if (isUISpecOutput(inner) || isUISpec(inner)) {
              parsed = inner;
              break;
            }
          } catch {
            // not valid JSON, continue to next item
          }
        }
      }
    }

    if (isUISpecOutput(parsed)) {
      return parsed.spec;
    }

    if (isUISpec(parsed)) {
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}
