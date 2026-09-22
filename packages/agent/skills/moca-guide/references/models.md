# Model selection & reasoning depth

A run's model can be chosen per invocation (`modelId`) and by agents/triggers when
they start work. Extended thinking is controlled separately by reasoning depth.

## Choosing a model

The default is **Claude Opus 5** — the strongest general model; a good default
when unsure. The available catalog (deployment-dependent):

| Model | Provider | Extended thinking |
|---|---|---|
| Claude Opus 5 (default) | Anthropic | yes (up to `max`) |
| Claude Opus 5.5 | Anthropic | yes (up to `max`; thinking **always on** — `off` = model default `medium`, not suppressed) |
| Claude Opus 4.8, 4.7, 4.6 | Anthropic | yes (up to `max`) |
| Claude Fable 5.1, Fable 5 | Anthropic | yes (up to `max`; needs data-retention mode in-region) |
| Claude Sonnet 5, Sonnet 4.6 | Anthropic | yes (capped at `high`) |
| Nova Lite 2 | Amazon | no |
| Qwen3 Coder Next | Qwen | no |
| GPT-6 Astra | OpenAI | no |
| GPT-5.6 Sol / Terra / Luna | OpenAI | no |
| GPT-5.5 / GPT-5.4 | OpenAI | no |
| GPT-OSS 120B / 20B | OpenAI | no |

Rough guidance: hardest reasoning/agentic work → an Opus or Fable model; fast/cheap
or high-volume → Sonnet or Nova Lite; the others for specific needs. Don't promise
a model the deployment hasn't enabled.

Opus 5.5 is opt-in, not the default. Before production use, confirm its global
inference profile is ACTIVE in the deployment region and verify model-specific
data-retention, consent, and access prerequisites. These prerequisites remain
unverified; an ACTIVE profile alone does not confirm invocation access.
Source: [AWS model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html).

## Reasoning depth (extended thinking)

Depth is one of `off`, `low`, `high`, `max`, and only applies to
reasoning-capable models (the "yes" rows above). Deeper = more internal
deliberation before answering — better on hard, multi-step problems, at higher
latency and cost.

- `off` — sends no thinking or effort hint; model defaults apply. For Opus 5.5,
  thinking remains on at default `medium` effort, including saved `off` values.
  The selector labels this **Model default (always on)**, not **Off**.
  `medium` and `xhigh` are not separately selectable.
- `low` / `high` — increasing deliberation for progressively harder problems.
- `max` — deepest. **Sonnet models cap at `high`** — a `max` request is clamped
  down. Opus/Fable support true `max`.
- On non-capable models the setting is ignored entirely.

Match depth to difficulty: don't burn `max` on a lookup, don't run a thorny
analysis at `off`.
