# Message Goals (per-message refinement)

## Overview

A **message goal** is a natural-language quality bar you attach to a single chat
message — e.g. "answer in at most 3 sentences", "include a runnable code
example", "respond only in formal Japanese". When a message carries a goal, the
agent runs Strands' `GoalLoop`: after producing a response it asks a **judge
model** whether the goal is met, and if not, feeds the judge's feedback back in
and tries again — up to a fixed limit.

Goals are **per-message by default**: a goal you set applies to exactly the next
message you send and is cleared automatically afterward. It does not persist on
the agent or across sessions.

Check **"Keep applying to future messages"** in the goal modal to make the goal
sticky: it is saved in your browser (localStorage — not synced across devices)
and re-attached to every send, including new sessions, until you clear it.
Unchecking the box reverts to per-message behavior — the goal text stays for one
more send, then clears. **Clear** removes the goal and the sticky setting at
once. Remember that every goal-bearing message costs extra judge calls (and up
to the retry limit's worth of refinement re-runs), so leave sticky mode off
unless you want that on every message.

## Using it

1. In the chat input, click the **target (🎯) button** just left of the send
   button. It turns accent-colored with a dot when a goal is active.
2. In the modal:
   - **Goal** — describe what a good answer must satisfy. Write verifiable
     conditions as a numbered list so the judge can grade the answer text
     alone. The examples below the field fill in a ready-made condition
     checklist (document review, evidence & limitations, code change
     checklist) that you can edit.
   - **Judge model** — the model that grades the response. Leave it on
     **"Default (server setting)"** to use the server's configured judge model,
     or pick a specific model.
   - **Retry limit** — how many times the agent may regenerate the answer
     (1–10). Leave it on **"Default (3 attempts)"** unless you want more (or
     fewer) refinement rounds; higher values add latency and judge-call cost.
3. Click **Set**, then send your message as usual. Only **Set** applies your
   edits — closing the modal with ESC, the overlay, or × discards them, so an
   accidentally typed goal never runs.
4. When the turn finishes, if the agent refined more than once you'll see a small
   **"Goal met / not met after N attempts"** note under the response. The note
   is shown in the tab that sent the message; it is not part of the saved
   history, so it disappears on reload.

Use **Clear** in the modal to drop the goal without sending.

While the agent is refining, intermediate attempts and the judge's feedback are
internal — only your message and the final answer are saved to the session
history and shown in other tabs.

## Bounds

Each goal turn is bounded so it can't run away:

- **Max attempts:** 3 by default; adjustable per message from the modal's
  **Retry limit** selector within 1–10 (out-of-range values sent over the wire
  are clamped by the agent).
- **Timeout:** 120 seconds (checked between attempts) — applies regardless of
  the attempt count.

If neither is reached, the loop stops as soon as the judge decides the goal is
met. If the limit is hit first, you get the best attempt so far with a "not met"
note.

## Judge model configuration (`GOAL_JUDGE_MODEL_ID`)

The default judge model is set by the `GOAL_JUDGE_MODEL_ID` environment variable
on the **agent** (Runtime container). It defaults to a fast, low-cost Haiku-class
model:

```
GOAL_JUDGE_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0
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
agent responses for one message; raising the retry limit to 10 raises that
ceiling proportionally. Keeping the judge on a Haiku-class model keeps this
inexpensive.
