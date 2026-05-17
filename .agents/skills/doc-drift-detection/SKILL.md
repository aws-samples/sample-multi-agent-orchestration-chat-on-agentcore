---
name: doc-drift-detection
description: Detect semantic drift between documentation and source code. Goes beyond grep-based checks to find meaning-level discrepancies that mechanical tools miss.
---

# Doc-Drift Detection Skill

## Purpose

Detect **semantic** drift between documentation and code — the kind that `grep` cannot catch:

- API endpoints added in code but missing from README
- Architecture diagrams that no longer match actual dependency graph
- Environment variable docs out of sync with config schemas
- Code examples in docs that use outdated APIs

## Scope

### Layer Model

| Layer | Method | Example | Owner |
|-------|--------|---------|-------|
| Layer 0 | Mechanical grep | "env var name exists in README" | `scripts/bin/check-doc-drift.sh` |
| Layer 1 | Structural read | "route list in code vs endpoint list in doc" | **This skill** |
| Layer 2 | Semantic understanding | "doc says X but code actually does Y" | **This skill** |

### Active Document-Code Pairs

| Group | Document | Code Source |
|-------|----------|-------------|
| A | AGENTS.md | All package structures, dependency graph |
| B | packages/backend/README.md | backend/src/routes/*.ts, config |
| C | packages/agent/README.md | agent/src/ (tools, config, endpoints) |

### Skip List

Documents excluded from analysis. Add entries here when a PR is closed without merging (i.e., the finding was a false positive or intentional).

- `packages/frontend/README.md` — Vite boilerplate, not project documentation
- `packages/cdk/README.md` — Minimal stub; deployment docs live in `docs/deployment-options.md`

## Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| 🔴 HIGH | Clear factual error — wrong endpoint, wrong version, nonexistent file referenced | PR to fix |
| 🟡 MEDIUM | Missing information — new route undocumented, new env var missing | Chat report |
| 🟢 LOW | Stale wording, minor description inaccuracy | Chat report |

## Output Format

Return findings as JSON:

```json
{
  "group": "B",
  "document": "packages/backend/README.md",
  "findings": [
    {
      "section": "API Endpoints",
      "codeSource": "packages/backend/src/routes/memory.ts",
      "type": "missing_info",
      "severity": "MEDIUM",
      "description": "DELETE /memory/records/:recordId is implemented but not documented",
      "evidence": "router.delete('/records/:recordId', ...) at line 60",
      "suggestedFix": "Add DELETE /api/memory/records/:recordId to the API Endpoints section"
    }
  ]
}
```

## State Management

This skill does **not** maintain JSON state files. All state is derived from:

- **Run history**: `changelog.md` in this directory (max 30 entries)
- **PR status**: `gh pr list --label doc-drift --state all` (GitHub is source of truth)
- **Skip list**: The Skip List section above in this file
