# Monthly per-model token limits: the Backend is the only writer

## Context

Admins cap each user's monthly input and output tokens per model
(`tokenLimits` in `environments.ts`, Cognito groups override the base limits).
Every LLM call the Runtime makes — chat turns, sub-agents, triggers, workflow
steps, title generation, `image_to_text` — must be metered, and a user must not
be able to lower their own usage.

The Runtime execution role deliberately has no DynamoDB or S3 permissions
(`aws-data-access-control.md`); everything user-scoped runs on Identity Pool
credentials, which `execute_command` also holds.

## Decision

1. Usage lives in `${prefix}-usage` (PK `userId` = User Pool sub, SK
   `M#YYYY-MM#<modelKey>`). **Only the Backend Lambda role can access it.**
   It is keyed by the sub, not the identityId, because no user-scoped role
   ever touches it (LeadingKeys is not needed).
2. The Runtime reports usage through `POST /usage/records` and reads limits
   through `GET /usage/me`, forwarding the caller's own JWT (machine token +
   `X-Target-User-Id` for triggers). The route only accepts non-negative
   increments, so a user calling it directly can only add to their own usage.
3. Limits and group resolution are Backend-only. The Runtime sees a summary
   (`used`, `limit`, `status` per model) and never the config or the groups.
4. The month is taken from the Backend clock in the configured time zone,
   never from the client.
5. Backend outages (5xx, timeouts) **fail open**: the turn continues and the
   per-turn `TurnBudgetHook` stays the backstop. **401/403 fail closed**: two in
   a row stop the turn (`usageMeteringUnavailable`). They mean the caller's
   tokens are no longer renewed — a tab closed mid-turn
   (`long-turn-token-renewal.md`) or a trigger turn past its 1 h machine
   token — and failing open would let that turn run unmetered for hours.
6. Limits are soft: the Runtime caches the summary for 60 s and posts usage in
   5 s batches, so concurrent turns in *other* microVMs can overshoot by about a
   minute of usage. Within one process the Runtime subtracts the usage it has
   recorded but the Backend has not acknowledged yet (all recorders of that
   user: turn, sub-agents, title generation, image_to_text) from every summary,
   and recording usage invalidates the cached summary, so a turn that just used
   up the limit refuses the next one.
7. One model call can generate up to the model's maxOutputTokens (up to 128K).
   Once less than that remains of the output limit — and for the grace calls
   after the limit — the Runtime lowers the call's `maxTokens` to
   `max(remaining, 4096)`. When such a capped call ends on `maxTokens`, the
   cut-off answer becomes the turn's final message (with a note) instead of the
   SDK's MaxTokensError, which would fail the turn and drop an answer that was
   already generated and metered. The cap is lifted when the turn ends.

## Rejected alternatives

- **Grant the Runtime execution role `dynamodb:UpdateItem` on the table.**
  Breaks the "no DynamoDB on the execution role" invariant; IAM cannot
  restrict an UpdateItem to `ADD`, so leaked container credentials could reset
  or inflate anyone's usage.
- **Write with the user's Identity Pool credentials (like the sessions table).**
  Even with `dynamodb:LeadingKeys`, Put/Update on their own row lets a user
  set their usage to 0 — from `execute_command`, for instance.
- **A dedicated metering Lambda invoked with IAM.** The caller is not bound to
  a JWT, so leaked credentials could add usage to *other* users and exhaust
  their quota.
- **Strands `InvokeLimits`.** Per request only, and has no input-only cap.
- **Aggregate later from CloudWatch / billing data.** Too late to enforce, and
  not per user.

## Consequences

- Trigger turns that run longer than ~1 h now stop at the first refused usage
  report (their machine token expires). They already could not call the
  Backend or Gateway past that point.
- A report is applied at most once: the Runtime sends a `batchId` that stays
  the same across retries, and the Backend writes a short-lived marker for it
  in the same DynamoDB transaction as the increments. A retry after an
  ambiguous failure (client timeout on a slow cold start, 5xx after a partial
  write) is then a no-op instead of counting the batch again. Dropped batches
  are logged as `usage_record_dropped`.
- Models outside the deployment's `bedrockModels` (plus the `image_to_text`
  vision models) are metered into a single `other` row, so arbitrary
  `modelId`s cannot grow the table. `/invocations` and `call_agent` also reject
  model ids outside the deployment.
- Usage the Runtime has recorded but the Backend has not acknowledged is kept
  per user *and model*, since limits are per model.
- Near the limit, only a `maxTokens` stop that the Runtime's own cap caused is
  turned into the cut-off answer; a model hitting its own configured ceiling
  far from the limit keeps the usual MaxTokensError.
- `POST /usage/records` is rate-limited per user (per Lambda instance) so a
  flood cannot exhaust Backend concurrency and push everyone into fail-open.
  The cap is generous (600/min) because one user can run many reporters at
  once; a 429 is re-queued by the Runtime, never dropped.
- Trigger turns and workflow steps wait (bounded) for usage still being posted
  before `stopOwnSession` / the step callback: stopping the session kills the
  microVM and any queued usage with it.
- A holder of the machine-user credential can read and add usage for any user.
  That credential can already invoke agents as any user, so nothing is added.
- Group membership changes apply when the user's access token is next issued
  (up to 1 h). `AdminUserGlobalSignOut` forces it sooner.
