/**
 * Unit tests for generateSessionId from @moca/core
 *
 * Verifies that the shared generateSessionId implementation satisfies
 * AgentCore Runtime session ID constraints when consumed from the agent package.
 * The canonical test suite lives in packages/libs/core/src/__tests__/session-id.test.ts;
 * this file provides integration-level confidence that the import works correctly
 * and the generated IDs meet all runtime requirements.
 */

import { describe, it, expect } from '@jest/globals';
import { generateSessionId, isSessionId, SESSION_ID_LENGTH } from '@moca/core';

const AGENTCORE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

describe('generateSessionId (@moca/core — agent package integration)', () => {
  it('returns a string', () => {
    expect(typeof generateSessionId()).toBe('string');
  });

  it('generates a 33-character string', () => {
    const id = generateSessionId();
    expect(id).toHaveLength(SESSION_ID_LENGTH);
  });

  it('contains only alphanumeric characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });

  it('first character is always alphanumeric', () => {
    for (let i = 0; i < 1000; i++) {
      const id = generateSessionId();
      expect(id[0]).toMatch(/[a-zA-Z0-9]/);
    }
  });

  it('satisfies AgentCore sessionId constraint pattern', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).toMatch(AGENTCORE_PATTERN);
    }
  });

  it('generates unique IDs across 1000 calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateSessionId()));
    expect(ids.size).toBe(1000);
  });

  it('always passes isSessionId type guard', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(isSessionId(id)).toBe(true);
    }
  });

  it('does not contain hyphens or underscores', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateSessionId();
      expect(id).not.toContain('-');
      expect(id).not.toContain('_');
    }
  });

  it('entropy is sufficient (62^33 > 2^128)', () => {
    const entropyBits = SESSION_ID_LENGTH * Math.log2(62);
    expect(entropyBits).toBeGreaterThan(128);
  });
});
