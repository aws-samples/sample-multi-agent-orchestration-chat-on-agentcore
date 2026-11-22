# Monthly token limits

Cap how many tokens each user can spend per model per month. Input and output
have separate limits. The feature is off unless `tokenLimits` is set.

## Configure

In `packages/cdk/config/environments.ts`:

```ts
tokenLimits: {
  timezone: 'Asia/Tokyo', // month boundary; default Asia/Tokyo
  limits: {
    // Users in none of the groups below
    default: { input: 100_000_000, output: 2_000_000 },
    'global.anthropic.claude-opus-5-5': { input: 30_000_000, output: 500_000 },
    'global.amazon.nova-2-lite-v1:0': 'unlimited',
  },
  groups: {
    admin: 'unlimited',
    power: { default: { input: 300_000_000, output: 6_000_000 } },
  },
},
```

- A model missing from a map uses that map's `default`; with no `default`, it is unlimited.
- A user in a configured group gets the group's limits **instead of** `limits`, even when they are stricter.
- A user in several configured groups gets the loosest value per model and per input/output.
- Model ids match regardless of the cross-region prefix (`global.` and `jp.` share one limit).

Deploy as usual. Synth fails on a bad model id, a non-positive or fractional cap, an unknown time zone, or an invalid group name.

## Assign users to groups

Each key under `groups` is created as a Cognito User Pool group. Add a user to a group with:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> --username <username> --group-name power
```

A change applies when the user's access token is next issued, which can take up to 1 hour. To apply it immediately, run `aws cognito-idp admin-user-global-sign-out`.

## Choosing limits

- **Input** counts every prompt token: uncached input plus cache reads and cache writes. In a long conversation most of it is cache reads, so input limits need to be much larger than output limits.
- Usage from sub-agents, triggers, workflow steps, title generation and `image_to_text` counts toward the user who owns the run.
- Limits are soft. Runs that are already in progress can go over by about a minute of usage. The per-turn budget still applies.

## What users see

- **Model menu:** a 残りわずか badge at 80% of a limit, and an 上限到達 badge at 100%. Models at 100% cannot be selected.
- **Settings → 利用状況:** this month's usage and limit for every model.
- **Over the limit:**
  - Sending to a model that is already over its limit is refused before the turn starts, and the user is offered a resend with another model.
  - A turn that reaches the limit is wound down: tools are refused, and the model gives its final answer.
- **Expired sign-in:** if usage can no longer be recorded because the sign-in expired (for example, the tab was closed during a long turn), the turn stops.
