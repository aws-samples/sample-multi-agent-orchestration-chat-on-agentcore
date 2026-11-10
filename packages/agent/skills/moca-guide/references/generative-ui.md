# Generative UI

The `generate_ui` tool renders rich components inside the chat — tables, KPI
cards, and charts — instead of plain text. Opt-in per agent. Reach for it when
structured data would read better as a visual than as prose.

## Components you can render

| Component | Kind | Use it for | Key props |
|---|---|---|---|
| `Stack` | Layout | vertical stack of children | `gap` |
| `Grid` | Layout | responsive grid of children | `cols`, `gap` |
| `DataTable` | Data | tabular data | `columns[]` (headers), `rows[][]` (cells), `caption?` |
| `MetricCard` | KPI | a single metric with trend | `title`, `value`, `description?`, `change?`, `changeType?` (positive/negative/neutral) |
| `BarChart` | Chart | compare across categories | `data[]`, `xKey`, `bars[]` or `yKey`+`color`, `stacked?`, `height?` |
| `LineChart` | Chart | trends over time | `data[]`, `xKey`, `lines[]` or `yKey`+`color`, `height?` |
| `PieChart` | Chart | proportions of a whole | `data[]` (`name`/`value`/`color`), `innerRadius?` (>0 = donut), `showLabels?` |
| `SuggestedReplies` | Interaction | clickable answers to a question you just asked; a click sends the answer as the user's next message | `question?`, `options[]` (`label`, `description?`, `value?`), `multiSelect?`, `allowOther?` (default true) |
| `Questionnaire` | Interaction | several questions at once — one page per question, answers sent together as one message | `title?`, `questions[]` (`question`, `header?`, `options[]`, `multiSelect?`, `allowOther?`) |

## Constraints that trip people up

1. **Only `MetricCard` is interactive.** It supports an `on.press` event (e.g. tab
   switching via `setState`). Putting `on` handlers on `Stack`, `Grid`, `DataTable`,
   or any chart does nothing — they simply won't respond. Design interactivity
   around `MetricCard`. (`SuggestedReplies` handles its own clicks — no `on` needed.)
3. **`SuggestedReplies` / `Questionnaire` must end the turn.** Choices only stay clickable while
   they are in the latest message, so write the question as text, call
   `generate_ui` with `SuggestedReplies` last, and stop.
2. **Never reference data arrays through `$state`.** The streaming layer drops
   `spec.state` when transferring, so a chart's `data` or a table's `rows` must be
   embedded directly in the component's props. Only *scalar* state (e.g. an
   `activeTab` used with `$cond`/`visible`/`setState`) is reliable. Charts/tables
   bound to `$state` data will render empty.

## Two ways to provide the UI

`generate_ui` has a `mode`:

- **`spec`** — you hand it the UI spec directly. Best for small/static UI where you
  already have the data in hand.
- **`code`** — you hand it code that reads data files (CSV, query output) and
  prints the UI spec as JSON to stdout. The code runs in a sandboxed
  CodeInterpreter. Best for data-heavy cases — it avoids pushing large datasets
  through the model. Print **only** the JSON spec to stdout.

The spec is a flat element tree and is validated before rendering.

### Phrasing for the user

- "Show me this as a table" → `DataTable` in `spec` mode.
- "Build a dashboard from this 5k-row CSV" → `code` mode: read the CSV, aggregate,
  emit `MetricCard`s + charts, embed the aggregated arrays directly in props.
