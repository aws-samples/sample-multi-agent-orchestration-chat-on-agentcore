/**
 * Skills Plugin Builder Unit Tests
 *
 * Tests for buildSkillsPlugin() which loads a pre-synced skills directory into
 * the Strands AgentSkills plugin. Uses a real temp directory with a real
 * SKILL.md so the AgentSkills constructor's synchronous filesystem scan is
 * exercised.
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

// ── Helpers ────────────────────────────────────────────────────────────

const SKILL_MD = `---
name: greeting
description: Greet the user warmly.
---
# Greeting
Say hello.
`;

/** Create a temp `.skills/` directory populated with one skill. */
function makeSkillsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  const skillDir = path.join(root, '.skills', 'greeting');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD);
  return path.join(root, '.skills');
}

describe('buildSkillsPlugin', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
    tmpRoots.length = 0;
  });

  it('returns null when skillsPath is undefined', () => {
    expect(buildSkillsPlugin(undefined)).toBeNull();
  });

  it('returns null when skillsPath is null', () => {
    expect(buildSkillsPlugin(null)).toBeNull();
  });

  it('loads skills from the provided directory', async () => {
    const skillsDir = makeSkillsDir();
    tmpRoots.push(path.dirname(skillsDir));

    const plugin = buildSkillsPlugin(skillsDir);

    expect(plugin).not.toBeNull();
    const skills = await plugin!.getAvailableSkills();
    expect(skills.map((s) => s.name)).toContain('greeting');
  });
});
