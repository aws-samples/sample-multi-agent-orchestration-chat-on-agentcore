# Doc-Drift Detection — Changelog

Run history for the doc-drift detection skill. Max 30 entries (oldest trimmed).

<!-- entries will be prepended below -->

## Run #1 fix — 2026-04-09

- **Change**: Removed `inventory.json` and `false-positives.json`
- **Reason**: `inventory.json` contained commit hashes that triggered `detect-secrets` CI failure. Both files duplicated state already available from GitHub PRs and `changelog.md`.
- **Migration**: Skip list entries moved to SKILL.md. PR status tracked via `gh pr list --label doc-drift`. System prompt updated to remove all references.

## Run #1 — 2026-04-09

- **Commit**: a35ae5aecce818b69a47ab28d804ab2361017de6
- **Findings**: 26 total (16 HIGH, 6 MEDIUM, 4 LOW) — all NEW (first run)
- **PR Created**: docs/fix-drift-2026-04-09 — fixes 16 HIGH + 2 LOW findings
- **Documents analyzed**: AGENTS.md, packages/backend/README.md, packages/agent/README.md
- **Key patterns detected**:
  - New packages/libs added without updating AGENTS.md shared libraries table
  - Environment variable Required/Optional flags out of sync with Zod schemas
  - File structure sections never updated after major refactors
  - Docker build commands assume Dockerfile is local but it's in monorepo root docker/
  - API response examples diverged from actual code (jwks→cognito, JSON→NDJSON)
  - Nonexistent paths/env vars documented (MCP_CONFIG_PATH, src/tools/, weather.ts)
