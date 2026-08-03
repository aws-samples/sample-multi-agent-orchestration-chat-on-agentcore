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

const skillMd = (name: string) => `---
name: ${name}
description: A test skill named ${name}.
---
# ${name}
Do the ${name} thing.
`;

/** Create a temp `.agents/skills/` directory populated with one named skill. */
function makeSkillsDir(name = 'greeting'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  const skillDir = path.join(root, '.agents/skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd(name));
  return path.join(root, '.agents/skills');
}

/**
 * Minimal filesystem-backed sandbox + agent. Since @strands-agents/sdk v1.11,
 * `AgentSkills` loads filesystem path sources lazily at `initAgent()` through the
 * agent's sandbox rather than during construction, and `getAvailableSkills()`
 * only returns path-loaded skills when passed the agent they were loaded for.
 * These helpers drive that flow against the real local filesystem so the tests
 * exercise the same code path production uses.
 */
class LocalFsSandbox {
  async listFiles(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readText(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf8');
  }
}

async function loadPluginSkills(plugin: NonNullable<ReturnType<typeof buildSkillsPlugin>>) {
  const agent = { sandbox: new LocalFsSandbox(), addHook: () => {} };
  await plugin.initAgent(agent as unknown as Parameters<typeof plugin.initAgent>[0]);
  return plugin.getAvailableSkills(agent as unknown as Parameters<typeof plugin.getAvailableSkills>[0]);
}

describe('buildSkillsPlugin', () => {
  const tmpRoots: string[] = [];

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
    const skillsDir = makeSkillsDir();
    tmpRoots.push(path.dirname(skillsDir));

    const plugin = buildSkillsPlugin([skillsDir]);

    expect(plugin).not.toBeNull();
    const skills = await loadPluginSkills(plugin!);
    expect(skills.map((s) => s.name)).toContain('greeting');
  });

  it('loads skills from multiple directories', async () => {
    const sharedDir = makeSkillsDir('sailor');
    const wsDir = makeSkillsDir('greeting');
    tmpRoots.push(path.dirname(sharedDir), path.dirname(wsDir));

    const plugin = buildSkillsPlugin([sharedDir, wsDir]);

    expect(plugin).not.toBeNull();
    const names = (await loadPluginSkills(plugin!)).map((s) => s.name);
    expect(names).toContain('sailor');
    expect(names).toContain('greeting');
  });
});
