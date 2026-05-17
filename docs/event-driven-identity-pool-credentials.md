# Event-Driven Agent Invocation — Per-User Identity Pool Credentials

## Overview

Event-driven agent invocations (EventBridge Scheduler / EventBridge Rules) have no frontend
and therefore no Cognito ID Token in the request. This document describes how Trigger Lambda
obtains per-user Identity Pool credentials via Developer Authenticated Identities and ensures
those credentials use the **same `identityId`** as the user's frontend sessions — keeping S3
and DynamoDB storage in the same namespace.

---

## The identityId Unification Problem

All user storage (S3 prefix and DynamoDB partition key) is keyed on `identityId`
(Cognito Identity Pool sub, format: `REGION:UUID`). If the frontend and event-driven flows
resolve to **different** `identityId` values for the same user, the agent cannot see the user's
files or session data during event-driven execution.

```
Frontend flow:
  GetId(UserPool idToken) --> identityId A = "us-west-2:e6224b58-..."
  S3:  bucket/users/us-west-2:e6224b58-.../  <-- user's actual files

Naive event-driven flow (without linking):
  GetOpenIdTokenForDeveloperIdentity(userId) --> identityId B = "us-west-2:f99aab12-..."
  S3:  bucket/users/us-west-2:f99aab12-.../  <-- WRONG namespace, files not found
```

### Solution: link developer login to identity A

When the user logs in via the frontend, the AgentCore Runtime calls
`GetOpenIdTokenForDeveloperIdentity(IdentityId=A, Logins={userPool: idToken, dev: userId})`.
This permanently links the developer login `{developerProviderName: userId}` to identity A.

After this one-time link, Trigger Lambda calls `GetOpenIdTokenForDeveloperIdentity` with
**only the developer login** (no explicit `IdentityId`). Cognito resolves identity A from the
stored link and returns a token for identity A.

---

## Architecture Overview

### Frontend Login Flow (identity link establishment)

The link between `{ moca.trigger: userPoolSub }` and identity A is
established on the first request that hits **either** the AgentCore
Runtime **or** the Backend API. The Backend path is the important one
for users who only manage triggers through the web UI (create an
EventBridge Scheduler trigger and never chat with an agent): without
it, Trigger Lambda's `GetOpenIdTokenForDeveloperIdentity` call at event
fire time would create a brand-new Developer Identity B instead of
resolving identity A.

```
Frontend login
    │
    ├──(A)──▶ POST /invocations (AgentCore Runtime)
    │           └── scoped-credentials.ts linkDeveloperAuthToIdentity
    │
    └──(B)──▶ GET /agents, /triggers, ... (Backend API)
                └── identity-resolver.ts linkDeveloperAuthToIdentity
                                          (UserPool token branch only)
```

Both paths execute the **same** fire-and-forget link call below. It is
idempotent at Cognito's side, and each process guards with a per-token
`linkedTokens` set to skip repeat HTTPS round trips within the same
execution environment.

```
+---------------------------------------------------------------------+
| Frontend                                                            |
|  POST /invocations             (Agent)                              |
|  GET  /agents, /triggers, ...  (Backend)                            |
|  Authorization: Bearer <accessToken>                                |
|  X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token: <UserPool idToken>|
+----------------------------+----------------------------------------+
                              | 1. HTTP Request
                              v
+---------------------------------------------------------------------+
| AgentCore Runtime  OR  Backend API                                  |
|  (request-context / authMiddleware)                                 |
|   -> context.idToken = UserPool idToken                             |
|                                                                     |
|  scoped-credentials.ts (agent)                                      |
|  identity-resolver.ts  (backend)                                    |
|   -> JWT iss = "cognito-idp.REGION.amazonaws.com/POOL_ID"           |
|      (UserPool token path)                                          |
+----------------------------+----------------------------------------+
                              | 2. GetId(idToken) --> identityId A
                              | 3. GetCredentialsForIdentity(A, idToken)
                              |    (Agent only; Backend uses STS for S3)
                              v
+---------------------------------------------------------------------+
| Cognito Identity Pool                                               |
|  -> issues temporary credentials for identity A                     |
+----------------------------+----------------------------------------+
                              | 4. temporary credentials (identity A)
                              v
+---------------------------------------------------------------------+
| Fire-and-forget link (both Agent and Backend)                       |
|                                                                     |
|  linkDeveloperAuthToIdentity(identityId=A, ...)                     |
|   -> GetOpenIdTokenForDeveloperIdentity(                            |
|        IdentityId=A,                                                |
|        Logins={                                                     |
|          "cognito-idp.../POOL_ID": UserPool idToken,                |
|          "moca.trigger": userPoolSub                                |
|        }                                                            |
|      )                                                              |
|   -> identity A now has developer login permanently linked          |
+---------------------------------------------------------------------+
```


### Event-Driven Flow (Trigger invocation)

```
+---------------------------------------------------------------------+
| Trigger Lambda                                                      |
|  Prerequisite: user has logged in via frontend at least once        |
|  (linkDeveloperAuthToIdentity has been called for identity A)       |
+----------------------------+----------------------------------------+
                             | 1. OAuth2 Client Credentials
                             |    POST {cognitoDomain}/oauth2/token
                             |    --> accessToken
                             v
+---------------------------------------------------------------------+
| Trigger Lambda (continued)                                          |
+----------------------------+----------------------------------------+
                             | 2. GetOpenIdTokenForDeveloperIdentity
                             |    IdentityId = omitted
                             |    Logins = { "moca.trigger": userId }
                             |    --> Cognito resolves identity A from
                             |        the stored developer login link
                             v
+---------------------------------------------------------------------+
| Cognito Identity Pool (Developer Authenticated Identities)         |
|  developer login "moca.trigger: userId" is linked to identity A    |
|  -> returns openIdToken (JWT, 15 min)                              |
|     iss = "https://cognito-identity.amazonaws.com"                 |
|     sub = "us-west-2:e6224b58-..."  <-- identityId A               |
+----------------------------+----------------------------------------+
                             | 3. POST /invocations
                             |    Authorization: Bearer <accessToken>
                             |    X-...-Custom-Id-Token: <openIdToken>
                             v
+---------------------------------------------------------------------+
| AgentCore Runtime                                                   |
|  requestContextMiddleware                                           |
|   -> context.idToken = openIdToken  (set regardless of user type)   |
|                                                                     |
|  scoped-credentials.ts: assumeUserScopedRole(userId)                |
|   -> JWT iss = "https://cognito-identity.amazonaws.com"             |
|      (developer-auth token path)                                    |
|                                                                     |
|  *** GetId is NOT called ***                                        |
|  identityId = JWT sub claim = "us-west-2:e6224b58-..." = A          |
|   (GetId rejects developer-auth tokens with NotAuthorizedException) |
+----------------------------+----------------------------------------+
                             | 4. GetCredentialsForIdentity(
                             |      IdentityId=A,
                             |      Logins={"cognito-identity.amazonaws.com": openIdToken}
                             |    )
                             v
+---------------------------------------------------------------------+
| Cognito Identity Pool                                               |
|  -> issues temporary credentials for identity A                     |
+----------------------------+----------------------------------------+
                             | 5. temporary credentials (identity A)
                             v
+---------------------------------------------------------------------+
| Identity Pool Authenticated Role (identity A)                       |
|  S3:       bucket/users/us-west-2:e6224b58-.../  <-- same as frontend
|  DynamoDB: partition key = "us-west-2:e6224b58-..."  <-- same data  |
+---------------------------------------------------------------------+
```

---

## The GetId Constraint with Developer-Auth Tokens

`GetId` accepts only:
- Cognito UserPool ID Tokens (`iss = https://cognito-idp.REGION.amazonaws.com/POOL_ID`)
- External OIDC provider tokens

Passing a developer-auth token (`iss = https://cognito-identity.amazonaws.com`) to `GetId`
returns the following error:

```
NotAuthorizedException: Invalid login token. Can't pass in a Cognito token.
```

> **Why the `sub` claim works as a drop-in replacement**:
>
> `GetOpenIdTokenForDeveloperIdentity` always sets the JWT `sub` to the resolved `identityId`
> (format: `REGION:UUID`). The sub value is identical to what `GetId` would have returned.
> Skipping `GetId` and reading `sub` directly is therefore semantically equivalent — but avoids
> the `NotAuthorizedException` entirely.

```typescript
// scoped-credentials.ts — token type branching
if (isDeveloperAuthToken) {
  // sub claim == identityId; GetId is not called
  identityId = jwtPayload.sub;  // "us-west-2:e6224b58-..."
} else {
  // UserPool token: resolve identityId via GetId
  const res = await identityClient.send(new GetIdCommand({ ... }));
  identityId = res.IdentityId;
}
```

### Logins key selection

| Token type | `iss` | Logins key for `GetCredentialsForIdentity` |
|---|---|---|
| Cognito UserPool ID Token | `https://cognito-idp.REGION.amazonaws.com/POOL_ID` | `cognito-idp.REGION.amazonaws.com/POOL_ID` |
| Developer-auth OpenID Token | `https://cognito-identity.amazonaws.com` | `cognito-identity.amazonaws.com` |

`scoped-credentials.ts` inspects the `iss` claim of the incoming token and selects the correct
key automatically. Using the wrong key causes `NotAuthorizedException: Invalid login token.`

---

## IAM Permission Design

### GetOpenIdTokenForDeveloperIdentity grant matrix

`GetOpenIdTokenForDeveloperIdentity` can issue a token for **any user** in the Identity Pool.
It is therefore a high-privilege action that must be tightly scoped.

| Component | `GetOpenIdTokenForDeveloperIdentity` | Arbitrary code execution risk | Rationale |
|---|---|---|---|
| **Trigger Lambda** | ✅ granted | None (fixed code, no agent tools) | Required for event-driven per-user token issuance |
| **AgentCore Runtime** | ✅ granted (limited purpose) | Yes (`execute_command` tool) | Required for `linkDeveloperAuthToIdentity` only |
| **Backend API** | ✅ granted (limited purpose) | None (Express routes only, no tool execution) | Required for `linkDeveloperAuthToIdentity` — covers the UI-only user flow where Agent is never invoked |


> **Why AgentCore Runtime needs this permission despite the risk**:
>
> `linkDeveloperAuthToIdentity` must pass **both** a valid UserPool ID Token and the developer
> login in a single `GetOpenIdTokenForDeveloperIdentity` call. The UserPool idToken is valid
> only in the Runtime context (it is forwarded from the frontend request). Therefore the link
> must be established inside the Runtime, not by Trigger Lambda.
>
> The call only succeeds when `IdentityId=A` matches the presented UserPool idToken — meaning
> the attacker would need the victim user's valid ID Token to link a developer login to
> identity A. This significantly limits the exploitability even if execution role credentials
> are stolen.

### Execution role permissions summary

| Component | S3/DynamoDB direct access | `GetCredentialsForIdentity` | `GetOpenIdTokenForDeveloperIdentity` |
|---|---|---|---|
| AgentCore Runtime execution role | ❌ none | ✅ (scoped to Identity Pool) | ✅ (scoped to Identity Pool) |
| Trigger Lambda execution role | ❌ none | ❌ none | ✅ (scoped to Identity Pool) |

> **AgentCore Runtime has no S3/DynamoDB permissions on its execution role.**
> If execution role credentials are stolen via IMDS, the attacker cannot access user data
> directly. All storage access requires a valid Cognito ID Token exchanged via `GetCredentialsForIdentity`.

### IAM policy — Trigger Lambda

```json
{
  "Sid": "CognitoIdentityDeveloperAuth",
  "Effect": "Allow",
  "Action": ["cognito-identity:GetOpenIdTokenForDeveloperIdentity"],
  "Resource": "arn:aws:cognito-identity:REGION:ACCOUNT:identitypool/POOL_ID"
}
```

### IAM policy — AgentCore Runtime

```json
{
  "Sid": "CognitoIdentityPoolGetCredentials",
  "Effect": "Allow",
  "Action": ["cognito-identity:GetId", "cognito-identity:GetCredentialsForIdentity"],
  "Resource": "arn:aws:cognito-identity:REGION:ACCOUNT:identitypool/POOL_ID"
}
```

```json
{
  "Sid": "CognitoIdentityDeveloperAuthLink",
  "Effect": "Allow",
  "Action": ["cognito-identity:GetOpenIdTokenForDeveloperIdentity"],
  "Resource": "arn:aws:cognito-identity:REGION:ACCOUNT:identitypool/POOL_ID"
}
```

### IAM policy — Backend API

```json
{
  "Sid": "CognitoIdentityDeveloperAuthLink",
  "Effect": "Allow",
  "Action": ["cognito-identity:GetOpenIdTokenForDeveloperIdentity"],
  "Resource": "arn:aws:cognito-identity:REGION:ACCOUNT:identitypool/POOL_ID"
}
```

> Backend also holds `cognito-identity:GetId` (granted by the
> Authenticated Role / identity-pool construct for per-user credential
> exchange elsewhere) but does **not** hold
> `GetCredentialsForIdentity` on its execution role — it uses STS
> AssumeRole with a session policy (`BackendUserScopedS3Role`) for
> S3 access. The developer-auth link call above is the only reason the
> backend needs a Cognito-identity write action.

---


## Attack Scenario Analysis

### Attack 1: IMDS credential theft → access user S3 data

```
Attacker steals AgentCore Runtime execution role credentials via IMDS
  |
  +-> Calls s3:GetObject directly?
  |     -> No S3 permissions on execution role -> BLOCKED v
  |
  +-> Calls GetCredentialsForIdentity with victim's identityId?
  |     -> Requires valid Cognito ID Token in the Logins parameter
  |     -> Attacker has no valid UserPool ID Token for the victim
  |     -> AWS JWKS validation fails -> BLOCKED v
  |
  +-> Calls GetOpenIdTokenForDeveloperIdentity(IdentityId=A, userId)?
        -> Requires IdentityId A to already have the developer login linked
        -> linkDeveloperAuthToIdentity requires BOTH UserPool idToken AND developer login
        -> Attacker has no valid UserPool ID Token -> BLOCKED v
```

### Attack 2: execute_command accesses other user's S3 via developer-auth token

```
Attacker runs execute_command with crafted openIdToken for victim's identityId:
  -> openIdToken would need to be issued by Cognito (cannot be forged)
  -> GetOpenIdTokenForDeveloperIdentity requires execution role permission
     and developer login linked to identity A
  -> Even if a valid openIdToken is obtained for identity A:
     Identity Pool creds are scoped to users/A/* by Authenticated Role
     Victim's data is at users/A/ -- this IS identity A's namespace
     -> This is by design: event-driven access uses the same namespace as frontend access
```

### Attack 3: Trigger Lambda issues token for wrong user

```
Attacker controls triggerId/userId payload in EventBridge event:
  -> Trigger Lambda calls GetOpenIdTokenForDeveloperIdentity(userId=attacker-controlled-value)
     without IdentityId
  -> If the developer login for that userId has never been linked:
     Cognito creates a new developer identity (not matching any frontend identity)
  -> Mitigation: EventBridge event sources are configured with specific rules
     -> Only agentcore.trigger source is processed
     -> userId comes from triggers DynamoDB table (server-controlled)
```

### Attack 4: developer-auth token replay

```
Attacker intercepts an openIdToken in transit:
  -> openIdToken is valid for 15 minutes only (Cognito default)
  -> Token is sent over HTTPS only (TLS in transit)
  -> After expiry, GetCredentialsForIdentity returns InvalidIdentityTokenException
  -> MITIGATED by short token lifetime v
```

---

## Infrastructure Changes

### CDK

| File | Change |
|---|---|
| `packages/cdk/lib/constructs/auth/cognito-identity-pool.ts` | Added `developerProviderName` prop; sets `CfnIdentityPool.developerProviderName` |
| `packages/cdk/lib/constructs/triggers/trigger-lambda.ts` | Added `identityPoolId`, `developerProviderName` props; adds env vars and `GetOpenIdTokenForDeveloperIdentity` IAM grant |
| `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts` | Added `developerProviderName` prop; adds `DEVELOPER_PROVIDER_NAME` env var and `GetOpenIdTokenForDeveloperIdentity` IAM grant |
| `packages/cdk/lib/agentcore-stack.ts` | Defines `developerProviderName = "{prefix}.trigger"`; stack-level `CfnOutput('IdentityPoolId')` for `setup-env.ts`; passes `DEVELOPER_PROVIDER_NAME` env var and `GetOpenIdTokenForDeveloperIdentity` IAM grant to the Backend API Lambda role |


### Agent (AgentCore Runtime container)

| File | Change |
|---|---|
| `packages/agent/src/config/index.ts` | Added `DEVELOPER_PROVIDER_NAME: z.string().optional()` |
| `packages/agent/src/libs/utils/scoped-credentials.ts` | ① Token type detection via `iss` claim; ② skip `GetId` for developer-auth tokens, use `sub` as `identityId`; ③ call `linkDeveloperAuthToIdentity` (fire-and-forget) |
| `packages/agent/src/libs/middleware/request-context.ts` | Set `context.idToken` regardless of `isMachineUser` if the `X-...-Custom-Id-Token` header is present |

### Backend

Event-driven Agent executions invoke Backend APIs (e.g. `GET /agents` from
the `call_agent` tool) while forwarding the developer-auth OpenID Token in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token`. The Backend's
`authMiddleware` therefore needs the same token-type branching as the
Agent container — otherwise `GetId` rejects the developer-auth token with
`NotAuthorizedException: Invalid login token.`, producing a 401 that the
`call_agent` tool surfaces as an empty agent list.

| File | Change |
|---|---|
| `packages/backend/src/libs/auth/identity-resolver.ts` | ① Token type detection via `iss` claim; ② skip `GetId` for developer-auth tokens, use `sub` as `identityId`; ③ inline `assertIdentityId` regex (avoids pulling `@moca/core` as a runtime value to stay within jest's existing non-ESM resolver) |

### Trigger Lambda

| File | Change |
|---|---|
| `packages/trigger/src/services/auth-service.ts` | Added `getOpenIdTokenForUser(userId)`: calls `GetOpenIdTokenForDeveloperIdentity` without `IdentityId`; Cognito resolves identity A from the developer login link |
| `packages/trigger/src/services/agent-invoker.ts` | Added `openIdToken` parameter to `sendRequest()` and `invokeAsync()`; attaches `X-...-Custom-Id-Token` header |
| `packages/trigger/src/handlers/schedule-handler.ts` | Calls `getOpenIdTokenForUser(userId)` (non-fatal); passes `openIdToken` to `invokeAsync()` |
| `packages/trigger/src/handlers/custom-event-handler.ts` | Same as `schedule-handler.ts` |

---

## Integration Tests

```bash
# Trigger Lambda — Suites 1-3
cd packages/trigger
npm run test:integration

# Agent — Suite 1 (no local agent required); Suite 2 requires npm run dev
cd packages/agent
npm run test:integration
```

| File | Suite | What it verifies |
|---|---|---|
| `packages/trigger/src/__tests__/integration.test.ts` | Suite 1 | `getOpenIdTokenForUser()` returns openIdToken; JWT `iss` is `cognito-identity.amazonaws.com`; idempotent |
| `packages/trigger/src/__tests__/integration.test.ts` | Suite 2 | `GetCredentialsForIdentity` with developer-auth token succeeds using `Logins={"cognito-identity.amazonaws.com": token}` |
| `packages/trigger/src/__tests__/integration.test.ts` | Suite 3 | End-to-end `handler()` invocation returns HTTP 200 with `hasOpenIdToken: true` |
| `packages/agent/src/tests/developer-auth-identity.integration.test.ts` | Suite 1 | developer-auth credentials allow `s3:ListObjects` on `users/{identityId A}/` prefix |
| `packages/agent/src/tests/developer-auth-identity.integration.test.ts` | Suite 2 | Local Agent accepts POST with `openIdToken` header and streams a response |

---

## Related Files

| File | Role |
|---|---|
| `packages/agent/src/libs/utils/scoped-credentials.ts` | Token type detection; `GetId` skip for developer-auth; `linkDeveloperAuthToIdentity` |
| `packages/agent/src/libs/middleware/request-context.ts` | ID Token extraction from custom header (both UserPool and developer-auth tokens) |
| `packages/agent/src/config/index.ts` | `DEVELOPER_PROVIDER_NAME` env var schema |
| `packages/trigger/src/services/auth-service.ts` | `getOpenIdTokenForUser()`: `GetOpenIdTokenForDeveloperIdentity` (no IdentityId; Cognito resolves from link) |
| `packages/trigger/src/services/agent-invoker.ts` | `openIdToken` forwarding via `X-...-Custom-Id-Token` header |
| `packages/trigger/src/handlers/schedule-handler.ts` | Per-user OpenID Token acquisition and injection for scheduled triggers |
| `packages/trigger/src/handlers/custom-event-handler.ts` | Same for custom event triggers |
| `packages/cdk/lib/constructs/auth/cognito-identity-pool.ts` | Identity Pool with `developerProviderName` |
| `packages/cdk/lib/constructs/triggers/trigger-lambda.ts` | Trigger Lambda IAM grant for `GetOpenIdTokenForDeveloperIdentity` |
| `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts` | Runtime IAM grant for `GetOpenIdTokenForDeveloperIdentity` (for `linkDeveloperAuthToIdentity`) |
| `packages/cdk/lib/agentcore-stack.ts` | Stack orchestration: `developerProviderName`, `CfnOutput('IdentityPoolId')` |
| `packages/backend/src/libs/auth/identity-resolver.ts` | Backend-side link: calls `linkDeveloperAuthToIdentity` on every UserPool token seen so users who only hit Backend API (not Agent) still establish the developer-auth link before Trigger Lambda fires |
| `packages/backend/src/config/index.ts` | `DEVELOPER_PROVIDER_NAME: z.string().optional()` |
| `docs/aws-data-access-control.md` | Base document: per-user S3/DynamoDB isolation design using `identityId` |

---

## Runbook — Cleaning up orphan Identity Pool identities

When a user triggered an event-driven invocation **before** the fix in this
document was deployed (i.e. before the Backend started performing the link
on every login), Cognito created a second Developer Identity B on the first
event fire. After deployment, subsequent event fires resolve correctly to
identity A, but the orphan identity B lingers in the Identity Pool.

### 1. Detect

For a given UserPool sub (`userPoolSub`), list the linked identities:

```bash
aws cognito-identity lookup-developer-identity \
  --identity-pool-id "$IDENTITY_POOL_ID" \
  --developer-user-identifier "$userPoolSub" \
  --max-results 10
```

You should see exactly **one** identityId. If the command returns nothing
or only the orphan B, the link is broken.

In the Cognito console (Identity Pools → *pool* → Identity browser) look
for users with more than one identityId in a short time window; the one
linked to the UserPool idp entry (`cognito-idp.REGION.amazonaws.com/POOL_ID`)
is the correct identity A.

### 2. Migrate data (if B has any real data)

If the user managed to have Trigger Lambda fire repeatedly against
identity B, there may be user data under the orphan prefix:

```bash
# S3
aws s3 sync \
  "s3://$USER_STORAGE_BUCKET/users/${ORPHAN_IDENTITY_ID}/" \
  "s3://$USER_STORAGE_BUCKET/users/${CORRECT_IDENTITY_ID}/"

# DynamoDB (sessions): inspect the partition first
aws dynamodb query \
  --table-name "$SESSIONS_TABLE_NAME" \
  --key-condition-expression "identityId = :iid" \
  --expression-attribute-values '{":iid":{"S":"'"$ORPHAN_IDENTITY_ID"'"}}'
```

Migrate DynamoDB items with a one-off script if needed (not provided —
depends on how many items and whether any session is live).

### 3. Delete the orphan identity

```bash
aws cognito-identity delete-identities \
  --identity-ids-to-delete "$ORPHAN_IDENTITY_ID"
```

Then delete the abandoned S3 prefix:

```bash
aws s3 rm --recursive "s3://$USER_STORAGE_BUCKET/users/${ORPHAN_IDENTITY_ID}/"
```

### 4. Verify

Re-run step 1 — the orphan must be gone. Trigger a new event (or ask the
user to trigger one) and confirm the Agent logs show the expected
`identityId` matching the frontend identity A.


> **Implementation note — `GetId` rejection**:
> `GetId` rejects developer-auth tokens (issued by `GetOpenIdTokenForDeveloperIdentity`) with
> `NotAuthorizedException: Invalid login token. Can't pass in a Cognito token.` This is an AWS
> API constraint, not a configuration issue. The `sub` claim of the developer-auth JWT is always
> the `identityId` — reading it directly is the correct workaround.

> **Implementation note — `linkDeveloperAuthToIdentity` is idempotent**:
> Once a developer login is linked to identity A, calling `GetOpenIdTokenForDeveloperIdentity`
> with `IdentityId=A` again has no side effect — Cognito simply returns a new short-lived token
> for the same identity. The fire-and-forget call on every frontend login is safe.

> **Implementation note — IdentityId omission in Trigger Lambda**:
> Trigger Lambda calls `GetOpenIdTokenForDeveloperIdentity` **without** `IdentityId`. Cognito
> resolves identity A from the developer login link (`{developerProviderName: userId}`) that was
> established by `linkDeveloperAuthToIdentity` on the user's first frontend login. This avoids
> the need for a separate DynamoDB table to store `userId → identityId` mappings.
> The application guarantees that users always log in via the frontend before any event-driven
> trigger fires for their account (this is enforced by the application's user flow).
