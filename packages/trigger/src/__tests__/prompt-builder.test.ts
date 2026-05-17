/**
 * Unit tests for prompt-builder service
 */

import { describe, test, expect } from '@jest/globals';
import { buildEventDrivenPrompt } from '../services/prompt-builder.js';
import { EventDrivenContext } from '../types/index.js';
import type { TriggerId } from '@moca/core';

describe('buildEventDrivenPrompt', () => {
  const mockContext: EventDrivenContext = {
    triggerId: '550e8400-e29b-41d4-a716-446655440000' as TriggerId,
    triggerName: 'Daily Report Generator',
    executionTime: '2026-01-17T00:00:00Z',
    eventBridge: {
      id: 'event-abc-123',
      source: 'aws.scheduler',
      detailType: 'Scheduled Event',
      account: '123456789012',
      region: 'ap-northeast-1',
      time: '2026-01-17T00:00:00Z',
      resources: [],
    },
    eventDetail: {
      userId: 'user-123',
      agentId: 'agent-456',
      prompt: 'Generate daily report',
    },
  };

  const userPrompt = 'Generate a comprehensive daily report for today.';

  test('should prepend event context to user prompt', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    // Check that user prompt is included
    expect(result).toContain(userPrompt);

    // Check that event context section is included
    expect(result).toContain('## Event-Driven Execution Context');

    // Should NOT contain "Agent Instructions" section (system prompt is no longer embedded)
    expect(result).not.toContain('## Agent Instructions');
  });

  test('should include trigger information in context', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    expect(result).toContain('Daily Report Generator');
    expect(result).toContain('2026-01-17T00:00:00Z');
  });

  test('should include EventBridge metadata', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    expect(result).toContain('aws.scheduler');
    expect(result).toContain('Scheduled Event');
    expect(result).toContain('ap-northeast-1');
    expect(result).toContain('event-abc-123');
  });

  test('should include event detail as JSON', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    expect(result).toContain('```json');
    expect(result).toContain('"userId": "user-123"');
    expect(result).toContain('"agentId": "agent-456"');
    expect(result).toContain('"prompt": "Generate daily report"');
  });

  test('should include execution guidelines', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    expect(result).toContain('Guidelines for Event-Driven Execution');
    expect(result).toContain('Complete the assigned task thoroughly');
    expect(result).toContain('Do not ask clarifying questions');
  });

  test('should use triggerId when triggerName is not provided', () => {
    const contextWithoutName: EventDrivenContext = {
      ...mockContext,
      triggerName: undefined,
    };

    const result = buildEventDrivenPrompt(userPrompt, contextWithoutName);

    expect(result).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  test('should handle complex event detail structures', () => {
    const complexContext: EventDrivenContext = {
      ...mockContext,
      eventDetail: {
        nested: {
          object: {
            value: 'test',
          },
        },
        array: [1, 2, 3],
        boolean: true,
        null: null,
      },
    };

    const result = buildEventDrivenPrompt(userPrompt, complexContext);

    expect(result).toContain('"nested"');
    expect(result).toContain('"array"');
    expect(result).toContain('1');
    expect(result).toContain('2');
    expect(result).toContain('3');
  });

  test('should properly separate user prompt from event context with markdown divider', () => {
    const result = buildEventDrivenPrompt(userPrompt, mockContext);

    // Check for proper section separation: user prompt, then divider, then event context
    expect(result).toMatch(
      /Generate a comprehensive daily report[\s\S]*---[\s\S]*Event-Driven Execution Context/
    );
  });

  test('should handle empty event detail', () => {
    const contextWithEmptyDetail: EventDrivenContext = {
      ...mockContext,
      eventDetail: {},
    };

    const result = buildEventDrivenPrompt(userPrompt, contextWithEmptyDetail);

    expect(result).toContain('```json');
    expect(result).toContain('{}');
  });
});
