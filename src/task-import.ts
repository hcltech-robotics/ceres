import {
  normaliseCaptureConfiguration,
  type CaptureConfiguration,
} from "../shared/protocol.js";
import {
  CERES_TASK_SPEC_SCHEMA,
  CERES_TASK_SPEC_VERSION,
  normaliseTaskSpecification,
  taskSpecificationFromCaptureConfiguration,
  taskSpecificationSha256Hex,
  type CeresTaskSpecification,
} from "../shared/task-specification.js";

export const CERES_TASK_CATALOGUE_SCHEMA = "ceres-task-catalogue" as const;
export const CERES_TASK_CATALOGUE_VERSION = 1 as const;
export const TASK_IMPORT_MAX_BYTES = 1_000_000;

export type TaskCatalogueCategory = "repeatable" | "open-ended" | "multi-step";

export interface TaskCatalogueEntry {
  id: string;
  title: string;
  summary: string;
  category: TaskCatalogueCategory;
  tags: string[];
  gistId: string;
  gistUrl: string;
  rawUrl: string;
  fileName: string;
  taskCount: number;
  taskSpecVersion: typeof CERES_TASK_SPEC_VERSION;
  taskSpecHash: string;
}

export interface TaskCatalogue {
  schema: typeof CERES_TASK_CATALOGUE_SCHEMA;
  version: typeof CERES_TASK_CATALOGUE_VERSION;
  entries: TaskCatalogueEntry[];
}

export interface TaskImportPreview {
  configuration: CaptureConfiguration;
  specification: CeresTaskSpecification;
  taskSpecHash: string;
  publicSource?: "public_catalogue" | "public_gist";
  sourceLabel: string;
  sourceUrl?: string;
  fileName: string;
  format: "task-specification" | "legacy-run";
  warnings: string[];
}

export interface GistImportCandidate {
  fileName: string;
  preview: TaskImportPreview;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const legacyRunSchemas = new Set(["ceres-run-v1", "ceres-run-v2", "ceres-run-v5"]);
const taskCatalogueCategories = new Set<TaskCatalogueCategory>(["repeatable", "open-ended", "multi-step"]);
const hashPattern = /^[0-9a-f]{64}$/;
const gistIdPattern = /^[0-9a-f]{5,64}$/i;

export function normaliseTaskCatalogue(value: unknown): TaskCatalogue {
  const raw = requireRecord(value, "Task catalogue");
  assertExactKeys(raw, ["schema", "version", "entries"], "Task catalogue");
  if (raw.schema !== CERES_TASK_CATALOGUE_SCHEMA) {
    throw new Error(`Task catalogue schema must be ${CERES_TASK_CATALOGUE_SCHEMA}`);
  }
  if (raw.version !== CERES_TASK_CATALOGUE_VERSION) {
    throw new Error(`Task catalogue version must be ${CERES_TASK_CATALOGUE_VERSION}`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error("Task catalogue entries must contain at least one sample");
  }
  const ids = new Set<string>();
  const entries = raw.entries.map((entry, index) => normaliseCatalogueEntry(entry, index, ids));
  return {
    schema: CERES_TASK_CATALOGUE_SCHEMA,
    version: CERES_TASK_CATALOGUE_VERSION,
    entries,
  };
}

export async function parseTaskImportText(
  text: string,
  currentConfiguration: CaptureConfiguration,
  options: {
    sourceLabel: string;
    sourceUrl?: string;
    fileName: string;
  },
): Promise<TaskImportPreview> {
  if (new TextEncoder().encode(text).byteLength > TASK_IMPORT_MAX_BYTES) {
    throw new Error("The task file is larger than 1 MB");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The task file is not valid JSON");
  }
  return prepareTaskImport(value, currentConfiguration, options);
}

export async function prepareTaskImport(
  value: unknown,
  currentConfiguration: CaptureConfiguration,
  options: {
    sourceLabel: string;
    sourceUrl?: string;
    fileName: string;
  },
): Promise<TaskImportPreview> {
  const raw = requireRecord(value, "Imported task document");
  let specification: CeresTaskSpecification;
  let format: TaskImportPreview["format"];
  const warnings: string[] = [];
  if (raw.schema === CERES_TASK_SPEC_SCHEMA) {
    specification = normaliseTaskSpecification(raw);
    format = "task-specification";
  } else if (typeof raw.schema === "string" && legacyRunSchemas.has(raw.schema)) {
    if (!raw.configuration) throw new Error("The CERES run file has no configuration");
    const legacyConfiguration = normaliseCaptureConfiguration(raw.configuration);
    specification = taskSpecificationFromCaptureConfiguration(legacyConfiguration);
    format = "legacy-run";
    warnings.push("Only run and task fields will be imported. Capture and export settings remain unchanged.");
  } else {
    throw new Error("The file is not a supported CERES task specification or run file");
  }
  const configuration = taskSpecificationIntoConfiguration(specification, currentConfiguration);
  return {
    configuration,
    specification,
    taskSpecHash: await taskSpecificationSha256Hex(specification),
    sourceLabel: options.sourceLabel,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    fileName: options.fileName,
    format,
    warnings,
  };
}

export function taskSpecificationIntoConfiguration(
  specification: CeresTaskSpecification,
  currentConfiguration: CaptureConfiguration,
): CaptureConfiguration {
  return normaliseCaptureConfiguration({
    ...currentConfiguration,
    runTitle: specification.runTitle,
    runDescription: specification.runDescription ?? "",
    totalCycles: specification.cycleCount,
    tasks: specification.tasks,
  });
}

export function parseGistId(reference: string): string {
  const trimmed = reference.trim();
  if (gistIdPattern.test(trimmed)) return trimmed.toLowerCase();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter a GitHub Gist URL or Gist ID");
  }
  if (url.protocol !== "https:" || !["gist.github.com", "www.gist.github.com"].includes(url.hostname)) {
    throw new Error("Enter a public gist.github.com URL");
  }
  const id = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (!gistIdPattern.test(id)) throw new Error("The GitHub Gist URL has no valid Gist ID");
  return id.toLowerCase();
}

export async function loadGistImportCandidates(
  reference: string,
  currentConfiguration: CaptureConfiguration,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<GistImportCandidate[]> {
  const gistId = parseGistId(reference);
  const response = await fetchImpl(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("The GitHub Gist was not found or is not public");
    if (response.status === 403 || response.status === 429) {
      throw new Error("GitHub could not load this Gist because its public API limit was reached");
    }
    throw new Error(`GitHub could not load this Gist (HTTP ${response.status})`);
  }
  const gist = requireRecord(await response.json(), "GitHub Gist response");
  const publicGist = gist.public === true;
  const files = requireRecord(gist.files, "GitHub Gist files");
  const htmlUrl = optionalHttpsUrl(gist.html_url) ?? `https://gist.github.com/${gistId}`;
  const candidates: GistImportCandidate[] = [];
  for (const [fallbackName, fileValue] of Object.entries(files)) {
    const file = requireRecord(fileValue, `GitHub Gist file ${fallbackName}`);
    const fileName = typeof file.filename === "string" && file.filename ? file.filename : fallbackName;
    if (!fileName.toLowerCase().endsWith(".json")) continue;
    try {
      const text = await gistFileText(file, fetchImpl, signal);
      const preview = await parseTaskImportText(text, currentConfiguration, {
        sourceLabel: `GitHub Gist / ${fileName}`,
        sourceUrl: htmlUrl,
        fileName,
      });
      candidates.push({
        fileName,
        preview: publicGist ? { ...preview, publicSource: "public_gist" } : preview,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
    }
  }
  if (candidates.length === 0) {
    throw new Error("No valid CERES task specification or run JSON file was found in this Gist");
  }
  return candidates;
}

export async function loadCatalogueImport(
  entry: TaskCatalogueEntry,
  currentConfiguration: CaptureConfiguration,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<TaskImportPreview> {
  const response = await fetchImpl(entry.rawUrl, {
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`The sample could not be loaded (HTTP ${response.status})`);
  assertContentLength(response);
  const preview = await parseTaskImportText(await response.text(), currentConfiguration, {
    sourceLabel: `Sample catalogue / ${entry.title}`,
    sourceUrl: entry.gistUrl,
    fileName: entry.fileName,
  });
  if (preview.format !== "task-specification") {
    throw new Error("The sample catalogue entry is not a versioned task specification");
  }
  if (preview.taskSpecHash !== entry.taskSpecHash) {
    throw new Error("The sample task does not match its catalogue hash");
  }
  if (preview.specification.version !== entry.taskSpecVersion) {
    throw new Error("The sample task version does not match the catalogue");
  }
  if (preview.specification.tasks.length !== entry.taskCount) {
    throw new Error("The sample task count does not match the catalogue");
  }
  return { ...preview, publicSource: "public_catalogue" };
}

function normaliseCatalogueEntry(
  value: unknown,
  index: number,
  ids: Set<string>,
): TaskCatalogueEntry {
  const label = `Task catalogue entry ${index}`;
  const raw = requireRecord(value, label);
  assertExactKeys(raw, [
    "id",
    "title",
    "summary",
    "category",
    "tags",
    "gistId",
    "gistUrl",
    "rawUrl",
    "fileName",
    "taskCount",
    "taskSpecVersion",
    "taskSpecHash",
  ], label);
  const id = requireNonEmptyString(raw.id, `${label} id`);
  if (ids.has(id)) throw new Error(`Task catalogue entry id ${id} is duplicated`);
  ids.add(id);
  if (!taskCatalogueCategories.has(raw.category as TaskCatalogueCategory)) {
    throw new Error(`${label} category is invalid`);
  }
  if (!Array.isArray(raw.tags) || raw.tags.length === 0) {
    throw new Error(`${label} tags must contain at least one tag`);
  }
  const tags = raw.tags.map((tag, tagIndex) => requireNonEmptyString(tag, `${label} tag ${tagIndex}`));
  const gistId = requireNonEmptyString(raw.gistId, `${label} gistId`).toLowerCase();
  if (!gistIdPattern.test(gistId)) throw new Error(`${label} gistId is invalid`);
  const gistUrl = requireUrl(raw.gistUrl, `${label} gistUrl`, "gist.github.com");
  const rawUrl = requireUrl(raw.rawUrl, `${label} rawUrl`, "gist.githubusercontent.com");
  if (!gistUrl.pathname.endsWith(`/${gistId}`)) throw new Error(`${label} gistUrl does not match gistId`);
  if (!rawUrl.pathname.includes(`/${gistId}/raw/`)) throw new Error(`${label} rawUrl does not match gistId`);
  if (raw.taskSpecVersion !== CERES_TASK_SPEC_VERSION) {
    throw new Error(`${label} taskSpecVersion must be ${CERES_TASK_SPEC_VERSION}`);
  }
  const taskSpecHash = requireNonEmptyString(raw.taskSpecHash, `${label} taskSpecHash`);
  if (!hashPattern.test(taskSpecHash)) throw new Error(`${label} taskSpecHash is invalid`);
  return {
    id,
    title: requireNonEmptyString(raw.title, `${label} title`),
    summary: requireNonEmptyString(raw.summary, `${label} summary`),
    category: raw.category as TaskCatalogueCategory,
    tags,
    gistId,
    gistUrl: gistUrl.toString(),
    rawUrl: rawUrl.toString(),
    fileName: requireNonEmptyString(raw.fileName, `${label} fileName`),
    taskCount: requirePositiveSafeInteger(raw.taskCount, `${label} taskCount`),
    taskSpecVersion: CERES_TASK_SPEC_VERSION,
    taskSpecHash,
  };
}

async function gistFileText(
  file: Record<string, unknown>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof file.size === "number" && file.size > TASK_IMPORT_MAX_BYTES) {
    throw new Error("The Gist file is larger than 1 MB");
  }
  if (file.truncated !== true && typeof file.content === "string") return file.content;
  const rawUrl = requireUrl(file.raw_url, "GitHub Gist raw URL", "gist.githubusercontent.com");
  const response = await fetchImpl(rawUrl, {
    headers: { Accept: "application/json" },
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new Error(`GitHub could not load a Gist file (HTTP ${response.status})`);
  assertContentLength(response);
  return response.text();
}

function assertContentLength(response: Response): void {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TASK_IMPORT_MAX_BYTES) {
    throw new Error("The task file is larger than 1 MB");
  }
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

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive safe integer`);
  return Number(value);
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function requireUrl(value: unknown, label: string, host: string): URL {
  if (typeof value !== "string") throw new Error(`${label} must be an HTTPS URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.hostname !== host) {
    throw new Error(`${label} must use ${host}`);
  }
  return url;
}
