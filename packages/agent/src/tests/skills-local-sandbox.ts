/**
 * Test helper: drive the SDK 1.8 `AgentSkills` plugin's filesystem path sources.
 *
 * As of `@strands-agents/sdk@1.8`, `AgentSkills` no longer scans filesystem path
 * sources in its constructor. Path sources are loaded lazily in `initAgent(agent)`
 * through `agent.sandbox` (so they read from the agent's sandbox — host or
 * container — from the correct filesystem). `getAvailableSkills()` called WITHOUT
 * an agent therefore returns only base skills (Skill instances / URLs), never the
 * path-loaded ones.
 *
 * These helpers give a unit test a minimal local-filesystem sandbox and a fake
 * agent so it can run `initAgent` and then read the loaded skill set via
 * `getAvailableSkills(agent)` — mirroring what happens inside `new Agent(...)` in
 * production without pulling in the whole Agent runtime.
 */

import fs from 'fs';
import path from 'path';
import type { LocalAgent } from '@strands-agents/sdk';
import type { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills';

/** Local-filesystem sandbox exposing only the two methods AgentSkills calls. */
const localFsSandbox = {
  async readText(p: string): Promise<string> {
    return fs.promises.readFile(p, 'utf8');
  },
  async listFiles(p: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  },
};

/**
 * Minimal stand-in for the agent object AgentSkills touches during path loading:
 * a `sandbox` (reads local disk) and a no-op `addHook` (initAgent registers a
 * BeforeInvocationEvent hook we don't exercise here).
 */
function makeFakeAgent(): LocalAgent {
  // Only `sandbox` (path loading) and `addHook` (initAgent registers a
  // BeforeInvocationEvent hook) are touched during skill loading; cast the
  // partial stub through `unknown` to the SDK type.
  return {
    sandbox: localFsSandbox,
    addHook: () => {},
  } as unknown as LocalAgent;
}

/**
 * Run the plugin's `initAgent` against a local-FS fake agent, then return the
 * names of every skill it loaded (base + path-loaded). This is the SDK 1.8
 * equivalent of the old construction-time scan.
 */
export async function loadSkillNames(plugin: AgentSkills): Promise<string[]> {
  const agent = makeFakeAgent();
  await plugin.initAgent(agent);
  const skills = await plugin.getAvailableSkills(agent);
  return skills.map((s: Skill) => s.name);
}

/** Create a temp `.agents/skills/` directory populated with one named skill. */
export function makeSkillsDir(root: string, name: string): string {
  const skillDir = path.join(root, '.agents/skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A test skill named ${name}.\n---\n# ${name}\nDo the ${name} thing.\n`
  );
  return path.join(root, '.agents/skills');
}
