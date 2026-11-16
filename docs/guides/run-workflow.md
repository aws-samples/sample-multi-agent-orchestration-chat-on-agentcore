# run_workflow: Long-Running Multi-Agent Workflows

`run_workflow` lets an agent hand a multi-step plan to specialist agents and get the result back later — minutes or hours later. Steps run in parallel when they are independent and in sequence when one needs another's output; a reviewer can send a step back for revision, and a step can ask for an upstream step to be redone.

This guide explains how it works and why it is built this way: the architecture, how Lambda durable functions keep the workflow's state, why Lambda's 15-minute limit does not bound a workflow, and how failures, cancellation and limits are handled. The design decisions and rejected alternatives are recorded in [ADR: multi-agent workflow orchestration](../adr/multi-agent-workflow-orchestration.md).

- [1. What a workflow looks like](#1-what-a-workflow-looks-like)
- [2. Why the workflow does not run inside the agent](#2-why-the-workflow-does-not-run-inside-the-agent)
- [3. Architecture](#3-architecture)
- [4. Lambda durable functions in one page](#4-lambda-durable-functions-in-one-page)
- [5. What the durable execution stores](#5-what-the-durable-execution-stores)
- [6. The execution over time](#6-the-execution-over-time)
- [7. Why the 15-minute Lambda limit does not bound a workflow](#7-why-the-15-minute-lambda-limit-does-not-bound-a-workflow)
- [8. The step contract between orchestrator and Runtime](#8-the-step-contract-between-orchestrator-and-runtime)
- [9. Failures, cancellation and limits](#9-failures-cancellation-and-limits)
- [10. Stored data](#10-stored-data)
- [11. Testing and regenerating the diagrams](#11-testing-and-regenerating-the-diagrams)

## 1. What a workflow looks like

The calling agent composes the workflow at run time and passes it to the tool:

```jsonc
{
  "action": "start",
  "workflow": {
    "goal": "Compare cloud providers",
    "steps": [
      { "id": "research_aws",   "agentId": "<id>", "prompt": "Research AWS" },
      { "id": "research_azure", "agentId": "<id>", "prompt": "Research Azure" },
      { "id": "report", "agentId": "<id>",
        "dependsOn": ["research_aws", "research_azure"],
        "prompt": "Write a comparison using {{research_aws.output}} and {{research_azure.output}}",
        "review": { "agentId": "<id>", "criteria": "Every number cites a source", "maxIterations": 2 } }
    ]
  }
}
```

The tool returns a `workflowId` immediately, and the calling agent ends its turn. When the workflow finishes, the orchestrator starts a new turn in the same chat session with the results (`notifyOnComplete`, default `true`). The other actions are `status`, `list` and `cancel`.

In the chat UI, the `start` input renders as a left-to-right graph of the steps, and a toggle switches to the raw JSON.

## 2. Why the workflow does not run inside the agent

`call_agent` runs sub-agents inside the caller's process, on the same AgentCore microVM. That cannot carry a workflow that lasts hours:

| Constraint | Effect on an in-process workflow |
|---|---|
| The user's Cognito tokens live 1 h and are renewed only while a browser keeps the turn open | S3, Memory and Backend calls start failing after 1–2 h |
| `/ping` reports `HealthyBusy` only while a turn is running | Background work left after the parent turn ends is killed by the idle timeout |
| One microVM (8 h maximum lifetime) with shared CPU and memory | Every parallel step competes for the same machine; in-memory state is lost when the microVM ends |

So the workflow runs outside the agent: a Lambda durable function orchestrates, and every step runs in its own Runtime session.

## 3. Architecture

![run_workflow architecture](../workflow-architecture.drawio.png)

1. **Start** — The parent agent's `run_workflow` tool calls `POST /workflows` on the Backend. The Backend validates the spec, takes `userId` from the verified JWT, writes the workflow record, and invokes the orchestrator asynchronously with `DurableExecutionName = workflowId`. A retried request therefore never starts the workflow twice. The Runtime never starts executions itself: that would let it assert a `userId` to a component that mints tokens for that user.
2. **Orchestrate** — The orchestrator (`packages/trigger/src/workflow`) runs the steps in *waves*: every step whose dependencies are done runs in parallel (`context.map`), then the results are applied (done / failed / revise / escalate) before the next wave.
3. **Run a step** — For each agent turn, the orchestrator mints a machine-user token and a developer-auth OpenID token for the user, then calls the Runtime with `workflowStep: { workflowId, stepId, role, callbackId }`. The step runs in its own session (`subagent` type, one microVM per step), so it is not limited by the browser's 1-hour tokens or by the parent's microVM.
4. **Report back** — When the turn ends, the Runtime completes the durable callback with the step's result. While the turn runs, it sends a heartbeat every 5 minutes.
5. **Finish** — The orchestrator writes the summary to the workflow record and starts a turn in the parent session to report the results.

## 4. Lambda durable functions in one page

A durable function is ordinary TypeScript code (`withDurableExecution(handler)`) whose calls to `context.step`, `context.map`, `context.wait` and `context.waitForCallback` are **checkpointed**:

- **Every operation's result is recorded.** When the function runs again, an operation that already completed returns its recorded result immediately instead of executing again.
- **The function runs again from the top every time it resumes** (*replay*). There is no long-running process. Each time something it waits for completes (a callback, a timer), the service starts a new invocation, and the handler re-executes from the beginning; recorded operations return their results instantly until the code reaches the first operation that has not completed yet.
- **Waiting suspends the execution.** When the code reaches a callback or timer that has not completed, the invocation ends. Nothing runs, and nothing is billed, until the callback arrives.

Two rules follow, and the orchestrator is written around them:

1. **Same calls, same order, on every replay.** Operation ids are derived from the call's position in its context (the real ids `c4ca4238…` and `a87ff679…` are the MD5 hashes of `"1"` and `"4"`). Anything non-deterministic — time, random ids, I/O — must happen *inside* a step, so that its result is recorded. For example, session ids are generated in the `init-sessions` step, and timestamps are taken inside the save steps.
2. **Operation names are unique and stable.** Names encode the step, the run and the round (`headline-r2-review1`), and loops are written as waves, so the control flow is a pure function of earlier results.

## 5. What the durable execution stores

The figures in this section and the next are generated from the recorded history of a real execution on the dev stack, with user content removed. In that run, `headline` reported its input as unusable (`blocked`), `fact` was redone, and `headline` then went through one review revision.

![Durable operation tree](../durable-operation-tree.drawio.png)

The service does **not** store the workflow as a graph. It stores an append-only, tree-shaped log of operations:

| Level | What is stored |
|---|---|
| Execution | Input payload (`{action, workflowId, userId}`), name, ARN, status (RUNNING / SUCCEEDED / FAILED / STOPPED / TIMED_OUT), and a record of every invocation (start and end time) |
| Operation | Id, ParentId, type (`Step`, `Map`, `MapIteration`, `WaitForCallback`, `Callback`, `Wait`), name, Started → Succeeded / Failed, retry attempt and next delay, and the **result payload** (for example: session ids for `init-sessions`; the Runtime's `{status, output, sessionId}` for a callback; the outcomes of every step for a `Map`) |

What it does **not** store is the orchestrator's in-memory state: the per-step status map, the wave counter, the escalation budget. These are rebuilt on every replay from the recorded results.

**Why not draw it like a Step Functions state machine?** A Step Functions DAG is a definition that exists before the run. Here there is no definition: `fact-r2-*` and `headline-r2-review2` exist only because earlier results (`blocked`, `needs_revision`) asked for them. The red notes in the figure mark those operations. The *workflow spec* is a DAG, which is what the chat UI draws; the *execution* is a tree that grows at run time.

The full operation-by-operation picture is in [`durable-operation-tree-raw.drawio`](../durable-operation-tree-raw.drawio). It shows each `WaitForCallback` with its submitter step and `Callback`, and the `MapIteration` frames that the figure above folds away.

## 6. The execution over time

![Durable execution timeline](../durable-timeline.drawio.png)

- **Orange** is code running inside a Lambda invocation: replay, new operations, and starting the turn. **Green** is the agent turn running on AgentCore Runtime while the execution is suspended.
- The 30-second run used **8 invocations**, each lasting 0.2–4.8 s. The first one takes longest, mostly because it waits for the first step turn to start on the Runtime.
- Each invocation replays everything recorded so far (0 → 43 operations) and then runs only a handful of new operations (2–10). Replay costs milliseconds, so invocations stay short even as the history grows.

## 7. Why the 15-minute Lambda limit does not bound a workflow

![Why the 15-minute limit does not bound a workflow](../workflow-timeouts.drawio.png)

There are three different limits, and only one of them applies to Lambda:

| Limit | Value | Applies to |
|---|---|---|
| Lambda timeout per invocation | 5 min (Lambda maximum: 15 min) | One invocation: replay + new operations + starting turns |
| Durable `executionTimeout` | 7 days | The whole workflow, including suspended time |
| Step turn | 8 h (callback timeout; the microVM's maximum lifetime) | One agent turn on the Runtime |

The hours are spent in step turns on the Runtime and in suspension, and neither of them is a running Lambda. An invocation only has to:

1. **Replay** — milliseconds.
2. **Run new operations** — save step states, mint tokens: about a second.
3. **Start the next turns** — `POST /invocations` waits at most **120 s for response headers** and **20 s for the first stream line**. Parallel steps wait concurrently.
4. **Suspend** — return immediately.

The worst case is therefore about 140 s per invocation, well under the 300 s timeout. The 120 s bound on response headers matters. Without it, a hung connection could run an invocation into its Lambda timeout, and because starting a turn runs *at least once*, the retried invocation would start the same turn a second time.

## 8. The step contract between orchestrator and Runtime

| Part | Behaviour |
|---|---|
| Who may run a step | `workflowStep` in the `/invocations` body is honoured only for the machine user. A regular user cannot complete someone else's durable callback |
| `submit_workflow_result` | Injected only into step turns. The agent writes its deliverable as **reply text**, then calls the tool with `status` (`done`, `needs_revision` for reviewers, or `blocked` with `targetStepId`). The reply text becomes the step's output |
| End of turn | The tool ends the turn without another model call (`AfterToolsEvent.endTurn`) |
| Heartbeat | Every 5 min while the turn runs. The orchestrator's heartbeat timeout is 20 min, so a dead microVM is detected within minutes rather than at the 8 h limit |
| Completion | `SendDurableExecutionCallbackSuccess` with `{status, output, feedback?, targetStepId?, sessionId}`, or `…Failure` if the turn errors. The Runtime then asks to stop its own session; that SigV4 call is currently rejected by the JWT-authorized runtime, so the idle timeout releases the microVM |
| Session | Each step keeps one session across review rounds and re-runs, so the agent sees its earlier work |

Two lessons from production shaped this contract:

- **Long tool arguments stall the stream.** Claude buffers a tool's string argument until it is complete. A long report passed *as an argument* streamed nothing for minutes, and the Bedrock client's idle timeout (120 s by default in Strands SDK 1.24) cut every retry with "Stream ended without completing a message". Deliverables are therefore reply text, and `createBedrockModel` raises the idle timeout to 10 minutes for every agent.
- **Empty replies break revisions.** When the model was allowed to reply after the submit tool, it often produced a whitespace-only text block. Bedrock rejects that block when the session's history is replayed in the next revision round, so the tool now ends the turn itself.

## 9. Failures, cancellation and limits

**Failures**

| Case | Handling |
|---|---|
| A turn fails (model error, throttling, heartbeat timeout) | Retried once on the same session after 30 s. A missing agent is not retried |
| Starting a turn fails (HTTP error, timeout) | Up to 3 attempts, 10 s apart |
| A step fails for good | Steps that depend on it are `skipped`; independent branches still finish; the workflow ends `failed` |
| A reviewer never approves | After `maxIterations`, the last output is accepted and marked `unapproved` |
| A step reports `blocked` | The target (an ancestor of the step) is redone with the feedback, then its done dependants re-run. Several escalations to the same target in one wave are merged into one re-run. Escalations are budgeted per workflow |
| The parent session has a turn running | The notification is retried every 60 s, up to 30 times |

**Cancellation.** `POST /workflows/:id/cancel` sets `cancelRequested` on the record and starts a separate durable execution named `<workflowId>-cancel`. That execution stops the main execution (`StopDurableExecution`, matching the name exactly) and the running step sessions (`stopruntimesession` with a Bearer token, because the runtime is JWT-authorized), then marks the open steps and the workflow `cancelled`. The main execution also checks the flag before each wave. Writes are conditional, so a late write cannot turn a cancelled step or workflow back into another state.

**Limits** (`WORKFLOW_LIMITS` in `@moca/tool-definitions`, plus Backend and CDK settings)

| Limit | Value |
|---|---|
| Steps per workflow | 10 |
| Steps running at once | 3 |
| Review rounds per step | 2 by default, 3 at most |
| Escalations per workflow | 3 |
| Prompt length per step | 20,000 characters |
| Whole spec | 100 KB (UTF-8) |
| Step output kept and passed on | 20,000 characters |
| Summary stored and sent to the parent | 60,000 characters |
| Active workflows per user | 3 (records older than 7 days are not counted) |
| Workflow records | Kept 30 days (DynamoDB TTL); durable history kept 14 days |

## 10. Stored data

All workflow state lives in one DynamoDB table (`<prefix>-workflows`), partitioned by user:

| Item | Key | Content |
|---|---|---|
| Header | `PK = USER#<userId>`, `SK = WORKFLOW#<workflowId>` | Spec, parent session, status, `cancelRequested`, summary, timestamps |
| Step | `PK = USER#<userId>`, `SK = WFSTEP#<workflowId>#<stepId>` | Status, runs, round, session ids, output, feedback, error |

Steps are separate items because ten 20,000-character outputs would not fit in DynamoDB's 400 KB item limit next to the spec. Workflow ids are UUIDv7, so `WORKFLOW#…` sorts by creation time and listing returns the newest first.

## 11. Testing and regenerating the diagrams

| Test | What it covers | Command |
|---|---|---|
| `trigger/.../engine.test.ts` | Scheduling logic with fake operations | `npm test -w @moca/trigger` |
| `trigger/.../handler.durable.test.ts` | The handler through the real durable SDK (`LocalDurableTestRunner`): replay, map, callbacks, retries, escalation, cancel, parent notification | `npm test -w @moca/trigger` |
| `trigger/.../store.ddb.integration.test.ts` | Conditional writes against DynamoDB Local (Docker) | `npm run test:ddb -w @moca/trigger` |
| `agent/.../workflow-step.test.ts`, `invocations.workflow-step.test.ts` | The Runtime side: submit tool, end of turn, callbacks | `npm test -w @moca/agent` |
| `backend/.../workflows.quota.test.ts` | Active-workflow quota and concurrent starts | `npm test -w @moca/backend` |

The architecture and timeout figures are drawn by `docs/diagram/build_workflow_architecture.py` and `docs/diagram/build_workflow_timeouts.py`. The operation tree and timeline are generated from a recorded execution history, so they can be redrawn from any run:

```bash
aws lambda get-durable-execution-history --durable-execution-arn <ARN> \
  --include-execution-data > /tmp/history.json
python3 docs/diagram/extract_durable_history.py /tmp/history.json docs/diagram/data/durable-history-sample.json
python3 docs/diagram/build_durable_state.py          # abstracted figures
python3 docs/diagram/build_durable_state.py --raw    # every operation as recorded
```

`extract_durable_history.py` keeps only structure, timestamps, statuses and sizes; prompts, outputs, session ids and ARNs are dropped.
