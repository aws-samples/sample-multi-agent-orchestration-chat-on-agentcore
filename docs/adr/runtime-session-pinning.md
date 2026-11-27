# Runtime session id ≠ conversation id (V2 session pinning)

![Runtime session pinning](../runtime-session-pinning.drawio.png)

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
   - Humans use the plain id. This keeps microVM reuse and V1 behaviour
     unchanged.
   - Machine callers append `m`.
   - Humans append `u` (`rescued`) only for conversations whose plain id was
     pinned to the machine user before the split.

   Memory, DynamoDB, S3, Code Interpreter and Browser keep the conversation
   id. The container rejects a kind that does not match the caller (403). It
   accepts a machine caller without a suffix, because Lambdas deployed before
   the split may still be running.
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
4. **The rescue is recorded on the session row**
   (`userRuntimeSessionKind: 'rescued'`), so every device starts on `u`. The
   frontend retries once on `u` only on the platform's pin 403.

## Rejected alternatives

- **Wait for the pin to expire / stop the session first.** Verified that the
  pin outlives both.
- **Suffix the human side too (and leave machine ids unchanged).** Every
  existing human conversation would move to a new microVM and lose its
  pinned history routing. Machine sessions are short-lived and stop
  themselves, so moving them costs nothing.
- **Remember the rescue in `localStorage`.** Each device would pay the 403
  round-trip, and a cleared browser would pay it again.
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
- Rollout order: the container must ship before callers send suffixed ids. The
  current container treats a 34-char id as sessionless. CloudFormation updates
  the Runtime before the Lambdas and the frontend that reference its ARN.
