/**
 * Skills plugin builder
 *
 * Constructs the Strands SDK's vended `AgentSkills` plugin from one or more
 * directories of skills that the caller has already synced to local disk.
 *
 * Isolated in a single builder (mirroring mcp-clients-builder / tools-builder)
 * so that swapping the skill source is a localized change. The builder takes
 * plain filesystem paths — not a workspace-sync object — so it stays a pure
 * assembler with no I/O ownership. Readiness (the S3→local pull) is the
 * caller's responsibility: the `AgentSkills` constructor scans the filesystem
 * synchronously and does not re-scan later, so the paths must be fully populated
 * before this is called.
 */

import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import { logger } from '../../libs/logger/index.js';

/**
 * Build the AgentSkills plugin from pre-synced skills directories, or return
 * `null` when no paths were provided.
 *
 * @param skillsPaths Absolute paths to populated skills directories
 *   (`.../.agents/skills/`). Order matters: `AgentSkills` lets later sources override
 *   same-named skills from earlier ones, so pass `[shared, workspace]` to let a
 *   workspace-specific skill win over a shared one. Empty/undefined → no plugin.
 */
export function buildSkillsPlugin(skillsPaths?: string[]): AgentSkills | null {
  if (!skillsPaths || skillsPaths.length === 0) return null;

  logger.info({ skillsPaths }, '[SKILLS] Loading skills from workspace');
  return new AgentSkills({ skills: skillsPaths, strict: false });
}
