/**
 * Unit tests for the trigger DynamoDB item mappers — reasoningEffort coverage.
 *
 * `fromItem` projects a stored row onto a domain Trigger via the TRIGGER_FIELDS
 * allowlist: a field missing from that list is silently dropped on read. These
 * tests lock in that `reasoningEffort` survives the round-trip and that the
 * partial-update builder emits the field only when present.
 */

import { describe, it, expect } from '@jest/globals';
import { fromItem, buildUpdateExpression } from '../item.js';
import type { Trigger } from '../../types.js';
import { getReasoningConfig, type UserId, type TriggerId } from '@moca/core';

const existing: Trigger = {
  id: 't1' as TriggerId,
  userId: 'u1' as UserId,
  name: 'n',
  type: 'schedule',
  enabled: true,
  agentId: 'a1' as never,
  prompt: 'p',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('fromItem — reasoningEffort allowlist', () => {
  it('projects reasoningEffort from the stored row', () => {
    const trigger = fromItem({
      PK: 'USER#u1',
      SK: 'TRIGGER#t1',
      id: 't1',
      userId: 'u1',
      name: 'n',
      type: 'schedule',
      enabled: true,
      agentId: 'a1',
      prompt: 'p',
      modelId: 'global.anthropic.claude-opus-4-8',
      reasoningEffort: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(trigger.reasoningEffort).toBe('high');
    // Storage keys must NOT leak into the domain object (allowlist projection).
    expect('PK' in trigger).toBe(false);
    expect('SK' in trigger).toBe(false);
  });

  it.each(['global.', 'us.'])(
    'restores Opus 5.5 saved off without requesting disabled thinking for %s',
    (prefix) => {
      const modelId = `${prefix}anthropic.claude-opus-5-5`;
      const trigger = fromItem({ ...existing, modelId, reasoningEffort: 'off' });
      expect(trigger.modelId).toBe(modelId);
      expect(trigger.reasoningEffort).toBe('off');
      expect(getReasoningConfig(trigger.modelId!, trigger.reasoningEffort!)).toBeUndefined();
    }
  );

  it.each([
    ['global.anthropic.claude-haiku-5-5', 'off', { thinking: { type: 'disabled' } }],
    ['global.anthropic.claude-haiku-5-5', undefined, undefined],
    ['global.anthropic.claude-sonnet-5-5', 'off', { thinking: { type: 'between_tools' } }],
    ['global.anthropic.claude-sonnet-5-5', undefined, undefined],
    ['global.anthropic.claude-opus-5-5', 'off', undefined],
    ['global.anthropic.claude-opus-5-5', undefined, undefined],
  ] as const)('restores %s with stored effort %p as %p', (modelId, reasoningEffort, expected) => {
    const trigger = fromItem({ ...existing, modelId, reasoningEffort });
    expect(trigger.reasoningEffort).toBe(reasoningEffort);
    expect(getReasoningConfig(modelId, trigger.reasoningEffort)).toEqual(expected);
  });

  it('switching a stored off trigger from Opus 5.5 to Haiku 5.5 disables thinking', () => {
    const stored: Trigger = {
      ...existing,
      modelId: 'global.anthropic.claude-opus-5-5',
      reasoningEffort: 'off',
    };
    const { attributeValues } = buildUpdateExpression(
      existing.userId,
      existing.id,
      { modelId: 'global.anthropic.claude-haiku-5-5' },
      stored,
      '2026-02-02T00:00:00Z'
    );
    const trigger = fromItem({ ...stored, modelId: attributeValues[':modelId'] });
    expect(trigger.reasoningEffort).toBe('off');
    expect(getReasoningConfig(trigger.modelId!, trigger.reasoningEffort)).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('leaves reasoningEffort undefined when the row has none', () => {
    const trigger = fromItem({
      id: 't1',
      userId: 'u1',
      name: 'n',
      type: 'schedule',
      enabled: true,
      agentId: 'a1',
      prompt: 'p',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(trigger.reasoningEffort).toBeUndefined();
  });
});

describe('buildUpdateExpression — reasoningEffort', () => {
  const now = '2026-02-02T00:00:00Z';

  it('emits a SET clause and value when reasoningEffort is provided', () => {
    const { updateExpression, attributeValues } = buildUpdateExpression(
      existing.userId,
      existing.id,
      { reasoningEffort: 'max' },
      existing,
      now
    );
    expect(updateExpression).toContain('reasoningEffort = :reasoningEffort');
    expect(attributeValues[':reasoningEffort']).toBe('max');
  });

  it('omits reasoningEffort when not in the patch', () => {
    const { updateExpression, attributeValues } = buildUpdateExpression(
      existing.userId,
      existing.id,
      { modelId: 'm' },
      existing,
      now
    );
    expect(updateExpression).not.toContain('reasoningEffort');
    expect(':reasoningEffort' in attributeValues).toBe(false);
  });
});
