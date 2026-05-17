# AWS Data Access Control — UserId, IdentityId, and Per-User Isolation

## Overview

Moca uses two distinct user identifiers that serve different purposes across AWS services.
Understanding when to use each is critical for correct authorization and real-time communication.

---

## Two Identifiers, Two Roles

| Identifier | Source | Format | Used for |
|------------|--------|--------|---------|
| `userId` (User Pool sub) | Cognito User Pool JWT `sub` claim | `UUID` (e.g. `d7a4-1aa8-...`) | JWT authentication, AppSync channel paths |
| `identityId` (Identity Pool sub) | `cognito-identity:GetId` response | `REGION:UUID` (e.g. `us-west-2:d7a4...`) | **S3 prefix, DynamoDB partition key, AgentCore Memory, IAM policy variable** |

> **Why `identityId` for storage and `userId` for channels**:
>
> **Storage (S3 / DynamoDB)**: IAM policy variable `${cognito-identity.amazonaws.com:sub}`
> is correctly expanded both in Resource ARNs and Condition blocks when credentials
> come from `GetCredentialsForIdentity`. The Cognito User Pool variable
> `${cognito-idp.REGION.amazonaws.com/POOL_ID:sub}` is **NOT expanded** by IAM in this
> context — it is only supported with `AssumeRoleWithWebIdentity` called directly.
> Therefore, all storage is keyed on `identityId`.
>
> **AppSync channel paths**: AppSync rejects channel path segments that contain a colon
> (`:`). Since `identityId` has the format `REGION:UUID`, it cannot be used in a channel
> path. The `userId` (plain UUID) is used instead.

### Where each ID flows in the codebase

```
Cognito User Pool JWT
  └─ sub → userId (UUID)
       │
       ├─ RequestContext.userId          — AppSync channel paths
       ├─ session-persistence-hook.ts    — publishMessage / onAfterInvocation
       ├─ session-stream-handler         — /sessions/{userId} channel
       └─ DynamoDB sessions.channelUserId — bridged to session-stream-handler

Cognito Identity Pool GetId/GetCredentialsForIdentity
  └─ identityId (REGION:UUID)
       │
       ├─ RequestContext.identityId      — stored after GetId exchange
       ├─ scoped-credentials.ts          — credential cache key
       ├─ S3 prefix: users/{identityId}/ — per-user file storage
       ├─ DynamoDB sessions.userId (PK)  — partition key for session records
       └─ AgentCore Memory actorId       — per-user conversation history
```

### DynamoDB sessions table — bridging the two IDs

The `sessions` table uses `identityId` as the partition key (`userId` attribute) to satisfy
the IAM `LeadingKeys` condition. To allow `session-stream-handler` to publish to the correct
AppSync channel without performing a reverse lookup, the User Pool sub is stored as a
separate attribute at session creation time:

```
sessions table
  userId (PK)      = identityId  "us-west-2:e622..."   ← IAM / DynamoDB access control
  channelUserId    = userId      "abcd-1234-..."        ← AppSync /sessions/{channelUserId}
  sessionId (SK)   = "session-xxx"
  ...
```

`session-stream-handler` reads `channelUserId` from the DynamoDB Stream `NewImage` and uses
it for the AppSync channel path. Records without `channelUserId` are skipped with a warning.

---

## Architecture Overview

### Request Flow

```
+---------------------------------------------------------------------+
| User A  (identityId: us-west-2:d77773...)                           |
|  Login -> accessToken + idToken from Cognito User Pool              |
+----------------------------+----------------------------------------+
                             | 1. HTTP Request
                             |    Authorization: Bearer <accessToken>
                             |    X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token: <idToken>
                             v
+---------------------------------------------------------------------+
| AgentCore Runtime  (Docker / ARM64)                                 |
|  ExecutionRole: no S3/DynamoDB permissions (minimized)              |
|                                                                     |
|  middleware/request-context.ts                                      |
|    -> Parse JWT -> set userId (User Pool sub) in request context    |
|    -> Extract idToken from custom header                            |
|                                                                     |
|  2. tools/s3-list-files.ts or execute-command.ts is invoked         |
|       -> scoped-credentials.ts: getIdentityPoolCredentials()        |
+----------------------------+----------------------------------------+
                             | 3. cognito-identity:GetId
                             |    -> returns identityId = "us-west-2:d77773..."
                             |    cognito-identity:GetCredentialsForIdentity
                             |    Logins: { "cognito-idp...": idToken }
                             v
+---------------------------------------------------------------------+
| AWS Cognito Identity Pool                                           |
|                                                                     |
|  ID Token JWKS validation:                                          |
|   v Token signature valid                                           |
|   v Token not expired                                               |
|   v sub = userId (User Pool sub)                                    |
|                                                                     |
|  -> Issue temporary credentials                                     |
|     Principal: Authenticated Role                                   |
|     Session tag: cognito-identity.amazonaws.com:sub = identityId   |
+----------------------------+----------------------------------------+
                             | 4. Temporary credentials
                             |    (AccessKeyId, SecretKey, Token)
                             |    identityId stored in RequestContext
                             v
+---------------------------------------------------------------------+
| Identity Pool Authenticated Role (assumed session)                  |
|                                                                     |
|  Effective permissions (${cognito-identity.amazonaws.com:sub}       |
|  is expanded correctly in both Resource ARNs and Conditions):       |
|    S3 objects: arn:aws:s3:::bucket/users/${identityId}/*            |
|    S3 list  : users/${identityId}/* (prefix condition)              |
|    DynamoDB : partition key = ${identityId} (LeadingKeys)           |
+----------------------------+----------------------------------------+
                             | 5. S3 operation: bucket/users/us-west-2:d77773.../...
                             v
+---------------------------------------------------------------------+
| S3: moca-user-storage-{account}-{region}                            |
|                                                                     |
|  Bucket Policy Deny (DenyS3ObjectAccessOutsideUserScopedPrefix):    |
|    Principal  : assumed-role/*-identity-pool-auth-*/...             |
|    NotResource: bucket/users/${cognito-identity.amazonaws.com:sub}/*|
|    -> Per-user isolation enforced at bucket policy level            |
|                                                                     |
|  Bucket layout:                                                     |
|    users/                                                           |
|    +-- us-west-2:d77773.../  <- User A only                        |
|    |   +-- memo.md                                                  |
|    +-- us-west-2:d77774.../  <- User B's data (access denied)      |
|        +-- secret.md                                                |
+---------------------------------------------------------------------+
```

---

## IAM Multi-Layer Defense

Effective permission formula:

```
Effective = Identity Pool Authenticated Role Policy (${cognito-identity.amazonaws.com:sub})
          ∩ S3 Bucket Policy (Deny via NotResource using same variable)
```

### Layer 1: Application Layer (middleware)

| File | Role |
|------|------|
| `packages/agent/src/libs/middleware/request-context.ts` | Parse JWT → set `userId`; extract `idToken`; store `identityId` after GetId |
| `packages/agent/src/libs/utils/scoped-credentials.ts` | GetId → GetCredentialsForIdentity; cache by identityId |
| `packages/agent/src/handlers/auth-resolver.ts` | Resolve userId for regular/machine users; prevent context poisoning |

### Layer 2: execute_command Security

| Measure | Location | Effect |
|---------|----------|--------|
| IMDS endpoints in blocked command list | `execute-command.ts` `DANGEROUS_COMMANDS` | Block `curl http://169.254.169.254/...` |
| `AWS_EC2_METADATA_DISABLED=true` | Child process env | Disable AWS SDK IMDS fallback |
| `AWS_METADATA_SERVICE_TIMEOUT=0` | Child process env | Disable metadata service timeout |
| Override with Identity Pool credentials | `...scopedEnv` | Child process uses per-user credentials |

### Layer 3: Cognito Identity Pool (core isolation)

The Identity Pool Authenticated Role uses `${cognito-identity.amazonaws.com:sub}` which is
correctly expanded in **both Resource ARNs and Condition blocks** by IAM:

```json
{
  "Sid": "S3UserStorageObjectAccess",
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject"],
  "Resource": "arn:aws:s3:::bucket/users/${cognito-identity.amazonaws.com:sub}/*"
}
```

```json
{
  "Sid": "S3UserStorageListAccess",
  "Effect": "Allow",
  "Action": "s3:ListBucket",
  "Resource": "arn:aws:s3:::bucket",
  "Condition": {
    "StringLike": {
      "s3:prefix": ["users/${cognito-identity.amazonaws.com:sub}/*",
                    "users/${cognito-identity.amazonaws.com:sub}"]
    }
  }
}
```

```json
{
  "Sid": "DynamoDBSessionsAccess",
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
             "dynamodb:DeleteItem", "dynamodb:Query"],
  "Resource": ["<sessions-table-arn>", "<sessions-table-arn>/index/*"],
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["${cognito-identity.amazonaws.com:sub}"]
    }
  }
}
```

> **Why `${cognito-identity.amazonaws.com:sub}` works but `${cognito-idp...sub}` does not**:
> When using `GetCredentialsForIdentity`, Cognito Identity Pool internally calls
> `sts:AssumeRoleWithWebIdentity`. IAM expands session context variables from the
> identity provider that issued the credentials — which is `cognito-identity.amazonaws.com`,
> not the User Pool OIDC provider. The User Pool sub variable is available only when
> `AssumeRoleWithWebIdentity` is called directly with the User Pool as the provider.

### Layer 4: S3 Bucket Policy (defence-in-depth)

The bucket policy Deny rule uses the same `${cognito-identity.amazonaws.com:sub}` variable
to enforce per-user prefix isolation even if the role policy were misconfigured:

```json
{
  "Sid": "DenyS3ObjectAccessOutsideUserScopedPrefix",
  "Effect": "Deny",
  "Principal": "*",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
  "NotResource": "arn:aws:s3:::bucket/users/${cognito-identity.amazonaws.com:sub}/*",
  "Condition": {
    "ArnLike": {
      "aws:PrincipalArn": ["arn:aws:iam::{account}:assumed-role/*-identity-pool-auth-{region}/*"]
    }
  }
}
```

This blocks any Identity Pool authenticated session from accessing outside their own
`users/{identityId}/` prefix, regardless of what the role policy allows.

---

## Attack Scenario Analysis

### Attack 1: IMDS credential theft → S3 access

```
Attacker steals execution role credentials via IMDS
  |
  +-> Calls s3:GetObject directly?
  |     -> No S3 permissions on execution role -> BLOCKED v
  |
  +-> Calls cognito-identity:GetCredentialsForIdentity?
        -> Requires valid Cognito ID Token in the Logins parameter
        -> Attacker has no valid ID Token for the victim user
        -> AWS rejects (JWKS validation fails) -> BLOCKED v
```

### Attack 2: execute_command accesses other user's S3 via aws CLI

```
Attacker runs: aws s3 ls s3://bucket/users/victim-identityId/
  -> Child process uses Identity Pool credentials (scopedEnv override)
  -> Identity Pool role policy: Resource = bucket/users/${identityId}/*
     identityId = attacker's own Identity Pool sub
  -> Access to bucket/users/victim-identityId/ denied -> BLOCKED v

Even if attacker tries to bypass scopedEnv and use IMDS:
  -> AWS_EC2_METADATA_DISABLED=true in child process env -> BLOCKED v
  -> 169.254.169.254 blocked in DANGEROUS_COMMANDS -> BLOCKED v
```

### Attack 3: Cross-user S3 access via Identity Pool credentials

```
Attacker (identityId: us-west-2:attacker) tries to access victim's data:
  1. Obtain own ID Token and call GetCredentialsForIdentity
     -> credentials with identityId = "us-west-2:attacker"
  2. Try to access users/us-west-2:victim/secret.md
     -> Role policy: Resource = bucket/users/us-west-2:attacker/* -> BLOCKED v
     -> Bucket policy Deny: NotResource expands to bucket/users/us-west-2:attacker/*
        -> Access to users/us-west-2:victim/* triggers Deny -> BLOCKED v
```

### Attack 4: ID Token forgery

```
Attacker crafts a fake ID Token:
  1. Call GetCredentialsForIdentity with forged token
     -> AWS validates via Cognito JWKS -> Signature fails -> BLOCKED v
```

---

## DynamoDB Session Data

DynamoDB access uses `${cognito-identity.amazonaws.com:sub}` in the `LeadingKeys` condition,
which correctly restricts access to items where the partition key equals the user's `identityId`.

```json
{
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["${cognito-identity.amazonaws.com:sub}"]
    }
  }
}
```

`Scan` is intentionally excluded from allowed actions to prevent full-table reads.

---

## Related Files

| File | Role |
|------|------|
| `packages/agent/src/libs/utils/scoped-credentials.ts` | GetId + GetCredentialsForIdentity; identityId as storage key |
| `packages/agent/src/libs/middleware/request-context.ts` | ID Token extraction; identityId stored in context |
| `packages/agent/src/runtime/tools/execute-command.ts` | Shell command execution (IMDS blocking, scoped credentials) |
| `packages/agent/src/services/sessions-service.ts` | DynamoDB session CRUD; writes channelUserId alongside identityId PK |
| `packages/agent/src/services/session/session-persistence-hook.ts` | Writes channelUserId to DynamoDB; uses userId for AppSync channel |
| `packages/agent/src/types/session-persistence-deps.ts` | ISessionsService interface including channelUserId |
| `packages/session-stream-handler/src/index.ts` | Reads channelUserId from DynamoDB Stream; publishes to /sessions/{channelUserId} |
| `packages/cdk/lib/constructs/auth/cognito-identity-pool.ts` | Identity Pool + Authenticated Role (uses ${cognito-identity.amazonaws.com:sub}) |
| `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts` | ExecutionRole (minimal permissions) + `allowlistedHeaders` |
| `packages/cdk/lib/agentcore-stack.ts` | Stack orchestration |
| `packages/cdk/lib/constructs/storage/user-storage.ts` | S3 bucket + Deny policy (${cognito-identity.amazonaws.com:sub}) |
| `packages/cdk/lib/constructs/api/backend-api.ts` | Backend API CORS `allowHeaders` (includes ID Token header) |
| `packages/frontend/src/api/client/base-client.ts` | ID Token header attachment (all requests) |
| `packages/frontend/src/lib/cognito.ts` | `getValidIdToken()` function |
| `docs/cognito-identity-pool-security-design.md` | Full design document with threat model |

> **Implementation note — AgentCore Runtime header forwarding**:
> AgentCore Runtime forwards only headers explicitly listed in `requestHeaderConfiguration.allowlistedHeaders`.
> If `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Id-Token` is omitted, the header is dropped before
> reaching the container. Always keep both `Authorization` and the ID Token header in `allowlistedHeaders`.

> **Implementation note — Backend API CORS**:
> `BaseApiClient` attaches the ID Token header to all requests.
> The Backend API's API Gateway `corsPreflight.allowHeaders` must include this header,
> otherwise CORS preflight fails with a 403.

---

## Future Improvements

1. **Backend API migration**: The `BackendUserScopedS3Role` (used by the Backend API Lambda)
   still uses the STS AssumeRole approach. Since Lambda is not subject to IMDS attacks in the
   same way as the AgentCore Runtime MicroVM, this is lower priority but could be migrated
   to Cognito Identity Pool for consistency.
