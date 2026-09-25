# Workflow Runtime Implemented Summary

## Current implementation state

The workflow runtime now supports:

- workflow YAML/JSON loading;
- workflow validation;
- CLI and slash command execution;
- checkpointed run/node state;
- resume from checkpoints;
- approval checkpoint decisions;
- checkpoint/status visibility;
- pending node visibility;
- pause/cancel state;
- retry/rewind checkpoint invalidation;
- dry-run mode;
- eval fixtures;
- attempt history;
- cooperative cancellation hooks;
- node timeout checkpoints;
- conservative retry approval for interrupted mutating/unknown agent and tool nodes;
- basic `retryPolicy.maxAttempts` enforcement;
- idempotency key propagation to A2A workflow agents.

## Node types implemented

| Node type | Status |
| --- | --- |
| `tool` | Implemented |
| `agent` (native + A2A) | Implemented |
| `test` | Implemented |
| `approval` | Implemented |
| `prompt` / `reduce` | Implemented |
| `skill` | Implemented when an executor is supplied |
| `parallel` | Implemented (fan-out/fan-in, bounded concurrency, child checkpoints) |
| `loop` | Implemented (bounded iterations, per-iteration checkpoints, `stopWhen`) |

## Parallel node

A `parallel` node runs its `children` with a bounded concurrency limit and
aggregates child outputs into a single parent checkpoint.

```yaml
- id: inspect_all
  type: parallel
  maxConcurrency: 3
  dependsOn: [seed]
  children:
    - id: inspect_auth
      type: agent
      agent: reviewer
      task: Inspect auth
    - id: inspect_api
      type: agent
      agent: reviewer
      task: Inspect API
```

### Behavior

| Concern | Behavior |
| --- | --- |
| Concurrency | `node.maxConcurrency` → `policies.maxConcurrency` → `4` |
| Child ordering | Children run in dependency order; siblings without deps run together |
| Output | `{ childOutputs: { <childId>: <output> } }` |
| Child failure | Parent fails with the failing child statuses and errors |
| Approval children | Parent becomes `waiting_approval` and lists awaiting children |
| Cancellation | Signal is checked between child batches |
| Checkpoints | Every child writes its own checkpoint and attempt history |
| Resume | Children already `passed`/`skipped` are not re-executed |

### Scoping rules

- Nested children are owned by their parent `parallel` node and are **not**
  scheduled as independent run-level nodes.
- A child may depend on a sibling child or on a top-level node.
- A child may **not** depend on a node scoped inside another `parallel` or
  `loop` node; the validator rejects this with an explicit issue.

## Loop node

A `loop` node repeats its `body` up to a bounded number of iterations and
stops early when a body node reaches the configured `stopWhen` status.

```yaml
- id: fix_until_green
  type: loop
  maxIterations: 3
  stopOnFailure: false
  stopWhen:
    node: run_tests
    status: passed
  body:
    - id: run_tests
      type: test
      assertions:
        - type: command
          command: pnpm test
    - id: fix
      type: agent
      agent: coding_agent
      task: Fix the failures
```

### Behavior

| Concern | Behavior |
| --- | --- |
| Iteration bound | `node.maxIterations` → `policies.maxIterations` → `3` |
| Early exit | Stops when `stopWhen.node` reaches `stopWhen.status` (default `passed`) |
| Exhaustion | Fails when the bound is reached without satisfying `stopWhen` |
| Failure policy | `stopOnFailure: true` (default) fails fast; `false` continues to the next iteration |
| Output | `{ iterations, completedIterations, stoppedEarly, exhausted }` |
| Cancellation | Signal checked before each iteration |

### Per-iteration checkpoint identity

Each body node runs under an iteration-scoped id (`<nodeId>#<iteration>`), so
every iteration gets its own checkpoint and attempt history:

```text
nodes/check#1.json
nodes/check#2.json
nodes/check#1.attempts/1.json
```

This is what makes loop resume correct: on resume the loop replays from
iteration 1 but reuses any existing terminal checkpoint for that exact
iteration, so completed iterations are never re-executed.

A `failed` body checkpoint from an earlier pass is still a real result and is
reused. Only a `running` (interrupted) checkpoint is re-executed.

### Scoping rules

- Body nodes are owned by the loop and are not scheduled as run-level nodes.
- A body node may depend on another body node or a top-level node.
- `stopWhen.node` must name a body node; the validator rejects it otherwise.
- `maxIterations` must be a positive integer.

## Dry-run mode

### Commands

```bash
agav workflows dry-run <workflow> [--input inputs.json]
```

```text
/workflows dry-run <workflow>
```

### Runtime API

```ts
runWorkflow(definition, inputs, deps, { dryRun: true })
```

### Behavior

| Node type | Dry-run behavior |
| --- | --- |
| `agent` | Skipped by default unless mocked. |
| `tool` | Runs only for known safe/read-only tools; mutating/unknown tools are skipped. |
| `approval` | Uses synthetic approval and passes. |
| `prompt` / `reduce` | Skipped unless `allowModelCalls` is true. |
| `skill` | Skipped by default unless mocked. |
| `test` | Runs structural assertions; command assertions are skipped unless `allowCommands` is true. |

Skipped nodes are checkpointed as:

```json
{
  "status": "skipped",
  "dryRun": true,
  "output": {
    "dryRun": true,
    "skipped": true,
    "reason": "...",
    "plannedAction": "..."
  }
}
```

## Eval support

### Eval directory layout

```text
.agav/workflows/my-flow.yaml
.agav/workflows/my-flow.evals/
  happy-path.json
  approval-required.json
```

### Commands

```bash
agav workflows test <workflow>
agav workflows test <workflow> --eval happy-path
```

```text
/workflows test <workflow>
```

### APIs

```ts
loadWorkflowEvals(workflowPath)
runWorkflowEval(workflow, fixture, deps)
runWorkflowEvals(workflow, fixtures, deps)
```

### Expectations supported

- final run status;
- node statuses;
- node output contains text;
- node output matches regex.

## Attempt history

Each terminal node checkpoint is stored both as latest state and as immutable attempt history.

```text
~/.agav/workflow-runs/<run-id>/
  nodes/<node-id>.json
  nodes/<node-id>.attempts/
    1.json
    2.json
```

### APIs

```ts
store.saveNodeAttempt(runId, node)
store.listNodeAttempts(runId, nodeId)
store.nextNodeAttempt(runId, nodeId)
```

### Commands

```bash
agav workflows attempts <run-id> <node-id>
```

```text
/workflows attempts <run-id> <node-id>
```

Retries increment attempts instead of overwriting the only historical record.

## Cooperative cancellation and timeouts

### Runtime options

```ts
runWorkflow(definition, inputs, deps, { signal })
resumeWorkflow(runId, deps, { signal })
```

### Current behavior

- If aborted before workflow execution, run is marked `paused`.
- If aborted between scheduling loops, run is marked `paused`.
- If aborted before a node starts, node is marked `cancelled`.
- Test nodes check cancellation between assertions.
- Prompt/reduce nodes pass the signal into `runAgentLoop()`.
- Agent nodes pass signal through `AgentExecutionOptions` for future executor-level support.
- Node timeout creates a `timed_out` checkpoint.

### Remaining cancellation limitation

Cancellation is cooperative. If an underlying tool or external agent ignores cancellation, the runtime can checkpoint timeout/cancel state but cannot forcibly stop that underlying operation yet.

## Retry and idempotency safeguards

Implemented safeguards:

- interrupted `agent` and `tool` nodes require retry approval by default;
- `retrySafe: true` or `retryPolicy.retryRunningAfterCrash: true` allows automatic retry;
- `retryPolicy.retryRunningAfterCrash: false` and `retryPolicy.requireApprovalBeforeRetry: true` force approval;
- `retryPolicy.maxAttempts` is enforced before execution;
- workflow-generated idempotency key defaults to `${run.id}:${node.id}`;
- explicit `idempotencyKey` on the node overrides the default;
- idempotency key is passed to A2A agents in the invocation context.

Remaining retry/idempotency work:

- native agent tools do not yet receive idempotency metadata directly;
- no exponential backoff policy yet;
- no per-tool mutability inference beyond tool schema and node type defaults;
- no CLI command yet for `resume --approve-retry` in slash help text beyond supported option handling.

## Tests added

| Test file | Coverage |
| --- | --- |
| `source/__tests__/workflows.parallel.test.ts` | Parallel fan-out, ordering, aggregation, failure, approval, resume, scoping validation, attempts. |
| `source/__tests__/workflows.loop.test.ts` | Loop early exit, ordering, per-iteration aggregation, exhaustion, fail-fast, scoped checkpoints, resume, validation. |
| `source/__tests__/workflows.dry-run-evals.test.ts` | Dry-run skipping, safe tool behavior, mocks, eval fixture loading/running. |
| `source/__tests__/workflows.attempts-cancellation.test.ts` | Attempt history, retry attempt increments, timeout checkpoint, pre-abort pause. |
| `source/__tests__/workflows.loader.test.ts` | Workflow YAML/JSON loading/listing. |
| `source/__tests__/workflows.control.test.ts` | Run control, approval decisions, pending nodes, retry invalidation. |
| `source/__tests__/commands.workflows.test.ts` | Slash command checkpoint formatting. |
| `source/__tests__/workflows.runtime.test.ts` | Core runtime execution/resume. |

## Verification

Clean verification commands:

```bash
pnpm exec tsc --noEmit
```

```bash
pnpm vitest run source/__tests__/workflows.attempts-cancellation.test.ts source/__tests__/workflows.dry-run-evals.test.ts source/__tests__/workflows.runtime.test.ts source/__tests__/workflows.control.test.ts source/__tests__/workflows.loader.test.ts source/__tests__/commands.workflows.test.ts
```

## Recommended next two enhancements

### 1. Observability and metrics dashboard

Next highest value because dry-runs, evals, attempts, and checkpointed runs now produce operational data.

Add:

- attempt counts in run summaries;
- node durations;
- token usage totals;
- dry-run/mocked markers;
- recent logs in status output;
- richer `/workflows status`;
- eventually `/ops` or `/runs` dashboard.

### 2. Configurable retry/backoff/idempotency enforcement

Next safety-critical enhancement before EziSign or scheduled mutating workflows.

Enforce:

- `retryPolicy.maxAttempts`;
- `retryPolicy.retryRunningAfterCrash`;
- `retryPolicy.requireApprovalBeforeRetry`;
- `retrySafe`;
- `idempotencyKey`;
- conservative defaults for mutating tools and external agents.

This should happen before workflow scheduling or real business integrations.
