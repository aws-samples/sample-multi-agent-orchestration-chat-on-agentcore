---
name: add-bedrock-model
description: How to add, remove, or modify a Bedrock model in the Moca app. Covers the SSoT in @moca/core, the decision tree (standard Converse model vs region-pinned vs new non-Converse endpoint), the files each case touches, the non-obvious pitfalls (region/IAM sync, reasoning effort caps, maxOutputTokens hard limits, data-retention prerequisites), and how to verify.
---

# Adding a Bedrock Model

The canonical model list is `packages/libs/core/src/bedrock-models.ts` —
`BEDROCK_MODEL_DEFINITIONS`. It is the **Single Source of Truth**. Every consumer
(frontend selector, agent model factory, CDK config + IAM) derives its list from
this array. **Do not** hand-maintain a second copy anywhere.

Read that file first — its JSDoc is authoritative and kept in sync with the code.
This skill is the *decision tree and pitfalls* layer on top of it.

## Step 0 — Classify what you're adding (do this first)

Most additions are Case A and touch **one file**. Do not over-engineer.

```
Is the model invoked through the standard Bedrock Converse API?
├─ YES → Is it available in the deployment region (BEDROCK_REGION)?
│        ├─ YES → CASE A: standard model. One edit to bedrock-models.ts. Done.
│        └─ NO  → CASE B: add `region` pin. Still only bedrock-models.ts,
│                 but read the region/IAM note below.
└─ NO (OpenAI-compatible / other transport) →
         ├─ It uses an EXISTING endpoint ('bedrock-openai' or 'mantle')?
         │  → CASE C1: add `endpoint` to the entry. Still only bedrock-models.ts.
         └─ It needs a BRAND-NEW transport (new base URL / API shape / IAM)?
            → CASE C2: multi-file change. See "Case C2" below.
```

"Converse or not?" is a property of the model on Bedrock, not a choice. Anthropic,
Amazon Nova, and Qwen models today use Converse. OpenAI models (gpt-5.x, gpt-oss)
do **not** — they use OpenAI-compatible endpoints. If unsure, check the AWS
Bedrock model card / API reference for the model.

---

## Case A — Standard Converse model (the common case)

Add one entry to `BEDROCK_MODEL_DEFINITIONS`, ordered by preference (newest/most
capable first — order drives the default UI selection). Fields:

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✅ | Full model id **including** the cross-region inference-profile prefix (`global.` / `us.` / `eu.` / `apac.` / `jp.`) if the model has one. Bare id (no prefix) for In-Region-only models. Copy it exactly from the AWS Bedrock console / `get-foundation-model` — a typo fails the live integration test, not silently in prod. |
| `name` | ✅ | UI display name, e.g. `Claude Opus 4.8`. |
| `provider` | ✅ | One of `PROVIDERS` (`Anthropic` / `Amazon` / `Qwen` / `OpenAI`). Adding a new provider is a one-line change to `PROVIDERS` in the same file. |
| `maxOutputTokens` | ✅ | See the **maxOutputTokens** pitfall below — do NOT trust the marketing number. |
| `reasoningCapable` | optional | `true` only for extended-thinking models. Omit for others (Nova, Qwen, gpt-oss). |
| `reasoningMaxEffort` | optional | Only when `reasoningCapable`. See the **reasoning effort cap** pitfall. |
| `region` | optional | Case B only — see below. |
| `endpoint` | optional | Case C only — see below. |

That's the entire change for Case A. `bin/app.ts` dynamic-imports this list into
CDK (`buildModelCatalog`), the frontend projects it into `FALLBACK_MODELS`, and
the agent reads it at model-creation time. Nothing else to touch.

---

## Case B — Region-pinned model

Set `region` when the model must be invoked in a **specific** region regardless of
`BEDROCK_REGION` — e.g. an In-Region-only model not yet rolled out to the deploy
region (despite the docs), or one whose account prerequisite is only enabled in
certain regions.

Two things follow **automatically** from the `region` value (no manual sync):
- The agent routes this model's calls to `region` (`createBedrockModel` →
  `getModelRegion`).
- CDK scopes the inference-profile IAM ARN to `region` (`deriveBedrockIamResources`
  reads `model.region`), so the pinned invocation is authorized.

⚠️ **The pin must be correct, because both consumers trust it.** A wrong region
here produces an IAM ARN that doesn't match the region the agent invokes in →
`AccessDenied` at invocation time, not synth time. Verify the model actually
resolves in that region before committing (see Verification).

> The *only* place a `region` pin must be repeated by hand is a per-environment
> `bedrockModels` override hardcoded in `packages/cdk/config/environments.ts`
> (that override replaces the whole catalog by design). The default catalog needs
> no sync.

---

## Case C — Non-Converse endpoint (transport)

The `endpoint` field selects a non-Converse *transport* — an endpoint URL + SDK
client + IAM service, independent of the model's vendor. Two exist today (both
verified live):

| `endpoint` | Host / API | IAM | Today |
|-----------|-----------|-----|-------|
| `'bedrock-openai'` | `bedrock-runtime.{region}.amazonaws.com/openai/v1`, OpenAI **Chat Completions** | `bedrock:InvokeModel*` + `bedrock:CallWithBearerToken` | gpt-oss |
| `'mantle'` | `bedrock-mantle.{region}.api.aws/openai/v1`, OpenAI **Responses** API | separate `bedrock-mantle:` service (`CreateInference`/`Get*`/`List*` on `project/*` + `CallWithBearerToken`) | gpt-5.x |

The two APIs are **mutually exclusive** on each host — Mantle rejects Chat
Completions and the runtime host rejects the Responses API. Pick the one the model
actually speaks.

### Case C1 — model on an existing endpoint

Add the entry with `endpoint: 'bedrock-openai'` (or `'mantle'`). One file.
`createBedrockModel` routes off the field into `createBedrockOpenAiModel`, and the
CDK IAM statements are gated by `hasEndpointModel(models, endpoint)` — already
present for both existing endpoints, so adding another model of the same endpoint
needs no IAM change. (If the new model pins a region, follow Case B too.)

### Case C2 — brand-new transport

This is the only multi-file change. You are adding a value to the `BedrockEndpoint`
union, so you must teach every layer about it:

1. **`packages/libs/core/src/bedrock-models.ts`** — add the literal to the
   `BedrockEndpoint` type, document it in the `endpoint` JSDoc, add the model entry.
2. **`packages/agent/src/config/bedrock-openai-model.ts`** — extend
   `resolveEndpoint()` (base URL + `api` mode) and, if the model is a reasoning
   model with the tool-call truncation issue, `responsesParams()`. (See the
   `reasoning.effort: 'none'` note there — it is a correctness fix, not an
   optimization, for gpt-5.x-style models on the Responses API.) If the transport
   is NOT OpenAI-compatible at all, `createBedrockModel` in `bedrock.ts` needs a
   new branch instead.
3. **CDK IAM — BOTH roles** (they must mirror each other):
   - `packages/cdk/lib/constructs/agentcore/agentcore-runtime.ts`
   - `packages/cdk/lib/constructs/api/backend-api.ts`
   Add a `hasEndpointModel(props.bedrockModels, '<new-endpoint>')`-gated policy
   statement with the endpoint's IAM service/actions. Miss one role and you get an
   auth error at runtime for that path only.
4. **`packages/cdk/config/environment-types.ts`** — the `BedrockEndpoint` type
   there is CDK's structural mirror (CDK doesn't import core). Add the literal.
5. Tests — see below.

---

## Pitfalls (learned the hard way — do not skip)

- **`maxOutputTokens` — verify the real ceiling, don't trust docs.** The Bedrock
  runtime enforces hard limits that differ from marketing numbers. Example: current
  Anthropic models cap at exactly `128000`; sending `131072` fails *every* request
  with `ValidationException "exceeds the model limit of 128000"`. Match the value
  the runtime actually accepts (the integration test / a live `ConverseCommand`
  confirms it).

- **Reasoning effort cap (`reasoningMaxEffort`).** `output_config.effort: 'max'` is
  **Opus-tier only**. On non-Opus reasoning models (e.g. Sonnet) Bedrock rejects
  `'max'`, so set `reasoningMaxEffort: 'high'`. The UI hides depths above the cap
  and `getReasoningConfig` clamps the sent effort. Omit for Opus-tier (defaults to
  `'max'`).

- **Reasoning request shape is fixed.** Current Anthropic-on-Bedrock models require
  `{ thinking: { type: 'adaptive' }, output_config: { effort } }` and REJECT the
  legacy `{ thinking: { type: 'enabled', budget_tokens } }`. This lives in
  `ReasoningRequestConfig` — don't reintroduce budget_tokens.

- **Account-level prerequisites (data retention).** Some models (Mythos-class, e.g.
  Fable 5) can only be invoked when the account's Bedrock **Data Retention mode** is
  `provider_data_share` in the invocation region — otherwise *every* request fails
  with `ValidationException: data retention mode 'default' is not available for this
  model`, regardless of the request body. This is an account/region setting, not a
  code fix. Note it in the entry's comment and don't region-pin it into a region
  that lacks the setting.

- **Bare id vs inference-profile prefix drives IAM shape.** A prefixed id
  (`global.*`, `us.*`, …) gets **both** an inference-profile ARN (region-scoped) and
  a foundation-model ARN. A bare In-Region id (e.g. `qwen.*`, `openai.gpt-oss-*`)
  gets **only** the foundation-model ARN. `deriveBedrockIamResources` handles this
  by prefix-matching — just make sure the `id` string is correct.

- **Prompt caching is Anthropic-only.** The SDK `cacheConfig: 'auto'` strategy
  no-ops for non-Anthropic families (Nova, Qwen, OpenAI) — expected, don't try to
  force cachePoints onto them.

---

## Verification

Per project policy, prefer running the repo's own checks over ad-hoc live AWS
calls. In order:

1. **Type + unit tests** (fast, no AWS creds):
   ```bash
   npm run build:ts
   npm run test -w packages/libs/core     # bedrock-models.test.ts — structure/accessor assertions
   npm run test -w packages/frontend      # models.test.ts — fallback projection
   npm run test -w packages/agent         # bedrock.test.ts — model factory routing
   ```
   Add/extend assertions in `packages/libs/core/src/__tests__/bedrock-models.test.ts`
   for the new entry (max tokens, region pin, endpoint, reasoning cap as applicable).

2. **CDK synth + IAM** (Case B/C especially — confirms ARNs/statements resolve):
   ```bash
   npm run test -w packages/cdk           # includes bedrock model validation
   ```

3. **Live integration (opt-in, needs AWS creds with `bedrock:InvokeModel`).** This
   is the executable form of "verify the inference-profile id resolves before
   merging" — a typo'd or not-yet-GA id fails here instead of in production. Use a
   **ReadOnly / least-privilege** role and a region where the models are enabled:
   ```bash
   cd packages/libs/core
   RUN_BEDROCK_MODEL_INTEGRATION=1 BEDROCK_REGION=<region-with-model> \
     npm run test:integration
   ```
   For a new non-Converse endpoint, also run the agent integration tests
   (`packages/agent`, `openai-model.integration.test.ts` and friends) — likewise
   opt-in and creds-gated.

## Removing / modifying a model

Same SSoT: edit or delete the entry in `bedrock-models.ts`. Because everything
derives from it, removal propagates automatically. Watch for a hardcoded default
model id fallback (e.g. `DEFAULT_MODEL_ID` in the frontend `models.ts`) if you
remove what was the first/default entry.
