/**
 * Zod request schemas for the triggers routes.
 *
 * Extracted from `triggers.ts` so they can be unit-tested directly without
 * importing the route module (which pulls in the DynamoDB service, `uuid`, and
 * config side effects). Keep these schemas free of heavy imports.
 */

import { z } from 'zod';

/**
 * Event subscription config. `eventSourceId` is REQUIRED whenever an
 * eventConfig object is supplied: an event trigger with no source is
 * meaningless, and — critically — a partial update that dropped it used to
 * orphan the GSI2 subscription key (the trigger kept firing for a source it no
 * longer subscribed to). Requiring it here closes that path at the contract
 * layer; the repository's GSI2 sync is the defence-in-depth backstop.
 *
 * Unknown keys are passed through so additive fields (e.g. eventBusName,
 * eventPattern) don't require a schema bump, matching the previous
 * `z.record` permissiveness for everything except the mandatory id.
 */
export const eventConfigSchema = z
  .object({
    eventSourceId: z.string().min(1, 'eventConfig.eventSourceId is required'),
  })
  .passthrough();

/** Request body for creating a trigger. */
export const createTriggerBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['schedule', 'event']),
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  modelId: z.string().optional(),
  workingDirectory: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  scheduleConfig: z.record(z.string(), z.unknown()).optional(),
  eventConfig: eventConfigSchema.optional(),
});

/** Request body for updating a trigger (partial). */
export const updateTriggerBody = createTriggerBody.partial();
