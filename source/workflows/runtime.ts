import { Ajv } from "ajv";
import type { AgentDefinition } from "../agents/types.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop, type ConfirmResult } from "../agent/loop.js";
import type { AgavConfig, EffortLevel, PermissionMode } from "../config/config.js";
import type { LLMProvider } from "../providers/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/types.js";
import { hashValue } from "./hash.js";
import { interpolateString, interpolateValue } from "./interpolate.js";
import { WorkflowStore } from "./store.js";
import type {
  WorkflowAgentNode,
  WorkflowApprovalDecision,
  WorkflowApprovalNode,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeRun,
  WorkflowNodeStatus,
  WorkflowPromptNode,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowSkillNode,
  WorkflowTestNode,
  WorkflowToolNode,
} from "./types.js";
import { flattenNodes, validateWorkflow } from "./validator.js";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_ITERATIONS = 3;

const ajv = new Ajv({ allErrors: true, strict: false });

export interface AgentExecutionOptions {
  model?: string;
  effort?: EffortLevel;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  sandbox?: string;
}

export interface WorkflowApprovalRequest {
  run: WorkflowRun;
  node: WorkflowApprovalNode;
  prompt: string;
}

export interface WorkflowRuntimeDeps {
  provider: LLMProvider;
  config: AgavConfig;
  toolRegistry: ToolRegistry;
  loadAgent: (name: string) => Promise<AgentDefinition | null>;
  executeAgent: (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>;
  executeSkill?: (skill: string, args: string, options: AgentExecutionOptions) => Promise<string>;
  confirm?: (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalDecision>;
  confirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmResult>;
  store?: WorkflowStore;
  now?: () => Date;
}

export async function runWorkflow(
  definition: WorkflowDefinition,
  inputs: Record<string, unknown>,
  deps: WorkflowRuntimeDeps,
): Promise<WorkflowRun> {
  const store = deps.store ?? new WorkflowStore();
  const resolvedInputs = resolveInputs(definition, inputs);
  const now = isoNow(deps);
  const run: WorkflowRun = {
    id: store.createRunId(),
    workflowName: definition.name,
    workflowVersion: definition.version,
    workflowHash: hashValue(definition),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    inputs: resolvedInputs,
    policies: definition.policies ?? {},
    definition,
    currentNodeIds: [],
    completedNodeIds: [],
    failedNodeIds: [],
    waitingApprovalNodeIds: [],
  };
  await store.saveRun(run);
  return executeWorkflowRun(run, deps, store);
}

export async function resumeWorkflow(runId: string, deps: WorkflowRuntimeDeps): Promise<WorkflowRun> {
  const store = deps.store ?? new WorkflowStore();
  const run = await store.loadRun(runId);
  if (!run) throw new Error(`Workflow run ${runId} not found`);
  return executeWorkflowRun(run, deps, store);
}

async function executeWorkflowRun(
  run: WorkflowRun,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowRun> {
  const validation = await validateWorkflow(run.definition, {
    hasTool: (name) => deps.toolRegistry.list().some((tool) => tool.schema.name === name),
    hasAgent: async (name) => Boolean(await deps.loadAgent(name)),
  });
  if (!validation.ok) {
    return saveRunStatus(run, store, deps, "failed", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
  }

  run.status = "running";
  run.updatedAt = isoNow(deps);
  await store.saveRun(run);

  const allNodes = flattenNodes(run.definition.nodes);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const completedThisRun = new Set<string>();
  const failedThisRun = new Set<string>();
  const waitingThisRun = new Set<string>();
  const skippedThisRun = new Set<string>();

  while (true) {
    const checkpoints = await store.loadNodes(run.id);
    const ready = allNodes.filter((node) => isReady(node, checkpoints, completedThisRun, failedThisRun, skippedThisRun, nodeById, Boolean(deps.confirm)));

    if (ready.length === 0) {
      const latest = await store.loadNodes(run.id);
      const terminal = summarizeTerminalState(allNodes, latest);
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];

      if (terminal.waiting.length > 0) return saveRunStatus(run, store, deps, "waiting_approval");
      if (terminal.failed.length > 0) return saveRunStatus(run, store, deps, "failed");
      return saveRunStatus(run, store, deps, "passed");
    }

    const maxConcurrency = Math.max(1, run.policies.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    const batch = ready.slice(0, maxConcurrency);
    run.currentNodeIds = batch.map((node) => node.id);
    run.updatedAt = isoNow(deps);
    await store.saveRun(run);

    await Promise.all(batch.map(async (node) => {
      const result = await executeNode(run, node, deps, store).catch(async (error: unknown) => {
        const failed = makeNodeRun(node, "failed", deps, { error: error instanceof Error ? error.message : String(error) });
        await store.saveNode(run.id, failed);
        return failed;
      });
      if (result.status === "passed") completedThisRun.add(node.id);
      if (result.status === "failed" || result.status === "timed_out") failedThisRun.add(node.id);
      if (result.status === "waiting_approval") waitingThisRun.add(node.id);
      if (result.status === "skipped") skippedThisRun.add(node.id);
    }));

    if (waitingThisRun.size > 0) {
      const terminal = summarizeTerminalState(allNodes, await store.loadNodes(run.id));
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];
      return saveRunStatus(run, store, deps, "waiting_approval");
    }

    if ((run.policies.stopOnFailure ?? true) && failedThisRun.size > 0) {
      const terminal = summarizeTerminalState(allNodes, await store.loadNodes(run.id));
      run.completedNodeIds = terminal.completed;
      run.failedNodeIds = terminal.failed;
      run.waitingApprovalNodeIds = terminal.waiting;
      run.currentNodeIds = [];
      return saveRunStatus(run, store, deps, "failed");
    }
  }
}

function isReady(
  node: WorkflowNodeDefinition,
  checkpoints: Record<string, WorkflowNodeRun>,
  completedThisRun: Set<string>,
  failedThisRun: Set<string>,
  skippedThisRun: Set<string>,
  nodeById: Map<string, WorkflowNodeDefinition>,
  canResumeApproval: boolean,
): boolean {
  const existing = checkpoints[node.id];
  const hash = hashValue(node);
  if (existing?.status === "passed" && existing.nodeHash === hash) return false;
  if (existing?.status === "waiting_approval") return canResumeApproval && node.type === "approval";
  if (existing?.status === "failed" && existing.nodeHash === hash) return false;
  if (completedThisRun.has(node.id) || failedThisRun.has(node.id) || skippedThisRun.has(node.id)) return false;

  for (const depId of node.dependsOn ?? []) {
    const dep = nodeById.get(depId);
    const depCheckpoint = checkpoints[depId];
    if (depCheckpoint?.status !== "passed") return false;
    if (dep && depCheckpoint.nodeHash !== hashValue(dep)) return false;
  }
  return true;
}

async function executeNode(
  run: WorkflowRun,
  node: WorkflowNodeDefinition,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const started = makeNodeRun(node, "running", deps);
  await store.saveNode(run.id, started);
  await trace(store, run.id, node.id, { type: "node_started", nodeId: node.id, nodeType: node.type });

  let result: WorkflowNodeRun;
  switch (node.type) {
    case "agent":
      result = await executeAgentNode(run, node, deps, store);
      break;
    case "tool":
      result = await executeToolNode(run, node, deps, store);
      break;
    case "test":
      result = await executeTestNode(run, node, deps, store);
      break;
    case "approval":
      result = await executeApprovalNode(run, node, deps, store);
      break;
    case "prompt":
    case "reduce":
      result = await executePromptNode(run, node, deps, store);
      break;
    case "skill":
      result = await executeSkillNode(run, node, deps, store);
      break;
    case "parallel":
    case "loop":
      result = makeNodeRun(node, "failed", deps, { error: `${node.type} nodes are reserved but not implemented in this runtime slice` });
      break;
    default:
      result = makeNodeRun(node, "failed", deps, { error: `Unsupported node type ${(node as WorkflowNodeDefinition).type}` });
  }

  await store.saveNode(run.id, result);
  await trace(store, run.id, node.id, { type: "node_completed", nodeId: node.id, status: result.status });
  return result;
}

async function executeAgentNode(
  run: WorkflowRun,
  node: WorkflowAgentNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const task = interpolateString(node.task, { inputs: run.inputs, nodes: checkpoints });
  const agent = await deps.loadAgent(node.agent);
  if (!agent) return makeNodeRun(node, "failed", deps, { input: task, error: `Unknown agent: ${node.agent}` });

  const output = await deps.executeAgent(agent, task, executionOptions(run, node));
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, { input: task, output, summary: summarizeOutput(output) }));
}

async function executeToolNode(
  run: WorkflowRun,
  node: WorkflowToolNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const input = interpolateValue(node.input ?? {}, { inputs: run.inputs, nodes: checkpoints }) as Record<string, unknown>;
  if (node.sandbox && input["sandbox"] === undefined) input["sandbox"] = node.sandbox;
  const result = await deps.toolRegistry.execute(node.tool, input);
  const output = normalizeToolResult(result);
  const status: WorkflowNodeStatus = result.isError ? "failed" : "passed";
  return withValidatedOutput(node, makeNodeRun(node, status, deps, { input, output, summary: summarizeOutput(output), error: result.isError ? result.output : undefined }));
}

async function executeTestNode(
  run: WorkflowRun,
  node: WorkflowTestNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const failures: string[] = [];

  for (const assertion of node.assertions) {
    if (assertion.type === "output_contains") {
      const value = outputText(checkpoints[assertion.node]?.output);
      if (!value.includes(assertion.value)) failures.push(`${assertion.node} output does not contain ${assertion.value}`);
    } else if (assertion.type === "output_matches") {
      const value = outputText(checkpoints[assertion.node]?.output);
      if (!new RegExp(assertion.pattern).test(value)) failures.push(`${assertion.node} output does not match ${assertion.pattern}`);
    } else if (assertion.type === "json_schema") {
      const valid = ajv.validate(assertion.schema, checkpoints[assertion.node]?.output);
      if (!valid) failures.push(`${assertion.node} output failed schema: ${ajv.errorsText()}`);
    } else if (assertion.type === "tool_result") {
      const dep = checkpoints[assertion.node];
      if (!dep || dep.status !== "passed") failures.push(`${assertion.node} did not pass`);
    } else if (assertion.type === "command") {
      const command = interpolateString(assertion.command, { inputs: run.inputs, nodes: checkpoints });
      const input: Record<string, unknown> = { command };
      const sandbox = assertion.sandbox ?? node.sandbox ?? run.policies.sandbox;
      if (sandbox) input.sandbox = sandbox;
      const result = await deps.toolRegistry.execute("run_command", input);
      if (result.isError) failures.push(`command failed: ${result.output}`);
    } else if (assertion.type === "file_exists") {
      const { existsSync } = await import("node:fs");
      const path = interpolateString(assertion.path, { inputs: run.inputs, nodes: checkpoints });
      if (!existsSync(path)) failures.push(`file does not exist: ${path}`);
    }
  }

  if (failures.length > 0) {
    return makeNodeRun(node, "failed", deps, { input: node.assertions, output: { failures }, summary: failures.join("\n"), error: failures.join("\n") });
  }
  return makeNodeRun(node, "passed", deps, { input: node.assertions, output: { passed: true }, summary: "All assertions passed" });
}

async function executeApprovalNode(
  run: WorkflowRun,
  node: WorkflowApprovalNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const prompt = interpolateString(node.prompt, { inputs: run.inputs, nodes: checkpoints });
  if (!deps.confirm) {
    return makeNodeRun(node, "waiting_approval", deps, { input: prompt, summary: prompt });
  }
  const decision = await deps.confirm({ run, node, prompt });
  const approval = { ...decision, decidedAt: decision.decidedAt ?? isoNow(deps) };
  if (approval.decision === "approved") {
    return makeNodeRun(node, "passed", deps, { input: prompt, output: approval, summary: "Approved", approval });
  }
  return makeNodeRun(node, "failed", deps, { input: prompt, output: approval, summary: "Denied", error: "Approval denied", approval });
}

async function executePromptNode(
  run: WorkflowRun,
  node: WorkflowPromptNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  const checkpoints = await store.loadNodes(run.id);
  const prompt = interpolateString(node.prompt, { inputs: run.inputs, nodes: checkpoints });
  const conversation = new ConversationState();
  conversation.addUserMessage(prompt);
  const registry = filterRegistry(deps.toolRegistry, node.allowedTools);
  let output = "";
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let error: string | undefined;

  for await (const event of runAgentLoop({
    provider: deps.provider,
    conversation,
    toolRegistry: registry,
    model: node.model ?? deps.config.model,
    systemPrompt: deps.config.systemPrompt,
    effort: node.effort ?? deps.config.effort,
    maxTokens: node.maxTokens ?? deps.config.maxTokens,
    confirmTool: deps.confirmTool,
    permissionMode: run.policies.permissionMode ?? deps.config.permissionMode,
    maxIterations: 20,
  })) {
    if (event.type === "streaming_text") output += event.text;
    if (event.type === "assistant_message_complete") output = event.text || output;
    if (event.type === "usage") {
      usage.inputTokens += event.inputTokens;
      usage.outputTokens += event.outputTokens;
      usage.cacheReadTokens += event.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    }
    if (event.type === "error") error = event.error.message;
  }

  const status: WorkflowNodeStatus = error ? "failed" : "passed";
  return withValidatedOutput(node, makeNodeRun(node, status, deps, { input: prompt, output, usage, summary: summarizeOutput(output), error }));
}

async function executeSkillNode(
  run: WorkflowRun,
  node: WorkflowSkillNode,
  deps: WorkflowRuntimeDeps,
  store: WorkflowStore,
): Promise<WorkflowNodeRun> {
  if (!deps.executeSkill) return makeNodeRun(node, "failed", deps, { error: "No skill executor configured" });
  const checkpoints = await store.loadNodes(run.id);
  const args = interpolateString(node.args ?? "", { inputs: run.inputs, nodes: checkpoints });
  const output = await deps.executeSkill(node.skill, args, executionOptions(run, node));
  return withValidatedOutput(node, makeNodeRun(node, "passed", deps, { input: args, output, summary: summarizeOutput(output) }));
}

function makeNodeRun(
  node: WorkflowNodeDefinition,
  status: WorkflowNodeStatus,
  deps: WorkflowRuntimeDeps,
  extra: Partial<WorkflowNodeRun> = {},
): WorkflowNodeRun {
  const now = isoNow(deps);
  return {
    id: node.id,
    type: node.type,
    status,
    attempt: extra.attempt ?? 1,
    nodeHash: hashValue(node),
    startedAt: extra.startedAt ?? now,
    endedAt: status === "running" || status === "waiting_approval" ? undefined : now,
    ...extra,
  };
}

function withValidatedOutput(node: WorkflowNodeDefinition, nodeRun: WorkflowNodeRun): WorkflowNodeRun {
  if (!node.outputSchema || nodeRun.status !== "passed") return nodeRun;
  let output = nodeRun.output;
  if (typeof output === "string") {
    try { output = JSON.parse(output); } catch {}
  }
  const valid = ajv.validate(node.outputSchema, output);
  if (!valid) {
    return {
      ...nodeRun,
      status: "failed",
      output,
      error: `Output schema validation failed: ${ajv.errorsText()}`,
      endedAt: nodeRun.endedAt ?? new Date().toISOString(),
    };
  }
  return { ...nodeRun, output };
}

function resolveInputs(definition: WorkflowDefinition, supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(definition.inputs ?? {})) {
    if (supplied[key] !== undefined) out[key] = supplied[key];
    else if (spec.default !== undefined) out[key] = spec.default;
  }
  return { ...out, ...supplied };
}

function executionOptions(run: WorkflowRun, node: WorkflowNodeDefinition): AgentExecutionOptions {
  return {
    model: node.model,
    effort: node.effort,
    maxTokens: node.maxTokens,
    permissionMode: run.policies.permissionMode,
    sandbox: node.sandbox ?? run.policies.sandbox,
  };
}

function filterRegistry(registry: ToolRegistry, allowed?: string[]): ToolRegistry {
  if (!allowed || allowed.length === 0) return new ToolRegistry();
  const child = new ToolRegistry();
  const allowedSet = new Set(allowed);
  for (const tool of registry.list()) {
    if (allowedSet.has(tool.schema.name)) child.register(tool);
  }
  return child;
}

function normalizeToolResult(result: ToolResult): unknown {
  try {
    return JSON.parse(result.output);
  } catch {
    return result.output;
  }
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

function summarizeOutput(output: unknown): string {
  const text = outputText(output);
  return text.length > 500 ? `${text.slice(0, 500)}\n...(truncated)` : text;
}

function summarizeTerminalState(nodes: WorkflowNodeDefinition[], checkpoints: Record<string, WorkflowNodeRun>) {
  return {
    completed: nodes.filter((node) => checkpoints[node.id]?.status === "passed").map((node) => node.id),
    failed: nodes.filter((node) => checkpoints[node.id]?.status === "failed" || checkpoints[node.id]?.status === "timed_out").map((node) => node.id),
    waiting: nodes.filter((node) => checkpoints[node.id]?.status === "waiting_approval").map((node) => node.id),
  };
}

async function saveRunStatus(
  run: WorkflowRun,
  store: WorkflowStore,
  deps: WorkflowRuntimeDeps,
  status: WorkflowRunStatus,
  error?: string,
): Promise<WorkflowRun> {
  run.status = status;
  run.updatedAt = isoNow(deps);
  if (error) run.error = error;
  await store.saveRun(run);
  return run;
}

async function trace(store: WorkflowStore, runId: string, nodeId: string, event: Record<string, unknown>): Promise<void> {
  await store.appendLog(runId, nodeId, JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

function isoNow(deps: WorkflowRuntimeDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}
