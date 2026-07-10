# Model selection & reasoning depth

A run's model can be chosen per invocation (`modelId`) and by agents/triggers when
they start work. Extended thinking is controlled separately by reasoning depth.

## Choosing a model

The default is **Claude Opus 4.8** — the strongest general model; a good default
when unsure. The available catalog (deployment-dependent):

| Model | Provider | Extended thinking |
|---|---|---|
| Claude Opus 4.8 (default), 4.7, 4.6 | Anthropic | yes (up to `max`) |
| Claude Fable 5 | Anthropic | yes (up to `max`; needs data-share mode in-region) |
| Claude Sonnet 5, Sonnet 4.6 | Anthropic | yes (capped at `high`) |
| Nova Lite 2 | Amazon | no |
| Qwen3 Coder Next | Qwen | no |
| GPT-5.5 / GPT-5.4 | OpenAI | no |
| GPT-OSS 120B / 20B | OpenAI | no |

Rough guidance: hardest reasoning/agentic work → an Opus or Fable model; fast/cheap
or high-volume → Sonnet or Nova Lite; the others for specific needs. Don't promise
a model the deployment hasn't enabled.

## Reasoning depth (extended thinking)

Depth is one of `off`, `low`, `high`, `max`, and only applies to
reasoning-capable models (the "yes" rows above). Deeper = more internal
deliberation before answering — better on hard, multi-step problems, at higher
latency and cost.

- `off` — no extended thinking; fastest. Fine for straightforward requests.
- `low` / `high` — increasing deliberation for progressively harder problems.
- `max` — deepest. **Sonnet models cap at `high`** — a `max` request is clamped
  down. Opus/Fable support true `max`.
- On non-capable models the setting is ignored entirely.

Match depth to difficulty: don't burn `max` on a lookup, don't run a thorny
analysis at `off`.
