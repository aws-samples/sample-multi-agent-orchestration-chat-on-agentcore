# Scheduled & event-driven runs (triggers)

A **trigger** makes an agent run automatically — on a clock (cron/rate) or when an
external event arrives. The `manage_trigger` tool creates them; it is opt-in per
agent.

## The one rule to state every time

**A newly created trigger is always disabled.** `manage_trigger` cannot enable,
disable, or delete triggers — a human must enable it in the Triggers UI before it
ever fires. Always tell the user this after creating one; otherwise they'll expect
it to run and it won't.

## Creating a schedule trigger (`manage_trigger`)

Action `create`. Required: `name`, `agentId`, `prompt`, and
`scheduleConfig.expression`. Optional: `enabledTools`, `modelId`,
`workingDirectory`, and `scheduleConfig.timezone`.

- `agentId` — which agent runs. Discover valid IDs with `call_agent`'s
  `list_agents` action.
- `prompt` — the instruction the agent receives on each run.
- Find agent IDs via `call_agent` `list_agents` (see `references/agents.md`).

### Schedule expression format (Amazon EventBridge)

Cron uses **6 fields**: `minute hour day-of-month month day-of-week year`.

| Expression | Meaning |
|---|---|
| `0 0 * * ? *` | every day at 00:00 |
| `0 9 * * ? *` | every day at 09:00 |
| `0 8 ? * MON-FRI *` | weekdays at 08:00 |
| `rate(1 hour)` | hourly |

- Set `scheduleConfig.timezone` (IANA, e.g. `"Asia/Tokyo"`); it **defaults to UTC**,
  so ask/confirm the zone when the user says a local time like "9 AM".
- **Minimum interval is 10 minutes.** Don't promise anything finer.

## Event-driven triggers

Beyond schedules, Moca can run an agent when an external EventBridge event arrives
(e.g. an S3 upload, a GitHub PR, a Slack event): the platform matches the event to
enabled subscribed triggers and invokes the agent with the event payload. Note
that `manage_trigger`'s `create` action itself provisions **schedule** triggers;
event-subscription triggers are configured through the platform rather than by this
tool. If a user wants "run when X happens", explain that this is supported and
point them to trigger configuration in the UI.

## What a triggered run looks like

Triggered runs are fire-and-forget `event` sessions: the agent runs, produces its
output, and its microVM is stopped immediately afterward to save cost (unlike
interactive chats, which stay warm for follow-ups). So a trigger should do a
self-contained job — write a file to the workspace, post a result — not wait for a
reply.

### Phrasing for the user

- "Every morning at 9, summarize yesterday's data" → `manage_trigger` `create`
  with `0 9 * * ? *`, `timezone: "Asia/Tokyo"`, then **remind them to enable it**.
