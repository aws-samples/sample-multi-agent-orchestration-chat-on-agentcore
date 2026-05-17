---
name: coding-style
description: Design decisions, implicit rules, and anti-patterns for the Moca project. Covers coding conventions, project structure rationale, and testing guidelines.
---

# Coding Style — Design Decisions & Implicit Rules

This document captures decisions that **cannot be inferred from code or config files alone**. For formatting rules, see `.prettierrc` and `eslint.config.mjs`. For project structure, explore the `packages/` directory.

## Implicit Rules

### Language Policy

All code, comments, commit messages, and documentation MUST be written in English — even when the user communicates in Japanese.

- **WHY (agent/backend):** ESLint `no-restricted-syntax` detects Japanese characters in string literals. Backend code is never user-facing; Japanese would block future internationalization.
- **WHY (frontend):** User-visible strings go through `react-i18next` (`t()` function). The `i18next/no-literal-string` ESLint rule catches hardcoded JSX text. Raw Japanese in components bypasses the translation pipeline.

### Do NOT Run `npm run dev` Unless Told To

Developers typically already have `npm run dev` running with hot-reload. Starting a second instance causes port conflicts. Only run it when the user explicitly asks.

### Comments Explain WHY, Not WHAT

The codebase uses `// WHY:` prefixed comments for non-obvious decisions (see `useMessageEventsSubscription.ts`, `chatStore.ts`). Write comments only when the reason behind the code is not self-evident. Never comment what the code literally does.

## Design Decisions

### ID Generation: nanoid vs uuid

| Context | Library | Reason |
|---------|---------|--------|
| New IDs (sessions, triggers, frontend) | `nanoid` / `customAlphabet` | Shorter, URL-safe, no hyphens |
| Cognito `sub` (external) | UUID | Comes from AWS, cannot change format |
| `agents-service.ts` | `uuid` (v4) | Historical — predates nanoid adoption. Do not migrate without reason. |

**sessionId specifically** uses `customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 33)` because AgentCore requires `[a-zA-Z0-9][a-zA-Z0-9-_]*`. Hyphens and underscores are excluded to avoid edge-case issues with the first-character constraint.

### CONVERSATION_WINDOW_SIZE Must Be Even

The `SlidingWindowConversationManager` truncates from the oldest messages. An odd window size can break the required user→assistant→user→assistant alternation pattern, causing Bedrock API errors. The Zod schema enforces `val % 2 === 0`.

### Agent Package: ESM with .js Extensions

`packages/agent` runs as ESM. TypeScript compiles `.ts` → `.js`, but Node.js ESM resolution requires explicit `.js` extensions in import paths. ESLint `import/extensions` rule enforces this. Other packages (backend, frontend) do not have this constraint.

### Zustand: One Store Per Domain

The frontend has ~12 Zustand stores in `stores/` (auth, agent, session, chat, ui, etc.). Each store owns one domain.

- **WHY:** Zustand re-renders subscribers when any state in the store changes. Mixing domains (e.g., auth + chat) would cause unnecessary re-renders across unrelated components.
- **Pattern:** Use selectors — `useAgentStore((state) => state.agents)` — to subscribe to only the needed slice.

### Frontend i18n: No Hardcoded Strings in JSX

`eslint-plugin-i18next` with `no-literal-string` (jsx-text-only mode) catches raw text in JSX and key attributes (`title`, `aria-label`, `alt`, `placeholder`). All user-visible text must use `t('key')`. Agent names/descriptions use `translateIfKey()` utility for dynamic content that may or may not have translation keys.

## Testing Guidelines

### Test Behavior, Not Implementation

Tests should verify observable outcomes, not internal method calls. Use the AAA pattern (Arrange-Act-Assert). See existing tests in `__tests__/` directories for conventions.

### Coverage Priority

Focus testing effort in this order:
1. **High:** Business logic, data transformations, error handling
2. **Medium:** Utilities, validators
3. **Low:** Simple getters, configuration wiring

### Test Files Location

- Unit tests: co-located in `__tests__/` or `*.test.ts` next to source
- Integration tests: `tests/` directory with `*.integration.test.ts` suffix

## Anti-patterns

- **Do NOT duplicate ESLint/Prettier rules in code reviews** — they are enforced automatically via `eslint.config.mjs` and `.prettierrc`
- **Do NOT use `any`** — use `unknown` or proper types. ESLint warns on `@typescript-eslint/no-explicit-any`
- **Do NOT create new uuid usage** — use `nanoid` for new IDs. Existing `uuid` usage in `agents-service.ts` is grandfathered
- **Do NOT hardcode Japanese in agent/backend** — ESLint detects it. Use English only
- **Do NOT add `npm run dev` to automated scripts** — it is a long-running process meant for interactive use
