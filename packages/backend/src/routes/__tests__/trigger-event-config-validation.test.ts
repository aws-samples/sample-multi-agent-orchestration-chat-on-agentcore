/**
 * Validation tests for the triggers route eventConfig contract.
 *
 * Mirrors the direct-schema unit-test pattern used elsewhere in this package
 * (see storage-directory.test.ts): the exported `eventConfigSchema` is parsed
 * directly rather than driving the route through HTTP. This locks in the rule
 * that an eventConfig, when present, MUST carry an eventSourceId — the contract
 * half of the fix for the GSI2 orphan bug.
 */

import { describe, it, expect } from '@jest/globals';
import { eventConfigSchema, createTriggerBody, updateTriggerBody } from '../trigger-schemas.js';

describe('eventConfigSchema', () => {
  it('accepts an eventConfig with an eventSourceId', () => {
    const parsed = eventConfigSchema.parse({ eventSourceId: 'github-push' });
    expect(parsed.eventSourceId).toBe('github-push');
  });

  it('passes through additional known fields alongside eventSourceId', () => {
    const parsed = eventConfigSchema.parse({
      eventSourceId: 'github-push',
      eventBusName: 'default',
    });
    expect(parsed).toMatchObject({ eventSourceId: 'github-push', eventBusName: 'default' });
  });

  it('rejects an eventConfig that omits eventSourceId', () => {
    // This is the exact payload that used to orphan the GSI2 key on update.
    expect(() => eventConfigSchema.parse({ eventBusName: 'default' })).toThrow();
  });

  it('rejects an empty-string eventSourceId', () => {
    expect(() => eventConfigSchema.parse({ eventSourceId: '' })).toThrow();
  });

  it('rejects an empty eventConfig object', () => {
    expect(() => eventConfigSchema.parse({})).toThrow();
  });
});

describe('createTriggerBody', () => {
  const base = { name: 'n', type: 'event' as const, agentId: 'a', prompt: 'p' };

  it('accepts an event trigger with a valid eventConfig', () => {
    expect(() =>
      createTriggerBody.parse({ ...base, eventConfig: { eventSourceId: 'src' } })
    ).not.toThrow();
  });

  it('rejects an event trigger whose eventConfig lacks eventSourceId', () => {
    expect(() =>
      createTriggerBody.parse({ ...base, eventConfig: { eventBusName: 'b' } })
    ).toThrow();
  });
});

describe('updateTriggerBody (partial)', () => {
  it('allows omitting eventConfig entirely (partial update of other fields)', () => {
    expect(() => updateTriggerBody.parse({ name: 'renamed' })).not.toThrow();
  });

  it('still requires eventSourceId when an eventConfig IS provided', () => {
    // The orphan-bug payload: a partial update replacing eventConfig without
    // an eventSourceId must be rejected at the contract layer.
    expect(() => updateTriggerBody.parse({ eventConfig: { eventBusName: 'b' } })).toThrow();
  });

  it('accepts a partial update that re-points eventSourceId', () => {
    expect(() => updateTriggerBody.parse({ eventConfig: { eventSourceId: 'new' } })).not.toThrow();
  });
});
