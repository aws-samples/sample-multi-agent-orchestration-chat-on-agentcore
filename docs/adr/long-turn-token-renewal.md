# Long-turn token renewal and single in-flight turn

## Context

An agent turn can run for hours (up to the 8 h AgentCore microVM lifetime),
but everything user-scoped hangs off Cognito tokens captured at request start:

- Identity Pool credentials (S3, DynamoDB, AgentCore Memory) live 1 h and can
  only be re-minted with an unexpired ID token (1 h).
- Backend API and AgentCore Gateway calls forward the access / ID token (1 h).

Persistence is deliberately non-blocking, so expiry did not stop the turn — it
silently stopped saving history and workspace files.

## Decision

1. User-scoped SDK clients get a credential **provider**, not static keys, so
   the SDK re-mints before expiry.
2. Every verified request records its tokens as the **freshest for its Runtime
   session** (`session-token-store`). Credential re-minting and all outbound
   calls read the freshest token (`getCallerIdToken` /
   `getCallerAuthorizationHeader`), never the request-start copy.
3. While a turn runs, the frontend re-sends refreshed tokens every 10 min with
   `{ action: 'renewTokens' }` on the same Runtime session. AgentCore routes it
   to the same microVM; it is answered before `validateInvocation` and never
   starts a turn.
4. Event-driven turns have no client, so the Trigger Lambda requests an 8 h
   developer-auth token instead (see
   `event-driven-identity-pool-credentials.md`, Attack 4).
5. One turn per session per process (`turn-registry`). A second prompt gets a
   `serverTurnInProgressEvent`; the session row carries `activeTurnStartedAt`
   so a reloaded UI shows the running turn.

## Rejected alternatives

- **Longer `idTokenValidity`.** Lengthens bearer-token exposure for every
  browser session, not just long turns, and still caps at 1 day.
- **Runtime mints tokens via the Backend (developer-auth for the caller).**
  Needs a Backend route that issues tokens for an arbitrary user to the
  runtime, putting developer-provider privilege back into the runtime path.
- **Machine-user path for runtime → Backend calls.** The runtime only
  *verifies* machine-user tokens; it holds no client secret. Giving it one
  widens what a compromised runtime can do (any user via `X-Target-User-Id`).
- **Queue a second prompt instead of rejecting it.** The queued "continue"
  would run after the original turn finished, re-doing work the user did not
  ask for twice.

## Consequences

- The `renewTokens` side channel trusts only tokens that passed
  `requestContextMiddleware` (JWKS + token-confusion check), so a session can
  never pick up another user's token.
- If the tab that streams the turn is closed and no other tab reattaches,
  nothing renews the tokens. The turn keeps running and, once credentials
  cannot be re-minted, reports `persistenceDegraded` once (log + client event).
- Trigger turns still forward a 1 h machine-user access token to the Backend
  and Gateway; their calls after 1 h are not covered by this decision.
