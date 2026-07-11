/**
 * Unit tests for buildRequestBody — specifically the per-message goal fields.
 *
 * buildRequestBody copies every non-undefined AgentConfig key onto the wire
 * body, so goal / goalJudgeModelId ride along automatically. These tests lock
 * in that inclusion (when set) and omission (when undefined).
 */

import { describe, it, expect } from 'vitest';
import { buildRequestBody, type AgentConfig } from '../agent';

describe('buildRequestBody goal fields', () => {
  it('includes goal and goalJudgeModelId when both are set', () => {
    const config: AgentConfig = {
      modelId: 'global.anthropic.claude-opus-4-8',
      goal: 'Answer in 3 sentences',
      goalJudgeModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    };
    const body = JSON.parse(buildRequestBody('hi', config));
    expect(body.goal).toBe('Answer in 3 sentences');
    expect(body.goalJudgeModelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('includes goal but omits goalJudgeModelId when the judge model is undefined', () => {
    const config: AgentConfig = { goal: 'Be concise', goalJudgeModelId: undefined };
    const body = JSON.parse(buildRequestBody('hi', config));
    expect(body.goal).toBe('Be concise');
    expect('goalJudgeModelId' in body).toBe(false);
  });

  it('omits both goal and goalJudgeModelId when unset', () => {
    const config: AgentConfig = { modelId: 'global.anthropic.claude-opus-4-8' };
    const body = JSON.parse(buildRequestBody('hi', config));
    expect('goal' in body).toBe(false);
    expect('goalJudgeModelId' in body).toBe(false);
  });

  it('omits goal fields entirely when no config is passed', () => {
    const body = JSON.parse(buildRequestBody('hi'));
    expect(body).toEqual({ prompt: 'hi' });
  });
});
