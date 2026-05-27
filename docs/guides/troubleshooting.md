# Troubleshooting

Common runtime errors observed in the agent and how to interpret them.

## `StreamInterruptedError` — Bedrock streaming connection cut

### Symptom

The frontend shows an error like:

```
[SYSTEM_ERROR] An error occurred. Type: StreamInterruptedError
Details: "Stream ended without completing a message" Request ID: <uuid>
```

CloudWatch Logs contain a structured entry:

```json
{
  "level": 50,
  "requestId": "<uuid>",
  "err": {
    "type": "StreamInterruptedError",
    "message": "Stream ended without completing a message",
    "cause": { "type": "ModelError", "message": "..." }
  },
  "msg": "Agent streaming error:"
}
```

### Cause

The HTTP/2 stream between the agent and the Bedrock data plane was closed
before the model emitted its `messageStop` event. The Strands Agents SDK
detects this and throws `ModelError("Stream ended without completing a
message")`. The agent runtime promotes it to `StreamInterruptedError` to
distinguish recoverable idle-disconnects from genuine model failures
(`MaxTokensError`, validation, throttling, …).

Typical underlying triggers:

- Long-running agentic loops (multi-minute tool sequences) idling the
  HTTP/2 stream past an intermediate proxy / NLB timeout.
- Bedrock service-side connection rotation.
- Transient network blips between the runtime container and the regional
  Bedrock endpoint.

### Mitigation in the runtime

`packages/agent/src/config/bedrock.ts` forwards an explicit
`requestHandler: { requestTimeout, sessionTimeout }` to BedrockModel's
underlying HTTP/2 handler. The default is **15 minutes** (`900_000` ms)
and is tuneable via the `BEDROCK_STREAM_REQUEST_TIMEOUT_MS` environment
variable.

Increase this only if your agentic runs legitimately stream for longer
than 15 minutes; values higher than the AgentCore Runtime's container
execution budget have no effect.

### Frontend behaviour

The `serverErrorEvent` payload now carries:

```json
{
  "type": "serverErrorEvent",
  "error": {
    "message": "Stream ended without completing a message",
    "errorName": "StreamInterruptedError",
    "isRetryable": true,
    "requestId": "<uuid>",
    "savedToHistory": true
  }
}
```

The frontend's Zod schema for `serverErrorEvent` uses `.passthrough()`,
so older clients silently ignore the new fields. New clients can branch
on `isRetryable === true` to surface a "Reconnect" / "Retry" action.

### Observability checklist

When investigating a streaming error in CloudWatch Logs Insights:

```
fields @timestamp, requestId, err.type, err.message, awsMetadata.httpStatusCode
| filter msg = "Agent streaming error:"
| sort @timestamp desc
```

If `err.message` is empty the agent is logging through an outdated key.
This was the root cause of issue #8 — the original `logger.error({ error
}, ...)` form caused pino to JSON-serialise the `Error` instance as a
plain object, dropping the non-enumerable `message` and `stack` fields.
The fix routes errors through the `err` key so `pino.stdSerializers.err`
captures the full diagnostic payload.

## `MaxTokensError`

The Bedrock model hit its `max_tokens` ceiling mid-response. The agent
emits a `[SYSTEM_ERROR]` block containing only the top-level message —
the partial assistant response carried in `cause.partialMessage` is
deliberately stripped to avoid leaking unescaped JSON characters into
session blobs (which previously corrupted AppSync Events parsing).

Adjust `getMaxOutputTokens()` in `@moca/core` for the affected model or
shorten the user prompt / preceding tool output.
