# Reasoning summaries with OpenAI Converse models

For GPT-6 Astra, Sol, and Luna, select `low` or `high` in the model reasoning
selector to request a reasoning summary alongside the answer. A saved `max`
selection is capped at `high` by the application registry. An omitted setting
or `off` sends no reasoning override and keeps the model default; it does not
guarantee that reasoning is disabled.

These models use Bedrock Converse. Their request fields are
`reasoning: { effort, summary: 'auto' }`, rather than Anthropic's
`thinking` and `output_config` fields. GPT-5.x Mantle models retain their
existing configuration.

AWS documents reasoning summaries for Converse and ConverseStream in the
[GPT-6 Astra](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html),
[GPT-6 Sol](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-sol.html), and
[GPT-6 Luna](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html)
model cards. Model access is required in the invoking account.

Load the agent environment described in the [local development guide](local-development-setup.md),
then verify actual summary output using an account with access:

```bash
RUN_BEDROCK_GPT6_INTEGRATION=1 BEDROCK_REGION=us-east-1 \
  npm run test:integration -w @moca/agent -- gpt6-converse -t 'streams a reasoning summary'
```

This opt-in test invokes the three models and incurs inference charges.
