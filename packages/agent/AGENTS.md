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
