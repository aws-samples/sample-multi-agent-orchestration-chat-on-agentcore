/**
 * Skills Plugin Builder Unit Tests
 *
 * Tests for buildSkillsPlugin() which loads a pre-synced skills directory into
 * the Strands AgentSkills plugin. Uses a real temp directory with a real
 * SKILL.md.
 *
 * NOTE: as of `@strands-agents/sdk@1.8`, AgentSkills no longer scans filesystem
 * path sources in its constructor — they load lazily in `initAgent(agent)` via
 * `agent.sandbox`. `loadSkillNames` (test helper) runs that step against a
 * local-FS fake agent, mirroring what `new Agent(...)` does in production.
 *
 * Uses jest.unstable_mockModule + dynamic import for ESM compatibility.
 */

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Register ESM mocks ─────────────────────────────────────────────────

jest.unstable_mockModule('../../../libs/logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Dynamic imports ────────────────────────────────────────────────────

const { buildSkillsPlugin } = await import('../skills-plugin-builder.js');
const { loadSkillNames, makeSkillsDir } = await import('../../../tests/skills-local-sandbox.js');

describe('buildSkillsPlugin', () => {
  const tmpRoots: string[] = [];

  /** Create a temp root and a `.agents/skills/` dir with one named skill under it. */
  function makeTempSkillsDir(name = 'greeting'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
    tmpRoots.push(root);
    return makeSkillsDir(root, name);
  }

  afterEach(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
    tmpRoots.length = 0;
  });

  it('returns null when skillsPaths is undefined', () => {
    expect(buildSkillsPlugin(undefined)).toBeNull();
  });

  it('returns null when skillsPaths is empty', () => {
    expect(buildSkillsPlugin([])).toBeNull();
  });

  it('loads skills from the provided directory', async () => {
    const skillsDir = makeTempSkillsDir();

    const plugin = buildSkillsPlugin([skillsDir]);

    expect(plugin).not.toBeNull();
    const names = await loadSkillNames(plugin!);
    expect(names).toContain('greeting');
  });

  it('loads skills from multiple directories', async () => {
    const sharedDir = makeTempSkillsDir('sailor');
    const wsDir = makeTempSkillsDir('greeting');

    const plugin = buildSkillsPlugin([sharedDir, wsDir]);

    expect(plugin).not.toBeNull();
    const names = await loadSkillNames(plugin!);
    expect(names).toContain('sailor');
    expect(names).toContain('greeting');
  });
});
