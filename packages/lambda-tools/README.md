# @moca/lambda-tools

AgentCore Gateway Lambda Tools — npm workspace collection.

## Packages

| Package | Path | Description |
|---|---|---|
| `@moca/lambda-tools-shared` | `shared/` | Shared utilities (handler factory, tool registry, logger, types) |
| `@moca/lambda-tools-utility` | `tools/utility-tools/` | Utility tools (echo, ping) |
| `@moca/lambda-tools-kb` | `tools/kb-tools/` | Knowledge Base retrieval tools |
| `@moca/lambda-tools-athena` | `tools/athena-tools/` | Athena S3 query tools |
| `@moca/lambda-tools-nova-canvas` | `tools/nova-canvas-tools/` | Nova Canvas image generation tools |
| `@moca/lambda-tools-nova-reel` | `tools/nova-reel-tools/` | Nova Reel video generation tools |

## Build

All packages are members of the repo-root npm workspace. Use root commands:

```bash
npm run build                                 # Build all workspaces (includes lambda-tools)
npm run build -w @moca/lambda-tools-shared    # Build only the shared package
npm run build -w @moca/lambda-tools-utility   # Build a single tool
```

`tsc --build` composite mode resolves `@moca/lambda-tools-shared` before downstream tools.

CDK deploy does **not** depend on each tool's `dist/` — it bundles `src/handler.ts` directly via esbuild (see `packages/cdk/lib/constructs/agentcore/agentcore-lambda-target.ts`). `dist/` is for local tests and debugging.

## Shared configuration

- `tsconfig.base.json` — base TS config extended by each tool
- `jest.config.base.js` — base Jest config imported by each tool

Each tool's `tsconfig.json` / `jest.config.js` is a thin wrapper that extends/imports the base and adds minimal overrides (outDir, rootDir, moduleNameMapper for the shared package).

## Adding a new tool

1. Create `tools/<name>/` with:
   - `package.json` (`name: @moca/lambda-tools-<name>`, dependency `"@moca/lambda-tools-shared": "*"`)
   - `tsconfig.json` extending `../../tsconfig.base.json`
   - `jest.config.js` importing `../../jest.config.base.js`
   - `tool-schema.json`
   - `src/handler.ts`
2. Register it in `packages/cdk/lib/agentcore-gateway-target-stack.ts`:
   ```typescript
   lambdaCodePath: 'packages/lambda-tools/tools/<name>',
   toolSchemaPath: 'packages/lambda-tools/tools/<name>/tool-schema.json',
   ```
3. Run `npm install` at the repo root to link the new workspace.
