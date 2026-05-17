/**
 * Generative UI catalog validation
 *
 * Validates that a UI spec only uses registered components
 * and strips unsupported event bindings from non-interactive components.
 */

import type { UISpec, UIElement } from '@moca/generative-ui-catalog';
import { COMPONENT_NAMES } from '@moca/generative-ui-catalog';

/**
 * Components that support "on" event bindings (e.g., on.press).
 * All other components are layout/display only and should not have "on".
 */
const INTERACTIVE_COMPONENTS = ['MetricCard'];

/**
 * Validate and sanitize a UI element
 */
function validateElement(
  key: string,
  element: UIElement & { on?: unknown }
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!COMPONENT_NAMES.includes(element.type as (typeof COMPONENT_NAMES)[number])) {
    errors.push(`Unknown component type "${element.type}" in element "${key}"`);
  }

  // Strip "on" event bindings from non-interactive components
  if (element.on && !INTERACTIVE_COMPONENTS.includes(element.type)) {
    delete element.on;
    errors.push(
      `Stripped "on" from non-interactive component "${element.type}" in element "${key}"`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate and sanitize a complete UI spec
 */
export function validateUISpec(spec: unknown): {
  valid: boolean;
  spec: UISpec | null;
  errors: string[];
} {
  const errors: string[] = [];

  if (!spec || typeof spec !== 'object') {
    return { valid: false, spec: null, errors: ['Spec must be an object'] };
  }

  const s = spec as Record<string, unknown>;

  if (typeof s.root !== 'string') {
    return { valid: false, spec: null, errors: ['Spec must have a "root" string key'] };
  }

  if (!s.elements || typeof s.elements !== 'object') {
    return { valid: false, spec: null, errors: ['Spec must have an "elements" object'] };
  }

  const elements = s.elements as Record<string, UIElement>;

  if (!elements[s.root]) {
    errors.push(`Root element "${s.root}" not found in elements`);
  }

  // Validate each element
  for (const [key, element] of Object.entries(elements)) {
    const result = validateElement(key, element);
    errors.push(...result.errors);

    // Validate children references
    if (element.children) {
      for (const childKey of element.children) {
        if (!elements[childKey]) {
          errors.push(`Element "${key}" references unknown child "${childKey}"`);
        }
      }
    }
  }

  // Allow spec with warnings (unknown types are filtered on frontend)
  const uiSpec: UISpec = {
    root: s.root,
    elements,
    ...(s.state && typeof s.state === 'object'
      ? { state: s.state as Record<string, unknown> }
      : {}),
  };

  return { valid: errors.length === 0, spec: uiSpec, errors };
}
