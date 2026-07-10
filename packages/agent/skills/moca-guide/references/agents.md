# Agents & sub-agents

Moca is multi-agent. Two capabilities cover the lifecycle: **`manage_agent`**
defines agents; **`call_agent`** delegates work to them at runtime. Both are
opt-in tools — the current agent has them only if they're in its `enabledTools`.

## Creating and managing agents (`manage_agent`)

An "agent" in Moca is a saved configuration: a name, description, system prompt,
and its own set of enabled tools. Created agents are shared organization-wide, so
"make me an agent that…" produces a reusable teammate, not a throwaway.

Actions: `create`, `update`, `get`.

To **create**, you need: `name`, `description`, `systemPrompt`, `enabledTools`.
Optional: `icon` (a Lucide icon name), `scenarios` (an array of `{title, prompt}`
quick-start prompt templates surfaced in the UI).

`enabledTools` is the important field — it decides what the new agent can do. Pick
from Moca's tool set: `execute_command`, `file_editor`, `code_interpreter`,
`browser`, `image_to_text`, `s3_list_files`, `memory_search`, `generate_ui`,
`todo`, `think`, `call_agent`, `manage_agent`, `manage_trigger`, plus gateway
tools like web search, image generation, and video generation when deployed.
Enable only what the agent's job needs.

`update` is a partial update — pass only the fields you want to change. `get`
retrieves a definition by `agentId`.

When a user asks for a capability the *current* agent lacks, the right move is
usually `manage_agent` `update` to add the tool (or create a purpose-built agent),
not to fake the capability.

## Delegating to a sub-agent (`call_agent`)

`call_agent` runs another agent as an independent worker. Use it to bring in a
specialist (a data analyst, a coder, a researcher) for part of a job.

Actions:
- `list_agents` — discover available agents and their `agentId`s. **Call this
  first**; you need a valid `agentId` to start a task.
- `start_task` — launch a sub-agent. Required: `agentId`, `query`. Optional:
  `modelId`, `storagePath` (defaults to the parent's workspace), `sessionId`
  (auto-generated if omitted). Returns a `taskId` immediately.
- `status` — check a task by `taskId`. Set `waitForCompletion=true` to poll until
  done (tune `pollingInterval`, `maxWaitTime`); `false` to check once and move on.

### How sub-agents behave — and the limits

- **Asynchronous.** `start_task` returns a `taskId` right away; the work runs in
  the background. Tasks can take minutes to hours.
  - Short task → `status` with `waitForCompletion=true` and wait for the result.
  - Long task → start it, `waitForCompletion=false`, report the `taskId`, and let
    the user check back (or poll later).
- **No shared history.** Each sub-agent runs in its own session. Pass everything
  it needs in `query`; it cannot see the current conversation.
- **Recursion is capped at depth 2**, and sub-agents cannot themselves call
  `call_agent` — this prevents runaway fan-out.
- **Max 5 concurrent tasks per session.** Beyond that, `start_task` errors. Let
  tasks finish before starting more.
- **Tasks are ephemeral.** Completed/failed task records are cleaned up after ~24h.
  Retrieve results before then.

### Phrasing for the user

- "Have a data-analysis agent look at this CSV" → `list_agents`, then `start_task`
  with the analyst's `agentId` and the CSV path in `query`.
- "Run these three analyses in parallel" → up to 5 `start_task` calls, then poll
  each `taskId`.
