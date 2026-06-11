import { describe, it, expect } from 'vitest';
import { EFFORT_ORDER } from '@moca/core';
import { shortModelName, availableDepthsFor } from '../helpers';

describe('shortModelName', () => {
  it('drops the "Claude " brand prefix', () => {
    expect(shortModelName('Claude Opus 4.8')).toBe('Opus 4.8');
    expect(shortModelName('Claude Sonnet 4.6')).toBe('Sonnet 4.6');
  });

  it('returns non-Claude names unchanged', () => {
    expect(shortModelName('Nova Lite 2')).toBe('Nova Lite 2');
    expect(shortModelName('Qwen3 Coder Next')).toBe('Qwen3 Coder Next');
  });

  it('is safe for an empty string', () => {
    expect(shortModelName('')).toBe('');
  });
});

describe('availableDepthsFor', () => {
  it('returns [] for non-reasoning / unknown models', () => {
    expect(availableDepthsFor('global.amazon.nova-2-lite-v1:0')).toEqual([]);
    expect(availableDepthsFor('qwen.qwen3-coder-next')).toEqual([]);
    expect(availableDepthsFor('does.not.exist')).toEqual([]);
  });

  it('caps Sonnet 4.6 at high (no max)', () => {
    expect(availableDepthsFor('global.anthropic.claude-sonnet-4-6')).toEqual(['off', 'low', 'high']);
  });

  it('offers all four depths for an Opus-tier model, in REASONING_DEPTHS order', () => {
    expect(availableDepthsFor('global.anthropic.claude-opus-4-8')).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
  });

  it('matches across cross-region inference profile prefixes', () => {
    expect(availableDepthsFor('us.anthropic.claude-opus-4-8')).toEqual(['off', 'low', 'high', 'max']);
  });

  it('never returns a depth outside EFFORT_ORDER (guards indexOf === -1)', () => {
    // Every returned non-off depth must be a known effort level; a value not in
    // EFFORT_ORDER must never slip through the cap filter.
    for (const id of [
      'global.anthropic.claude-opus-4-8',
      'global.anthropic.claude-sonnet-4-6',
    ]) {
      for (const d of availableDepthsFor(id)) {
        expect(['off', ...EFFORT_ORDER]).toContain(d);
      }
    }
  });
});
