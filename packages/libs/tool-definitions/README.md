# @moca/tool-definitions

Zod schemas and JSON Schema definitions for **Agent-embedded tools** (`packages/agent`).

## Scope

This package is for tools that run inside the Agent process only.

**Lambda tools** (Gateway Targets) define their schemas in `packages/lambda-tools/tools/<tool>/tool-schema.json` and do not depend on this package.

| Tool type | Definition location |
|-----------|-------------------|
| Agent-embedded | `src/definitions/<tool>.ts` in this package |
| Lambda (Gateway Target) | `tool-schema.json` in each lambda-tool directory |

## Adding a Tool

1. Create `src/definitions/<tool-name>.ts` (follow existing files as examples)
2. Register in `src/definitions/index.ts` — add export, import, and entry in `allToolDefinitions`
3. `npm run build`