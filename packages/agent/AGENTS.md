# AGENTS.md - packages/agent

## Architecture

Layered architecture inspired by [OpenAI's Harness Engineering](https://openai.com/ja-JP/index/harness-engineering/).
Layer dependencies are mechanically enforced via `eslint-plugin-boundaries` (`boundaries/dependencies` rule in `eslint.config.mjs`).

## Non-obvious Rules

### Provider Layer (libs/)

- `libs/` can be imported from **any** core layer
- `libs/` itself can **only** depend on `types/` (L0) and `config/` (L1)
- Provider modules should not depend on each other circularly

### Logging

- Use `logger` / `createLogger(scope)` from `libs/logger`. `no-console` is enforced by eslint.
- The logger is pino-based and emits one NDJSON line per event so CloudWatch Logs Insights can query by `scope`, `msg`, and structured fields. `console.log(msg, obj)` breaks this because `util.inspect` pretty-prints across multiple lines.

### Environment Variables (`process.env`)

- Direct reads of `process.env.X` / `process.env[key]` are **forbidden outside `config/`** (`no-restricted-syntax` in `eslint.config.mjs`). Declare the variable in `src/config/index.ts` (Zod schema) and import `config.X`.
- Single source of truth for required/optional definitions, type coercion, and test mocking — every consumer mocks one boundary (`config/index.js`) instead of spraying `process.env` mutations across tests.
- Exemptions (codified in the lint rule's `ignores`):
  - `libs/logger/**` — pino bootstrap reads `NODE_ENV` / `LOG_LEVEL` before `config` is importable; routing through config would create a `logger ↔ config` cycle (config itself logs validation errors).
  - tests — integration-test setup intentionally mutates `process.env` to point SDKs at DynamoDB Local etc.
  - The bare-reference form `...process.env` (SpreadElement) used to forward the entire env block to a child process is intentionally **not** matched, because rewriting it through config would just re-export the full env unchanged.
