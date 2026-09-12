import type { CaptureConfiguration, TaskDefinition } from "./protocol.js";

export const CERES_TASK_SPEC_SCHEMA = "ceres-task-specification" as const;
export const CERES_TASK_SPEC_VERSION = 1 as const;

interface TaskSpecificationIdentity {
  id: string;
  type: TaskDefinition["type"];
  label: string;
  instructions: string;
}

export interface TimedTaskSpecification extends TaskSpecificationIdentity {
  type: "timed";
  durationS: number;
  repeatCount: number;
  resetTimeS: number;
}

export interface OpenTaskSpecification extends TaskSpecificationIdentity {
  type: "open";
  repeatCount: number;
  resetTimeS: number;
}

export interface PauseTaskSpecification extends TaskSpecificationIdentity {
  type: "pause";
  durationS: number;
}

export type TaskSpecificationEntry =
  | TimedTaskSpecification
  | OpenTaskSpecification
  | PauseTaskSpecification;

export interface CeresTaskSpecification {
  schema: typeof CERES_TASK_SPEC_SCHEMA;
  version: typeof CERES_TASK_SPEC_VERSION;
  runTitle: string;
  runDescription?: string;
  cycleCount: number;
  tasks: TaskSpecificationEntry[];
}

export function taskSpecificationFromCaptureConfiguration(
  configuration: CaptureConfiguration,
): CeresTaskSpecification {
  return normaliseTaskSpecification({
    schema: CERES_TASK_SPEC_SCHEMA,
    version: CERES_TASK_SPEC_VERSION,
    runTitle: configuration.runTitle,
    ...(configuration.runDescription ? { runDescription: configuration.runDescription } : {}),
    cycleCount: configuration.totalCycles,
    tasks: configuration.tasks,
  });
}

export function normaliseTaskSpecification(value: unknown): CeresTaskSpecification {
  const raw = requireRecord(value, "Task specification");
  assertExactKeys(raw, [
    "schema",
    "version",
    "runTitle",
    "runDescription",
    "cycleCount",
    "tasks",
  ], "Task specification");
  if (raw.schema !== CERES_TASK_SPEC_SCHEMA) {
    throw new Error(`Task specification schema must be ${CERES_TASK_SPEC_SCHEMA}`);
  }
  if (raw.version !== CERES_TASK_SPEC_VERSION) {
    throw new Error(`Task specification version must be ${CERES_TASK_SPEC_VERSION}`);
  }
  const runTitle = requireNonEmptyString(raw.runTitle, "Task specification runTitle");
  const runDescription = optionalTrimmedString(raw.runDescription, "Task specification runDescription");
  const cycleCount = requirePositiveSafeInteger(raw.cycleCount, "Task specification cycleCount");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error("Task specification tasks must contain at least one task");
  }
  const usedIds = new Set<string>();
  const tasks = raw.tasks.map((task, index) => normaliseTask(task, index, usedIds));
  return {
    schema: CERES_TASK_SPEC_SCHEMA,
    version: CERES_TASK_SPEC_VERSION,
    runTitle,
    ...(runDescription ? { runDescription } : {}),
    cycleCount,
    tasks,
  };
}

export function canonicalTaskSpecification(value: unknown): string {
  return JSON.stringify(normaliseTaskSpecification(value));
}

export function canonicalTaskSpecificationBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalTaskSpecification(value));
}

export async function taskSpecificationSha256Hex(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable");
  const bytes = Uint8Array.from(canonicalTaskSpecificationBytes(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
  return bytesToLowerHex(new Uint8Array(digest));
}

export function hasTaskSpecificationProvenance(value: {
  taskSpecVersion?: unknown;
  taskSpecHash?: unknown;
  taskSpecification?: unknown;
}): boolean {
  return value.taskSpecVersion !== undefined
    || value.taskSpecHash !== undefined
    || value.taskSpecification !== undefined;
}

export async function verifyTaskSpecificationProvenance(value: {
  taskSpecVersion?: unknown;
  taskSpecHash?: unknown;
  taskSpecification?: unknown;
}): Promise<CeresTaskSpecification | null> {
  if (!hasTaskSpecificationProvenance(value)) return null;
  if (value.taskSpecVersion !== CERES_TASK_SPEC_VERSION) {
    throw new Error(`Episode task specification version must be ${CERES_TASK_SPEC_VERSION}`);
  }
  if (typeof value.taskSpecHash !== "string" || !/^[0-9a-f]{64}$/.test(value.taskSpecHash)) {
    throw new Error("Episode task specification hash must be lowercase SHA-256 hexadecimal");
  }
  const taskSpecification = normaliseTaskSpecification(value.taskSpecification);
  if (await taskSpecificationSha256Hex(taskSpecification) !== value.taskSpecHash) {
    throw new Error("Episode task specification hash does not match its canonical specification");
  }
  return taskSpecification;
}

function normaliseTask(value: unknown, index: number, usedIds: Set<string>): TaskSpecificationEntry {
  const raw = requireRecord(value, `Task specification task ${index}`);
  const type = raw.type;
  if (type !== "timed" && type !== "open" && type !== "pause") {
    throw new Error(`Task specification task ${index} type is invalid`);
  }
  const allowedKeys = type === "pause"
    ? ["id", "type", "label", "instructions", "durationS"]
    : type === "open"
      ? ["id", "type", "label", "instructions", "repeatCount", "resetTimeS"]
      : ["id", "type", "label", "instructions", "durationS", "repeatCount", "resetTimeS"];
  assertExactKeys(raw, allowedKeys, `Task specification task ${index}`);
  const id = requireNonEmptyString(raw.id, `Task specification task ${index} id`);
  if (usedIds.has(id)) throw new Error(`Task specification task id ${id} is duplicated`);
  usedIds.add(id);
  const identity = {
    id,
    type,
    label: requireNonEmptyString(raw.label, `Task specification task ${index} label`),
    instructions: requireNonEmptyString(raw.instructions, `Task specification task ${index} instructions`),
  };
  if (type === "pause") {
    return {
      ...identity,
      type,
      durationS: requireNonNegativeFinite(raw.durationS, `Task specification task ${index} durationS`),
    };
  }
  const repetition = {
    repeatCount: requirePositiveSafeInteger(raw.repeatCount, `Task specification task ${index} repeatCount`),
    resetTimeS: requireNonNegativeFinite(raw.resetTimeS, `Task specification task ${index} resetTimeS`),
  };
  if (type === "open") return { ...identity, type, ...repetition };
  return {
    ...identity,
    type,
    durationS: requireNonNegativeFinite(raw.durationS, `Task specification task ${index} durationS`),
    ...repetition,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalTrimmedString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string when present`);
  return value.trim() || undefined;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a non-negative finite number no greater than Number.MAX_SAFE_INTEGER`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function bytesToLowerHex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}
