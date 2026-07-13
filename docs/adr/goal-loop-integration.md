# ADR: Per-message GoalLoop integration

Status: Accepted — implemented 2026-07-11.

## Context

Users want to attach a quality bar to a single chat turn ("answer in at most 3
sentences", "include a code example", …) and have the agent keep refining until
that bar is met. Strands ships a vended `GoalLoop` plugin
(`@strands-agents/sdk/vended-plugins/goal`) that does exactly this: after each
invocation it validates the last assistant message against a natural-language
goal via an internal judge Agent, and on failure re-enters the agent loop with
the judge's feedback as a new user message, until the goal passes or a bound is
hit.

This ADR records the non-obvious decisions made wiring it in. What the code does
is readable from the code; this captures the *why* and the rejected alternatives.

## Decisions

### 1. SDK upgrade 1.2.0 → 1.8.0

GoalLoop does not exist in 1.2.0; it was added in 1.8.0. We pin `~1.8.0` (not
`^1.8.0`) so we stay on the exact minor the integration was validated against,
rather than silently floating to 1.9.x.

`@strands-agents/sdk@>=1.8` declares `express ^5` as an **optional** peer. This
repo intentionally stays on Express 4 (Lambda Web Adapter and AgentCore both
work with it; an Express 5 migration is out of scope). npm raises ERESOLVE when
a present dependency mismatches an optional peer, so the upgrade commit itself
was installed with `--legacy-peer-deps`. A repo-wide `.npmrc` with
`legacy-peer-deps=true` was considered and REJECTED: it silences install-time
peer-conflict detection for every package, not just this one mismatch. The
committed `package-lock.json` already encodes the resolved tree, so
`npm install` / `npm ci` succeed with strict peer checking; only a future
re-resolution of the SDK subtree (e.g. bumping `@strands-agents/sdk`) re-fires
the ERESOLVE — pass `--legacy-peer-deps` for that one command, or move to
Express 5 by then.

**Collateral (verified, not a GoalLoop concern):** 1.8 changed `AgentSkills` to
load filesystem path sources lazily in `initAgent(agent)` via `agent.sandbox`,
instead of scanning in the constructor. Production is unaffected (the plugin's
`initAgent` runs inside `new Agent`), but two skills unit tests that called
`getAvailableSkills()` with no agent had to move to a shared local-FS fake-agent
helper (`packages/agent/src/tests/skills-local-sandbox.ts`).

### 2. Per-message scope, not per-agent / sticky

The goal applies to exactly one send. It is NOT persisted on the agent config
and does NOT carry across sessions. Rationale: a goal is a property of a request
("this answer must…"), not of the agent. Making it sticky would silently
constrain later turns the user didn't intend. Frontend state lives in
`MessageInput` and is cleared on every submit; the agent is already stateless
per `POST /invocations`, so nothing persists server-side either.

Consequence: no backend change. Chat bypasses the backend (frontend calls the
AgentCore Runtime directly), and `buildRequestBody` already forwards every
non-undefined `AgentConfig` key, so adding `goal` / `goalJudgeModelId` to the
config type is enough to put them on the wire.

**Amendment (2026-07-11): opt-in sticky goal, client-side only.** Users asked
for a "keep applying" mode. The wire contract above is UNCHANGED — the agent
still receives a plain per-message `goal` and persists nothing. Stickiness is
implemented entirely in the frontend: a checkbox in the goal modal mirrors the
goal into `settingsStore.persistentGoal` (zustand `persist` → localStorage, one
global value), and `MessageInput` seeds its local goal state from it and skips
the after-send clear while the flag is on. Unchecking reverts to per-message
(the typed goal survives for exactly one more send); "Clear" removes both.

Rejected alternative — server-side per-agent goal persistence: it would break
runtime statelessness, hide a per-turn judge cost behind an agent config the
user may not remember, and require backend/API changes for what is a UI
preference. localStorage means no cross-device sync; that trade-off is accepted
and labeled in the UI ("saved in this browser").

### 3. GoalLoop plugin ordering + the AGENT_COMPLETE hazard

`AfterInvocationEvent` fires **once per attempt**. `SessionPersistenceHook`
listens on it to run its "turn finished" finalize: `saveMessages` +
publish `AGENT_COMPLETE`. Left alone, a 3-attempt goal turn would fire
`AGENT_COMPLETE` three times and persist mid-refinement states.

Two-part fix, both required:

1. **GoalLoop is appended LAST in the `plugins` array.** After\* hooks dispatch
   in reverse-registration (LIFO) order, so GoalLoop's callback runs *first* and
   sets `event.resume` before `SessionPersistenceHook` observes it.
2. **`SessionPersistenceHook.onAfterInvocation` starts with a resume guard:**
   `if (event.resume !== undefined) return;`. On intermediate attempts (GoalLoop
   is retrying) `resume` is set, so finalize is skipped. Only the terminal
   attempt (goal met / maxAttempts / timeout → `resume === undefined`) finalizes.
   The comparison is `!== undefined`, not truthiness, because `resume` is
   `InvokeArgs | undefined` and a falsy-but-defined value still means "resuming".

**Amendment (2026-07-13): the resume guard alone was not enough.**
`MessageAddedEvent` also fires once per appended message — including the failed
intermediate assistant answers and the synthetic judge-feedback prompts the
resume loop appends as *user* messages. The hook's real-time path
(`onMessageAdded` → Memory `appendMessage` + AppSync `MESSAGE_ADDED`) was
persisting and broadcasting all of that scaffolding. Fix: `setupSession` passes
`goalActive` (derived from the validated request `goal`), and the hook then
buffers everything after the turn's own user input. An intermediate
`AfterInvocationEvent` (resume armed) discards the buffered attempt and marks
the next user message as judge feedback (skipped); the terminal event flushes
the buffer — now exactly the final attempt — through the normal
persist+publish path. The whole-history `saveMessages` fallback is skipped on
goal turns: `agent.messages` still contains every attempt (GoalLoop keeps
context across retries), and its count-based dedup would re-leak them.
Trade-off: other tabs see the goal turn's assistant message at turn end
instead of streaming — acceptable, since only the final attempt may ever be
visible there. Pinned by an end-to-end test
(`goal-loop-persistence.test.ts`) that runs a real Agent + GoalLoop + hook
through the SDK's actual dispatch and asserts exactly one `AGENT_COMPLETE`
and a persisted transcript of `[input, final answer]` — this also locks the
LIFO After*-hook dispatch assumption to observed behavior.

Rejected alternative: gating persistence on a GoalLoop-specific flag threaded
through options for the AGENT_COMPLETE half. The resume field is already the
SDK's own signal for "another attempt is coming"; keying off it needs no extra
plumbing. (The buffering half does need the `goalActive` flag — resume state
isn't visible from MessageAddedEvent.)

### 4. Judge span excluded from observability token aggregation

The judge is a full internal `Agent`, so it emits its own `invoke_agent` span.
`StrandsSpanKindFixer` promotes `invoke_agent` INTERNAL→CLIENT (so AgentCore
Observability sums tokens at the trace level) and projects prompt/completion
onto LLO attributes. Applied to the judge span, this would **double-count** the
goal turn's tokens (host agent + judge) and surface the judge's internal grading
as user-facing Input/Output.

Discriminator: every agent WE build goes through `createAgent`, which stamps a
dedicated marker `moca.agent.managed=true` onto the span via `traceAttributes`
— **unconditionally**, independent of any resolved user. The judge Agent is
constructed internally by the SDK with no id, the default name, and none of our
trace attributes, so its span lacks the marker. The fixer gates both
adaptations on that marker.

Rejected alternatives: matching the judge by agent name (`'Strands Agent'`) or
absence of an id — fragile to SDK internals. Gating on `enduser.id` (the first
implementation) — repurposes a user-attribution attribute as an "our agent"
marker, and `userId` is optional on some paths (a sub-agent task that lost its
context), so those spans would silently drop out of token aggregation. A
positive, purpose-built marker on our own spans is stable because we control
both ends.

### 5. Haiku-class judge default + finite bounds

`GOAL_JUDGE_MODEL_ID` defaults to `global.anthropic.claude-haiku-4-5-20251001-v1:0` — judging
is a cheap, high-frequency structured-output call, so a small fast model is the
right default. Adding Haiku 4.5 required a new entry in the `@moca/core`
`BEDROCK_MODEL_DEFINITIONS` registry AND a mirror in CDK `bedrockModels` (CDK does
not import `@moca/core`; the mirror is what grants the model's inference-profile
IAM ARN). Haiku is marked `reasoningCapable` (capped at `high`, non-Opus tier) to
satisfy the registry invariant and because it is also selectable as a chat model;
the judge itself sends no thinking field.

Bounds are finite and mandatory: `maxAttempts: 3`, `timeout: 120_000`. The SDK
warns and never terminates if both are Infinity. Finite bounds also stop a
stubborn judge from looping forever (attempts) or pinning the microVM
(wall-clock).

### 6. Judge model selectable from the frontend

The goal modal exposes a judge-model picker (same `BEDROCK_MODEL_DEFINITIONS`
source as the chat model selector) with a "Default (server setting)" option that
sends no `goalJudgeModelId`, letting the agent fall back to `GOAL_JUDGE_MODEL_ID`.
The agent validates the requested id against the registry (`isKnownModelId`) and
falls back to the default on an unknown/absent id, so a bad client value degrades
gracefully instead of failing at invocation with AccessDenied.

### 7. Completion summary, not live progress

The completion event carries `metadata.goalResult = { passed, stopReason,
attempts }` (attempt *count* only — per-attempt feedback text is deliberately not
streamed to the client). The UI shows a compact "Goal met/not met after N
attempts" note when `attempts > 1`. A live "refining (k/N)…" indicator was
considered and rejected as brittle: refinement retries stream through the same
`agent.stream()` into one assistant message, and there is no clean per-attempt
boundary on the wire.
