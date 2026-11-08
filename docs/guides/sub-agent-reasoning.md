# Sub-agent reasoning effort

Pass `reasoningEffort` when starting a task with `call_agent` to choose the
sub-agent's reasoning depth independently of the parent:

```json
{
  "action": "start_task",
  "agentId": "researcher",
  "query": "Compare the deployment options",
  "reasoningEffort": "low"
}
```

Supported values are `off`, `low`, `high`, and `max`. Omit the field to keep the
selected model's default. `off` uses the model-specific off behavior; models
with always-on reasoning may continue reasoning. The model registry caps
effort where necessary, and models without reasoning controls ignore it.

The choice applies to this task only. It does not update the agent definition
or inherit the parent's reasoning setting.
