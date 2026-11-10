# Multi-agent workflow orchestration (`run_workflow`)

## Context

`run_workflow` runs a DAG of agent steps (parallel when independent, sequential
via `dependsOn`), with optional reviewer loops and downstream→upstream
escalation. Workflows are expected to run for more than an hour.

`call_agent` sub-agents run inside the caller's process (same microVM). That
cannot carry a multi-hour workflow:

- User tokens live 1 h and are only renewed while a browser keeps the turn open
  (`long-turn-token-renewal.md`).
- `/ping` reports `HealthyBusy` only for in-flight turns, so background work
  left after the parent turn ends is killed by the idle timeout.
- One microVM (8 h cap, shared CPU/memory) would host every parallel step, and
  in-memory state is lost with it.

## Decision

1. **Orchestrator = Lambda durable function** (`packages/trigger/src/workflow`),
   one execution per workflow (execution name = `workflowId`). Each step turn is
   started on the Runtime and the execution suspends on a durable callback, so
   waiting costs no compute and is not bounded by Lambda's 15 min limit.
2. **Each step runs in its own Runtime session** (`sessionType: 'subagent'`),
   invoked like a trigger: machine-user access token + developer-auth OpenID
   token minted per turn. No step depends on the browser's tokens; the only
   remaining bound is 8 h per single step turn.
3. **The Runtime completes the callback.** `workflowStep` in the
   `/invocations` body (honoured for machine users only) makes the Runtime
   inject `submit_workflow_result`, heartbeat the callback every 5 min (the
   orchestrator's heartbeat timeout of 20 min detects a dead microVM), and send
   success/failure when the turn ends.
4. **The Backend owns start/cancel** (`/workflows`). It binds `userId` from the
   verified JWT and is the only caller that starts executions; the orchestrator
   acts solely for the stored `userId`.
5. **Waves, not a ready-queue.** All ready steps run as one `context.map`, then
   outcomes are applied. Control flow is a pure function of prior operation
   results (required by durable replay) and escalation is a state reset
   between waves.
6. **The deliverable is the reply text; `submit_workflow_result` carries only
   the status.** Claude buffers a tool's string argument until it is complete,
   so a long report passed as an argument streamed nothing for minutes and the
   Bedrock client's idle timeout cut every retry ("Stream ended without
   completing a message"). The client idle timeout is also raised from the
   SDK's 120 s to 10 min (`createBedrockModel`).
7. **The submit tool ends the turn** via `AfterToolsEvent.endTurn`. Letting the
   model reply after the tool produced whitespace-only text blocks that, when a
   revision re-used the session, made Bedrock reject the replayed history.

## Rejected alternatives

- **In-process orchestration (extend `call_agent`).** Fails all three
  constraints in Context.
- **Strands `Graph`.** AND-semantics dependency resolution and in-process
  agent nodes; cycles for review/escalation are awkward, and nodes would still
  need our own Runtime invocation and credentials.
- **Step Functions.** A spec composed by the model at run time would need a
  generic ASL interpreter; durable functions express the DAG/loops directly in
  TypeScript.
- **Runtime starts the execution (`lambda:InvokeFunction` from the Runtime).**
  The Runtime would assert `userId` to a component that mints developer-auth
  tokens for it — the privilege `long-turn-token-renewal.md` keeps out of the
  Runtime path.
- **Orchestrator polls DynamoDB/Memory for step completion.** Needs the
  user-scoped history to read results and a polling cadence; the callback
  carries the result and suspends for free.

## Consequences

- The Runtime execution role can complete any callback of the orchestrator
  function (`lambda:SendDurableExecutionCallback*`). Callback ids are
  unguessable; a forged result can only affect the caller's own workflow data.
- Workflow state is a header item plus one item per step (outputs would exceed
  DynamoDB's 400 KB item limit otherwise); step outputs are capped at
  `WORKFLOW_LIMITS.MAX_OUTPUT_LENGTH`.
- Completion resumes the parent session with a machine-user turn
  (`notifyOnComplete`, default true); if the user is mid-turn it retries every
  60 s for 30 min.
- Cancel = `cancelRequested` flag (checked before each wave) + a separate
  `<workflowId>-cancel` execution that stops the main execution and the
  running step sessions.
