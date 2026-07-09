/**
 * Skills plugin builder
 *
 * Constructs the Strands SDK's vended `AgentSkills` plugin from a directory of
 * skills that the caller has already synced to local disk.
 *
 * Isolated in a single builder (mirroring mcp-clients-builder / tools-builder)
 * so that swapping the skill source is a localized change. The builder takes a
 * plain filesystem path — not a workspace-sync object — so it stays a pure
 * assembler with no I/O ownership. Readiness (the S3→local pull) is the
 * caller's responsibility: the `AgentSkills` constructor scans the filesystem
 * synchronously and does not re-scan later, so the path must be fully populated
 * before this is called.
 */

import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import { logger } from '../../libs/logger/index.js';

/**
 * Build the AgentSkills plugin for a pre-synced skills directory, or return
 * `null` when no skills path was provided.
 *
 * @param skillsPath Absolute path to a populated skills directory
 *   (`.../.skills/`), or undefined/null when skills are unavailable.
 */
export function buildSkillsPlugin(skillsPath?: string | null): AgentSkills | null {
  if (!skillsPath) return null;

  logger.info({ skillsPath }, '[SKILLS] Loading skills from workspace');
  return new AgentSkills({ skills: [skillsPath], strict: false });
}
