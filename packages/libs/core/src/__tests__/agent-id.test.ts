import { describe, it, expect } from 'vitest';
import { isAgentId, parseAgentId, AGENT_ID_PATTERN } from '../agent-id.js';

describe('isAgentId', () => {
  it('returns true for UUID v7', () => {
    expect(isAgentId('019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f')).toBe(true);
  });

  it('returns true for legacy UUID v4', () => {
    expect(isAgentId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isAgentId('')).toBe(false);
  });

  it('returns false for plain string', () => {
    expect(isAgentId('my-agent')).toBe(false);
  });

  it('returns false for session ID (33 alphanumeric)', () => {
    expect(isAgentId('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg')).toBe(false);
  });
});

describe('parseAgentId', () => {
  it('returns AgentId for valid input', () => {
    const valid = '019573e4-5a1b-7c2d-8e3f-4a5b6c7d8e9f';
    expect(parseAgentId(valid)).toBe(valid);
  });

  it('throws for invalid input', () => {
    expect(() => parseAgentId('bad')).toThrow('Invalid agentId');
  });

  it('throws with descriptive error message', () => {
    expect(() => parseAgentId('xyz')).toThrow(/must be a UUID/);
  });
});

describe('AGENT_ID_PATTERN', () => {
  it('matches standard UUID', () => {
    expect(AGENT_ID_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('does not match non-UUID', () => {
    expect(AGENT_ID_PATTERN.test('web-researcher')).toBe(false);
  });
});
