# Message Goals (per-message refinement)

## Overview

A **message goal** is a natural-language quality bar you attach to a single chat
message — e.g. "answer in at most 3 sentences", "include a runnable code
example", "respond only in formal Japanese". When a message carries a goal, the
agent runs Strands' `GoalLoop`: after producing a response it asks a **judge
model** whether the goal is met, and if not, feeds the judge's feedback back in
and tries again — up to a fixed limit.

Goals are **per-message**: a goal you set applies to exactly the next message you
send and is cleared automatically afterward. It does not persist on the agent or
across sessions.

## Using it

1. In the chat input, click the **target (🎯) button** just left of the send
   button. It turns accent-colored with a dot when a goal is active.
2. In the modal:
   - **Goal** — describe what a good answer must satisfy.
   - **Judge model** — the model that grades the response. Leave it on
     **"Default (server setting)"** to use the server's configured judge model,
     or pick a specific model.
3. Click **Set**, then send your message as usual.
4. When the turn finishes, if the agent refined more than once you'll see a small
   **"Goal met / not met after N attempts"** note under the response.

Use **Clear** in the modal to drop the goal without sending.

## Bounds

Each goal turn is bounded so it can't run away:

- **Max attempts:** 3
- **Timeout:** 120 seconds (checked between attempts)

If neither is reached, the loop stops as soon as the judge decides the goal is
met. If the limit is hit first, you get the best attempt so far with a "not met"
note.

## Judge model configuration (`GOAL_JUDGE_MODEL_ID`)

The default judge model is set by the `GOAL_JUDGE_MODEL_ID` environment variable
on the **agent** (Runtime container). It defaults to a fast, low-cost Haiku-class
model:

```
GOAL_JUDGE_MODEL_ID=global.anthropic.claude-haiku-4-5
```

Notes:

- The value must be a model id present in `@moca/core`'s
  `BEDROCK_MODEL_DEFINITIONS` (and mirrored in the CDK `bedrockModels` config so
  its IAM permission is granted). See `.claude/skills/add-bedrock-model` /
  `packages/libs/core/src/bedrock-models.ts` when adding a model.
- Users can override the judge per-message from the modal. An unknown or absent
  per-message value falls back to `GOAL_JUDGE_MODEL_ID`.
- Judging is a cheap, frequent structured-output call, so a small fast model is
  the recommended default.

## Cost note

A goal turn issues one extra judge call per attempt (plus the refinement
re-runs). With the default 3-attempt cap that is at most 3 judge calls and 3
agent responses for one message. Keeping the judge on a Haiku-class model keeps
this inexpensive.
