import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgavDir } from "../config/config.js";
import type { WorkflowNodeRun, WorkflowRun } from "./types.js";

export interface WorkflowStoreOptions {
  rootDir?: string;
}

export class WorkflowStore {
  readonly rootDir: string;

  constructor(options: WorkflowStoreOptions = {}) {
    this.rootDir = options.rootDir ?? join(getAgavDir(), "workflow-runs");
  }

  createRunId(): string {
    return `run_${randomUUID().slice(0, 8)}`;
  }

  runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  nodePath(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "nodes", `${safeNodeId(nodeId)}.json`);
  }

  logPath(runId: string, nodeId: string): string {
    return join(this.runDir(runId), "logs", `${safeNodeId(nodeId)}.log`);
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    await writeJsonAtomic(join(this.runDir(run.id), "run.json"), run);
  }

  async loadRun(runId: string): Promise<WorkflowRun | null> {
    return readJson<WorkflowRun>(join(this.runDir(runId), "run.json"));
  }

  async saveNode(runId: string, node: WorkflowNodeRun): Promise<void> {
    await writeJsonAtomic(this.nodePath(runId, node.id), node);
  }

  async loadNode(runId: string, nodeId: string): Promise<WorkflowNodeRun | null> {
    return readJson<WorkflowNodeRun>(this.nodePath(runId, nodeId));
  }

  async loadNodes(runId: string): Promise<Record<string, WorkflowNodeRun>> {
    const dir = join(this.runDir(runId), "nodes");
    if (!existsSync(dir)) return {};
    const out: Record<string, WorkflowNodeRun> = {};
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".json")) continue;
      const node = await readJson<WorkflowNodeRun>(join(dir, entry));
      if (node) out[node.id] = node;
    }
    return out;
  }

  async appendLog(runId: string, nodeId: string, line: string): Promise<void> {
    const path = this.logPath(runId, nodeId);
    await mkdir(dirname(path), { recursive: true });
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, existing + line + "\n");
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
