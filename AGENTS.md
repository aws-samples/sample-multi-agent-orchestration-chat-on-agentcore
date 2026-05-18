# AGENTS.md

## Documentation Policy

Do not document what can be derived from code. An agent can read the codebase.
Enforce verifiable constraints with tests and linters, not prose.
Code comments explain "why not" only — the non-obvious reason something was done a certain way.
Before adding a line to this file, ask: "If I remove this line, will an agent make a mistake?" If no, don't add it. If a root cause is fixed, remove the corresponding line.

## Project Overview

Moca — Multi-agent Orchestration Chat on AgentCore. A multi-agent platform built on Amazon Bedrock AgentCore.

## Architecture

Monorepo using npm workspaces. 8 packages.

| Package | Responsibility | Runtime | Entry Point |
|---|---|---|---|
| packages/agent | AgentCore Runtime agent. Built with Strands Agents SDK (TypeScript). Runs as a Docker container on AgentCore Runtime | Express (8080) | src/index.ts |
| packages/backend | REST API. Agent management, session persistence, file operations | Express + Lambda Web Adapter (8080) | src/index.ts |
| packages/frontend | React SPA | Vite + Tailwind | index.html |
| packages/cdk | CDK infrastructure. Manages all AWS resources. Environment config in `config/environments.ts` | CDK | lib/agentcore-stack.ts |
| packages/session-stream-handler | DynamoDB Streams → AppSync Events relay | Lambda | src/ |
| packages/trigger | EventBridge → automatic agent execution | Lambda | src/ |
| packages/lambda-tools | Tool functions deployed as individual Lambdas | Lambda | tools/ |

### Shared Libraries (packages/libs/)

| Library | Responsibility |
|---|---|
| libs/tool-definitions | Tool definition types (Zod + JSON Schema). The **interface layer** referenced by both agent and backend |
| libs/generative-ui-catalog | Generative UI component catalog. Referenced by both agent and frontend |
| libs/s3-workspace-sync | S3 workspace synchronization. Referenced by agent |
| libs/core | Core branded types and shared utilities (SessionId, UserId, AgentId, TriggerId, SYSTEM_USER_ID). Referenced by agent, backend, frontend, client, and trigger |

## Conventions

- Node.js 22, TypeScript ~5.7
- Package manager: npm workspaces (NOT pnpm)
- Test: jest (agent, backend, libs), vitest (frontend, s3-workspace-sync)
- Linter: eslint + prettier
- Build: `npm run build` runs `tsc -b tsconfig.build.json` (Solution Style, a single dependency-ordered pass across all TS packages) + `vite build` for the frontend.
- **`cdk synth` / `cdk deploy` requires `npm run build` to have been run first** (libs `dist/` must exist for `ts-node` to resolve `@moca/*` imports in CDK).

## Deployment

- `npm run deploy` → CDK deploy. Run `npm run build` beforehand so the shared libs (`@moca/*`) have been compiled and `ts-node`-based CDK synth can resolve them. `npm run build` also produces `dist/` for agent/backend/client/trigger/session-stream-handler; CDK bundles each Lambda via esbuild from `src/handler.ts`, so per-`lambda-tools/tools/*` `dist/` is not generated.
- Environments: default / dev / stg / prd (defined in `packages/cdk/config/environments.ts`)
- backend and agent are Docker images (multi-stage build). Dockerfiles live in `docker/`

## Important Rules

- **Changes to libs/ have wide impact**: Changing tool-definitions affects both agent and backend. Changing generative-ui-catalog affects agent, frontend, and backend (via tool-definitions dependency chain). Run tests for all dependent packages before merging.
- **Do NOT write Lambda-specific code in backend**: Lambda Web Adapter handles HTTP translation. Implement as a standard Express server with `app.listen(8080)`.
- **agent runs on AgentCore Runtime, NOT Lambda**: It is a Docker container, not a Lambda function. However, it is implemented as an Express server and runs locally with `npm run dev` as-is.
- **Environment config changes**: Edit `packages/cdk/config/environments.ts`. Types are in `environment-types.ts`, utilities in `environment-utils.ts`.
- **Secrets**: Stored in Secrets Manager. Naming convention: `agentcore/{env}/{secret-name}`.
- **Real-time communication**: AppSync Events (WebSocket). session-stream-handler relays from DynamoDB Streams to AppSync.
- **Event-driven automation**: EventBridge Scheduler + Rules → trigger package.

## Documentation Layout

`docs/` is split by audience and intent:

- `docs/guides/` — User-facing guides. How to deploy, configure, and run the project.
  Examples: `deployment-options.md`, `local-development-setup.md`.
- `docs/adr/` — Architecture Decision Records. WHY / WHY NOT for non-obvious
  architectural choices that an agent or engineer would predictably get wrong
  without context. Each file captures a single decision area
  (build layout, identity model, event-driven credential flow, etc.).

### When to add a new doc

- Adding a new user-visible knob, environment variable, or setup step → `docs/guides/`.
- Making a non-obvious architectural decision (especially security boundaries,
  data isolation, identity, build/Monorepo layout) → `docs/adr/`. Document the
  rejected alternatives, not just the chosen one.
- If a decision becomes obvious from code alone, do NOT add an ADR. ADRs exist
  to prevent re-litigation of past decisions, not to mirror code (see
  Documentation Policy above).

## Further Reading

- `docs/adr/build-design-rationale.md` — WHY / WHY NOT for non-obvious build and monorepo decisions (tsconfig composite placement, CDK outside the Solution, Dockerfile `COPY --parents` pivot, deferred alternatives). Consult before changing `tsconfig.*`, root build scripts, or Dockerfiles.
- `docs/adr/aws-data-access-control.md` — `userId` vs `identityId` model and per-user S3/DynamoDB isolation. Consult before changing IAM policies, S3 prefixes, DynamoDB partition keys, or AppSync channel paths.
- `docs/adr/event-driven-identity-pool-credentials.md` — How event-driven agent invocations (Trigger Lambda) resolve to the same `identityId` as frontend sessions. Consult before changing Cognito Developer Authenticated Identities or trigger credential flow.
- `docs/adr/github-token-broker-lambda.md` — GitHub Token Broker design and the residual-risk discussion for removing `secretsmanager:GetSecretValue` from the Runtime execution role.
