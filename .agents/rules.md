# Agent Rules

Rules that apply to **all** coding agents working on this repository.
Tool-specific files (AGENTS.md, .kiro/, .cursor/, etc.) should defer to these rules on conflicts.

## Documentation Integrity

When modifying source code, check whether the change invalidates any documentation.

Key document-code pairs:

| Document | Code Source of Truth |
|----------|---------------------|
| AGENTS.md | All package structures, dependency graph |
| packages/agent/README.md | agent/src/ (tools, config, endpoints, env vars) |
| packages/backend/README.md | backend/src/routes/*.ts, config |
| docs/deployment-options.md | cdk/config/environment-types.ts |
| docs/local-development-setup.md | scripts/src/setup-env.ts |

A mechanical check exists: `scripts/bin/check-doc-drift.sh`.
Run it after modifying config files or environment variables.

## PR Discipline

- Do not push directly to main — always create a branch and PR.
- Do not use `git push --force`.
- Documentation-fix PRs must not change source code (and vice versa).
- Run `npm run build && npm run test && npm run lint` before creating a PR.

## .agents/ Directory

This directory stores agent learning data and skill definitions.
Files here are Git-managed so that all agent knowledge is transparent, reviewable, and versioned.

- `rules.md` — This file. Global rules for all agents.
- `skills/` — Skill modules. Each skill has its own directory with a `SKILL.md` manifest.

Any agent (Moca, Kiro, Claude Code, Cursor, Cline) may read these files for context.
