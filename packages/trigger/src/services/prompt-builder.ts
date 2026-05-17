/**
 * Service for building event-driven prompts
 * Appends event context information after user's prompt
 */

import { EventDrivenContext } from '../types/index.js';
import { createLogger } from '../libs/logger/index.js';

const log = createLogger('PromptBuilder');

/**
 * Build event-driven prompt by combining user's prompt with event context
 * @param userPrompt - Original prompt configured by the user for this trigger
 * @param context - Event-driven context information
 * @returns Combined prompt with event context appended
 */
export function buildEventDrivenPrompt(userPrompt: string, context: EventDrivenContext): string {
  const eventContextSection = formatEventContext(context);
  return `${userPrompt}\n\n---\n\n${eventContextSection}`;
}

/**
 * Format event context into markdown section
 * @param context - Event-driven context
 * @returns Formatted markdown string
 */
function formatEventContext(context: EventDrivenContext): string {
  return `## Event-Driven Execution Context

This agent is being invoked automatically in response to an event. No human user is waiting in real-time.

### Execution Information

| Field | Value |
|-------|-------|
| Trigger | ${context.triggerName || context.triggerId} |
| Execution Time | ${context.executionTime} |
| Event Source | ${context.eventBridge.source} |
| Event Type | ${context.eventBridge.detailType} |
| Region | ${context.eventBridge.region} |
| Event ID | ${context.eventBridge.id} |

### Event Payload

\`\`\`json
${formatEventDetail(context.eventDetail)}
\`\`\`

### Guidelines for Event-Driven Execution

- Complete the assigned task thoroughly
- Document results and findings clearly
- Handle errors gracefully with explicit logging
- Do not ask clarifying questions - make reasonable assumptions and proceed
- Focus on reliability over speed`.trim();
}

/**
 * Format event detail as pretty-printed JSON
 * @param eventDetail - Event detail object
 * @returns Formatted JSON string
 */
function formatEventDetail(eventDetail: Record<string, unknown>): string {
  try {
    return JSON.stringify(eventDetail, null, 2);
  } catch (error) {
    log.error({ err: error }, 'Failed to stringify event detail');
    return JSON.stringify({ error: 'Failed to serialize event detail' });
  }
}
