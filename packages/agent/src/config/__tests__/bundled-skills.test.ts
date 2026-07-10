/**
 * Bundled skills asset test.
 *
 * BUNDLED_SKILLS_DIRECTORY points at markdown assets that are NOT compiled by
 * tsc and are shipped into the image by a dedicated Dockerfile COPY. This test
 * guards two things that a normal `tsc -b` would not catch:
 *   1. the resolved path actually exists on disk (path drift between
 *      src/config and dist/config, or a missed Dockerfile/dockerignore update);
 *   2. every bundled SKILL.md parses under the real AgentSkills loader in strict
 *      mode (a malformed frontmatter would otherwise fail silently at runtime,
 *      where `strict: false` only logs a warning).
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import { BUNDLED_SKILLS_DIRECTORY } from '../index.js';

describe('bundled skills', () => {
  it('resolves to an existing directory', () => {
    expect(fs.existsSync(BUNDLED_SKILLS_DIRECTORY)).toBe(true);
    expect(fs.statSync(BUNDLED_SKILLS_DIRECTORY).isDirectory()).toBe(true);
  });

  it('loads every bundled skill under the strict loader', async () => {
    // strict: true turns a malformed SKILL.md into a throw rather than a warn,
    // so a parse failure fails the test instead of silently shipping.
    const plugin = new AgentSkills({ skills: [BUNDLED_SKILLS_DIRECTORY], strict: true });
    const skills = await plugin.getAvailableSkills();

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((s) => s.name)).toContain('moca-guide');
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});
