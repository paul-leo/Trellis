import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentId } from "../core/types.js";

export type TaskStatus = "pending" | "claimed" | "in_progress" | "blocked" | "completed";

export interface TaskContext {
  workspace?: string;
  commit?: string;
  references?: string[];
  note?: string;
}

export interface TaskHistoryEntry {
  at: string;
  agent: AgentId;
  action: string;
  status: TaskStatus;
  note?: string;
}

export interface TaskRecord {
  id: string;
  objective: string;
  fromAgent: AgentId;
  toAgent?: AgentId;
  status: TaskStatus;
  context?: TaskContext;
  constraints?: string[];
  result?: string;
  claimedBy?: AgentId;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
  history: TaskHistoryEntry[];
}

interface TaskFile {
  tasks: TaskRecord[];
}

const SECRET_LIKE = /(sk-|ghp_|glpat-|mcpr_|token\s*=|password\s*=|secret\s*=|authorization\s*:)/i;

export function taskStorePath(homeDir: string): string {
  return join(homeDir, ".trellis", "tasks", "tasks.json");
}

function readFile(path: string): TaskFile {
  if (!existsSync(path)) return { tasks: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as TaskFile;
    return { tasks: Array.isArray(value.tasks) ? value.tasks : [] };
  } catch {
    throw new Error(`could not parse task store ${path}`);
  }
}

function writeFile(path: string, value: TaskFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function assertSafeText(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (SECRET_LIKE.test(value)) throw new Error(`${label} looks like it contains a credential or secret-like value`);
}

function assertSafeContext(context: TaskContext | undefined): void {
  if (!context) return;
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") assertSafeText(`context.${key}`, value);
    if (Array.isArray(value)) value.forEach((item) => assertSafeText(`context.${key}`, item));
  }
}

function now(): string {
  return new Date().toISOString();
}

function assertAgent(value: unknown, label: string): asserts value is AgentId {
  if (value !== "claude-code" && value !== "codex" && value !== "kiro" && value !== "pi" && value !== "kimi-code") {
    throw new Error(`${label} must be a supported Agent id`);
  }
}

function taskOrThrow(file: TaskFile, id: string): TaskRecord {
  const task = file.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`task "${id}" was not found`);
  return task;
}

function addHistory(task: TaskRecord, agent: AgentId, action: string, status: TaskStatus, note?: string): void {
  task.status = status;
  task.updatedAt = now();
  task.history.push({ at: task.updatedAt, agent, action, status, ...(note ? { note } : {}) });
}

export function listTasks(homeDir: string, filter?: { status?: TaskStatus; toAgent?: AgentId }): TaskRecord[] {
  const tasks = readFile(taskStorePath(homeDir)).tasks;
  return tasks
    .filter((task) => !filter?.status || task.status === filter.status)
    .filter((task) => !filter?.toAgent || task.toAgent === filter.toAgent)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readTask(homeDir: string, id: string): TaskRecord {
  return taskOrThrow(readFile(taskStorePath(homeDir)), id);
}

export function createTask(homeDir: string, input: { objective: string; fromAgent: AgentId; toAgent?: AgentId; context?: TaskContext; constraints?: string[] }): TaskRecord {
  assertSafeText("objective", input.objective);
  assertAgent(input.fromAgent, "fromAgent");
  if (input.toAgent) assertAgent(input.toAgent, "toAgent");
  assertSafeContext(input.context);
  input.constraints?.forEach((value) => assertSafeText("constraint", value));
  const timestamp = now();
  const task: TaskRecord = {
    id: `task-${randomUUID()}`,
    objective: input.objective,
    fromAgent: input.fromAgent,
    ...(input.toAgent ? { toAgent: input.toAgent } : {}),
    status: "pending",
    ...(input.context ? { context: input.context } : {}),
    ...(input.constraints?.length ? { constraints: input.constraints } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [{ at: timestamp, agent: input.fromAgent, action: "created", status: "pending" }],
  };
  const file = readFile(taskStorePath(homeDir));
  file.tasks.push(task);
  writeFile(taskStorePath(homeDir), file);
  return task;
}

export function claimTask(homeDir: string, id: string, agent: AgentId, leaseMs = 30 * 60 * 1000): TaskRecord {
  assertAgent(agent, "agent");
  if (!Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60 * 1000) throw new Error("leaseMs must be between 1000 and 86400000");
  const path = taskStorePath(homeDir);
  const file = readFile(path);
  const task = taskOrThrow(file, id);
  const timestamp = Date.now();
  if (task.leaseUntil && new Date(task.leaseUntil).getTime() <= timestamp) {
    task.claimedBy = undefined;
    task.leaseUntil = undefined;
    if (task.status === "claimed" || task.status === "in_progress") task.status = "pending";
  }
  if (task.status !== "pending" || task.claimedBy) throw new Error(`task "${id}" is already claimed or is not pending`);
  task.claimedBy = agent;
  task.leaseUntil = new Date(timestamp + leaseMs).toISOString();
  addHistory(task, agent, "claimed", "claimed");
  writeFile(path, file);
  return task;
}

export function updateTask(homeDir: string, id: string, agent: AgentId, status: TaskStatus, note?: string, result?: string): TaskRecord {
  assertAgent(agent, "agent");
  if (!["pending", "claimed", "in_progress", "blocked", "completed"].includes(status)) throw new Error(`invalid task status "${status}"`);
  if (note) assertSafeText("note", note);
  if (result) assertSafeText("result", result);
  const path = taskStorePath(homeDir);
  const file = readFile(path);
  const task = taskOrThrow(file, id);
  if (task.claimedBy && task.claimedBy !== agent) throw new Error(`task "${id}" is claimed by another Agent`);
  if (status === "completed" && result) task.result = result;
  addHistory(task, agent, status === "completed" ? "completed" : "updated", status, note);
  if (status === "completed") {
    task.claimedBy = undefined;
    task.leaseUntil = undefined;
  }
  writeFile(path, file);
  return task;
}

export function handoffTask(homeDir: string, id: string, agent: AgentId, toAgent: AgentId, note?: string): TaskRecord {
  assertAgent(agent, "agent");
  assertAgent(toAgent, "toAgent");
  if (note) assertSafeText("note", note);
  const path = taskStorePath(homeDir);
  const file = readFile(path);
  const task = taskOrThrow(file, id);
  if (task.claimedBy && task.claimedBy !== agent) throw new Error(`task "${id}" is claimed by another Agent`);
  task.toAgent = toAgent;
  task.claimedBy = undefined;
  task.leaseUntil = undefined;
  addHistory(task, agent, "handed-off", "pending", note);
  writeFile(path, file);
  return task;
}
