# Runtime session id ≠ conversation id (V2 session pinning)

![Runtime session pinning](../runtime-session-pinning.drawio.png)

Per-request detail: [runtime-session-pinning-detail.drawio.png](../runtime-session-pinning-detail.drawio.png)

## Context

On AgentCore Runtime platform version V2, a runtime session is pinned to the
identity (JWT `sub`) that first invoked it. Every other identity gets the
platform's own `403 AccessDeniedException`, before the container sees the
request. Verified on dev (2026-11-27):

- The pin applies between any two identities: human to human, human to
  machine user, and machine user to human.
- The pin survives `StopRuntimeSession` and the idle timeout. A stopped or
  idle session id stays unusable for the other identity, so the conflict
  cannot be avoided by waiting or by stopping first.
- Only the owner can stop the session (`/stopruntimesession` with a Bearer
  token). A different identity gets 403. SigV4 is rejected on a JWT Runtime
  ("Authorization method mismatch").
- The 403 carries `access-control-allow-origin: *`, and `x-amzn-ErrorType` is
  exposed, so browser JS can tell it apart from other failures.

Moca used one value as both the conversation id and the runtime session id.
Humans (Cognito user tokens) and automation (triggers, workflow steps, workflow
callbacks, all using the machine-user client-credentials token) therefore
locked each other out of a conversation, whichever side touched it first.

## Decision

1. **Runtime session id = conversation id + caller kind**
   (`toRuntimeSessionId` / `parseRuntimeSessionId` in `@moca/core`).
   - Humans always append `u`, machine callers always append `m`.
   - Nobody sends the plain id any more. Before the split both sides used it,
     so on an existing conversation it may be pinned to either. Abandoning it
     lets both sides continue every existing conversation without knowing who
     pinned it.

   Memory, DynamoDB, S3, Code Interpreter and Browser keep the conversation
   id. The container rejects a kind that does not match the caller (403). It
   accepts a plain id from either side, because clients deployed before the
   split (open browser tabs, Lambdas, running durable executions) may still
   send it.
2. **Per-conversation turn lock on the moca-sessions item**
   (`activeTurnOwner` / `activeTurnRunner` / `activeTurnLeaseUntil`). Two
   microVMs can now serve one conversation, so the in-process `turn-registry`
   no longer covers every case.
   - The lock is taken before `createAgent`: history must not be loaded while
     another turn is mid-tool-loop.
   - Creating a new conversation's item takes the lock in the same write.
   - The lease is renewed every 60 s to now + 180 s.
   - The lock is held through the final S3 sync, so another microVM never
     starts on stale files.
   - A DynamoDB error runs the turn unlocked instead of failing the prompt.
3. **Machine runtime sessions stop themselves** after the response (HTTPS,
   with the caller's freshest bearer token). A machine-pinned session can
   never be continued by a human, so stopping it is always safe.

## Rejected alternatives

- **Wait for the pin to expire / stop the session first.** Verified that the
  pin outlives both.
- **Humans keep the plain id; only machine callers are suffixed.** A
  conversation whose plain id was pinned to the machine user before the split
  then needs a second human id, chosen either by retrying on the platform's
  403 (an unintuitive client contract) or by a per-conversation flag on the
  session row, which nobody can set before the first 403 without migrating
  old data. Suffixing both sides costs one cold start per existing
  conversation, on its first turn after the deploy.
- **A separate IAM-authenticated Runtime for automation.** Doubles the Runtime
  and its config surface for what a suffix solves.
- **Lock in the in-process registry only.** Human and machine turns now run
  in different microVMs.

## Consequences

- When humans and automation take turns in one conversation, it alternates
  between two microVMs. Each turn re-reads history from Memory and pulls the
  workspace diff from S3, which already happens on every turn.
- `call_agent` sub-agents do not go through `/invocations` and still write only
  the display marker (`activeTurnStartedAt`).
- The first human turn on each existing conversation after the deploy starts
  a new microVM; its history and files are unaffected.
- Rollout order: the container must ship before callers send suffixed ids. The
  current container treats a 34-char id as sessionless. CloudFormation updates
  the Runtime before the Lambdas and the frontend that reference its ARN.
