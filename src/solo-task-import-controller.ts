import type { CaptureConfiguration, TaskDefinition } from "../shared/protocol.js";
import {
  loadCatalogueImport,
  loadGistImportCandidates,
  normaliseTaskCatalogue,
  parseTaskImportText,
  taskSpecificationIntoConfiguration,
  TASK_IMPORT_MAX_BYTES,
  type GistImportCandidate,
  type TaskCatalogue,
  type TaskCatalogueCategory,
  type TaskImportPreview,
} from "./task-import.js";

export type SoloTaskImportSource = "sample" | "gist" | "file";

export type SoloTaskImportStatus =
  | "idle"
  | "loading-catalogue"
  | "catalogue-ready"
  | "loading-sample"
  | "loading-gist"
  | "awaiting-gist-selection"
  | "loading-file"
  | "preview-ready"
  | "applying"
  | "applied"
  | "cancelled"
  | "error";

export interface SoloTaskCatalogueEntryPresentation {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: TaskCatalogueCategory;
  readonly tags: readonly string[];
  readonly taskCount: number;
  readonly taskSpecVersion: number;
  readonly taskSpecHash: string;
}

export interface SoloTaskImportTaskPresentation {
  readonly id: string;
  readonly type: TaskDefinition["type"];
  readonly label: string;
  readonly instructions: string;
  readonly durationS: number | null;
  readonly repeatCount: number | null;
  readonly resetTimeS: number | null;
}

export interface SoloTaskImportPreviewPresentation {
  readonly sourceLabel: string;
  readonly sourceUrl: string | null;
  readonly fileName: string;
  readonly format: TaskImportPreview["format"];
  readonly taskSpecHash: string;
  readonly runTitle: string;
  readonly runDescription: string;
  readonly cycleCount: number;
  readonly tasks: readonly SoloTaskImportTaskPresentation[];
  readonly warnings: readonly string[];
}

export interface SoloTaskImportGistCandidatePresentation {
  readonly index: number;
  readonly fileName: string;
  readonly runTitle: string;
  readonly taskCount: number;
  readonly taskSpecHash: string;
}

export interface SoloTaskImportSnapshot {
  readonly source: SoloTaskImportSource;
  readonly catalogueEntries: readonly SoloTaskCatalogueEntryPresentation[];
  readonly gistCandidates: readonly SoloTaskImportGistCandidatePresentation[];
  readonly selectedGistCandidateIndex: number | null;
  readonly preview: SoloTaskImportPreviewPresentation | null;
  readonly status: SoloTaskImportStatus;
  readonly detail: string;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface SoloTaskImportFileResult {
  fileName: string;
  text: string;
}

export interface SoloTaskImportControllerOptions {
  readConfiguration: () => CaptureConfiguration;
  applyConfiguration: (configuration: CaptureConfiguration) => void | Promise<void>;
  fetch?: typeof fetch;
  catalogueUrl?: string;
}

type SoloTaskImportListener = (snapshot: SoloTaskImportSnapshot) => void;

interface ActiveRequest {
  generation: number;
  controller: AbortController;
}

const DEFAULT_CATALOGUE_URL = "/task-catalogue.json";
const MAX_GIST_REFERENCE_LENGTH = 512;
const MAX_FILE_NAME_LENGTH = 255;

export class SoloTaskImportController {
  private readonly readConfiguration: SoloTaskImportControllerOptions["readConfiguration"];
  private readonly applyConfiguration: SoloTaskImportControllerOptions["applyConfiguration"];
  private readonly fetchImpl: typeof fetch;
  private readonly catalogueUrl: string;
  private readonly listeners = new Set<SoloTaskImportListener>();
  private source: SoloTaskImportSource = "sample";
  private catalogue: TaskCatalogue | null = null;
  private gistCandidates: GistImportCandidate[] = [];
  private selectedGistCandidateIndex: number | null = null;
  private preview: TaskImportPreview | null = null;
  private status: SoloTaskImportStatus = "idle";
  private detail = "Select a task source";
  private busy = false;
  private error: string | null = null;
  private activeRequest: ActiveRequest | null = null;
  private generation = 0;
  private disposed = false;
  private snapshotValue: SoloTaskImportSnapshot;

  constructor(options: SoloTaskImportControllerOptions) {
    this.readConfiguration = options.readConfiguration;
    this.applyConfiguration = options.applyConfiguration;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.catalogueUrl = options.catalogueUrl ?? DEFAULT_CATALOGUE_URL;
    this.snapshotValue = this.buildSnapshot();
  }

  get snapshot() {
    return this.snapshotValue;
  }

  subscribe(listener: SoloTaskImportListener) {
    this.assertAvailable();
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  selectSource(source: SoloTaskImportSource) {
    this.assertAvailable();
    if (!isTaskImportSource(source)) throw new Error("The Solo task import source is invalid");
    this.invalidateRequest();
    this.source = source;
    this.gistCandidates = [];
    this.selectedGistCandidateIndex = null;
    this.preview = null;
    this.busy = false;
    this.error = null;
    if (source === "sample" && this.catalogue) {
      this.status = "catalogue-ready";
      this.detail = `${this.catalogue.entries.length} verified samples`;
    } else {
      this.status = "idle";
      this.detail = source === "sample"
        ? "Load the verified sample catalogue"
        : source === "gist"
          ? "Enter a public GitHub Gist URL or ID"
          : "Choose a local task file";
    }
    this.publish();
  }

  async loadCatalogue() {
    this.assertAvailable();
    if (this.source !== "sample") this.selectSource("sample");
    const request = this.beginRequest("loading-catalogue", "Loading the verified sample catalogue");
    try {
      const response = await this.fetchImpl(this.catalogueUrl, {
        headers: { Accept: "application/json" },
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(`Sample catalogue could not be loaded (HTTP ${response.status})`);
      const text = await boundedResponseText(response, "The task catalogue");
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("The task catalogue is not valid JSON");
      }
      const catalogue = normaliseTaskCatalogue(value);
      if (!this.isCurrent(request)) return this.snapshotValue;
      this.catalogue = catalogue;
      this.finishRequest(request);
      this.status = "catalogue-ready";
      this.detail = `${catalogue.entries.length} verified samples`;
      this.publish();
    } catch (error) {
      this.failRequest(request, error, "Sample catalogue could not be loaded");
    }
    return this.snapshotValue;
  }

  async previewSample(entryId: string) {
    this.assertAvailable();
    if (this.source !== "sample") this.selectSource("sample");
    const id = normaliseBoundedText(entryId, "Sample identifier", 128);
    const entry = this.catalogue?.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      this.setError("The selected sample is not in the verified catalogue");
      return this.snapshotValue;
    }
    const request = this.beginRequest("loading-sample", `Loading ${entry.title}`);
    try {
      const preview = await loadCatalogueImport(
        entry,
        this.readConfiguration(),
        this.fetchImpl,
        request.controller.signal,
      );
      if (!this.isCurrent(request)) return this.snapshotValue;
      this.finishPreview(request, preview);
    } catch (error) {
      this.failRequest(request, error, "The selected sample could not be loaded");
    }
    return this.snapshotValue;
  }

  async loadGist(reference: string) {
    this.assertAvailable();
    if (this.source !== "gist") this.selectSource("gist");
    const boundedReference = normaliseBoundedText(
      reference,
      "GitHub Gist reference",
      MAX_GIST_REFERENCE_LENGTH,
    );
    const request = this.beginRequest("loading-gist", "Loading the public GitHub Gist");
    this.gistCandidates = [];
    this.selectedGistCandidateIndex = null;
    this.publish();
    try {
      const candidates = await loadGistImportCandidates(
        boundedReference,
        this.readConfiguration(),
        this.fetchImpl,
        request.controller.signal,
      );
      if (!this.isCurrent(request)) return this.snapshotValue;
      this.gistCandidates = candidates;
      this.finishRequest(request);
      if (candidates.length === 1) {
        this.selectedGistCandidateIndex = 0;
        this.preview = candidates[0]!.preview;
        this.status = "preview-ready";
        this.detail = "Valid preview ready to import";
      } else {
        this.preview = null;
        this.status = "awaiting-gist-selection";
        this.detail = `${candidates.length} valid files found`;
      }
      this.publish();
    } catch (error) {
      this.failRequest(request, error, "The public GitHub Gist could not be loaded");
    }
    return this.snapshotValue;
  }

  selectGistCandidate(index: number) {
    this.assertAvailable();
    if (this.source !== "gist") {
      this.setError("Select the GitHub Gist source first");
      return false;
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.gistCandidates.length) {
      this.setError("The selected GitHub Gist file is invalid");
      return false;
    }
    this.invalidateRequest();
    this.selectedGistCandidateIndex = index;
    this.preview = this.gistCandidates[index]!.preview;
    this.busy = false;
    this.error = null;
    this.status = "preview-ready";
    this.detail = "Valid preview ready to import";
    this.publish();
    return true;
  }

  async previewLocalFile(file: File) {
    this.assertAvailable();
    if (this.source !== "file") this.selectSource("file");
    const fileName = normaliseFileName(file?.name);
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > TASK_IMPORT_MAX_BYTES) {
      this.setError("The task file is larger than 1 MB");
      return this.snapshotValue;
    }
    const request = this.beginRequest("loading-file", `Reading ${fileName}`);
    try {
      const text = await file.text();
      if (!this.isCurrent(request)) return this.snapshotValue;
      const preview = await parseTaskImportText(text, this.readConfiguration(), {
        sourceLabel: "Local file",
        fileName,
      });
      if (!this.isCurrent(request)) return this.snapshotValue;
      this.finishPreview(request, preview);
    } catch (error) {
      this.failRequest(request, error, "The local task file could not be read");
    }
    return this.snapshotValue;
  }

  async previewLocalText(result: SoloTaskImportFileResult) {
    this.assertAvailable();
    if (this.source !== "file") this.selectSource("file");
    const fileName = normaliseFileName(result?.fileName);
    if (typeof result?.text !== "string") {
      this.setError("The task file result is invalid");
      return this.snapshotValue;
    }
    const request = this.beginRequest("loading-file", `Reading ${fileName}`);
    try {
      const preview = await parseTaskImportText(result.text, this.readConfiguration(), {
        sourceLabel: "Local file",
        fileName,
      });
      if (!this.isCurrent(request)) return this.snapshotValue;
      this.finishPreview(request, preview);
    } catch (error) {
      this.failRequest(request, error, "The local task file could not be read");
    }
    return this.snapshotValue;
  }

  async confirm() {
    this.assertAvailable();
    if (this.busy || !this.preview) {
      this.setError("Preview a valid task source before importing it");
      return null;
    }
    const preview = this.preview;
    const configuration = taskSpecificationIntoConfiguration(
      preview.specification,
      this.readConfiguration(),
    );
    this.busy = true;
    this.error = null;
    this.status = "applying";
    this.detail = "Persisting imported task specification";
    this.publish();
    try {
      await this.applyConfiguration(structuredClone(configuration));
      this.preview = null;
      this.busy = false;
      this.error = null;
      this.status = "applied";
      this.detail = "Task specification imported and persisted";
      this.publish();
      return structuredClone(configuration);
    } catch (error) {
      this.busy = false;
      this.error = errorMessage(error, "The imported task specification could not be persisted");
      this.status = "error";
      this.detail = this.error;
      this.publish();
      throw error;
    }
  }

  cancel() {
    this.assertAvailable();
    this.invalidateRequest();
    this.preview = null;
    this.gistCandidates = [];
    this.selectedGistCandidateIndex = null;
    this.busy = false;
    this.error = null;
    this.status = "cancelled";
    this.detail = "Task import cancelled";
    this.publish();
  }

  abort() {
    this.cancel();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateRequest();
    this.listeners.clear();
  }

  private beginRequest(status: SoloTaskImportStatus, detail: string): ActiveRequest {
    this.invalidateRequest();
    const request = {
      generation: ++this.generation,
      controller: new AbortController(),
    };
    this.activeRequest = request;
    this.preview = null;
    this.busy = true;
    this.error = null;
    this.status = status;
    this.detail = detail;
    this.publish();
    return request;
  }

  private finishPreview(request: ActiveRequest, preview: TaskImportPreview) {
    this.finishRequest(request);
    this.preview = preview;
    this.busy = false;
    this.error = null;
    this.status = "preview-ready";
    this.detail = "Valid preview ready to import";
    this.publish();
  }

  private finishRequest(request: ActiveRequest) {
    if (this.activeRequest === request) this.activeRequest = null;
    this.busy = false;
  }

  private failRequest(request: ActiveRequest, error: unknown, fallback: string) {
    if (!this.isCurrent(request)) return;
    this.finishRequest(request);
    this.preview = null;
    this.status = "error";
    this.detail = errorMessage(error, fallback);
    this.error = this.detail;
    this.publish();
  }

  private setError(message: string) {
    this.invalidateRequest();
    this.preview = null;
    this.busy = false;
    this.status = "error";
    this.detail = message;
    this.error = message;
    this.publish();
  }

  private isCurrent(request: ActiveRequest) {
    return !this.disposed
      && this.activeRequest === request
      && request.generation === this.generation
      && !request.controller.signal.aborted;
  }

  private invalidateRequest() {
    this.generation += 1;
    this.activeRequest?.controller.abort();
    this.activeRequest = null;
  }

  private publish() {
    if (this.disposed) return;
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshotValue);
  }

  private buildSnapshot(): SoloTaskImportSnapshot {
    const catalogueEntries = (this.catalogue?.entries ?? []).map((entry) => Object.freeze({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      category: entry.category,
      tags: Object.freeze([...entry.tags]),
      taskCount: entry.taskCount,
      taskSpecVersion: entry.taskSpecVersion,
      taskSpecHash: entry.taskSpecHash,
    }));
    const gistCandidates = this.gistCandidates.map((candidate, index) => Object.freeze({
      index,
      fileName: candidate.fileName,
      runTitle: candidate.preview.specification.runTitle,
      taskCount: candidate.preview.specification.tasks.length,
      taskSpecHash: candidate.preview.taskSpecHash,
    }));
    return Object.freeze({
      source: this.source,
      catalogueEntries: Object.freeze(catalogueEntries),
      gistCandidates: Object.freeze(gistCandidates),
      selectedGistCandidateIndex: this.selectedGistCandidateIndex,
      preview: this.preview ? previewPresentation(this.preview) : null,
      status: this.status,
      detail: this.detail,
      busy: this.busy,
      error: this.error,
    });
  }

  private assertAvailable() {
    if (this.disposed) throw new Error("A disposed Solo task import controller cannot be used");
  }
}

function previewPresentation(preview: TaskImportPreview): SoloTaskImportPreviewPresentation {
  const tasks = preview.specification.tasks.map((task) => Object.freeze({
    id: task.id,
    type: task.type,
    label: task.label,
    instructions: task.instructions,
    durationS: "durationS" in task ? task.durationS : null,
    repeatCount: "repeatCount" in task ? task.repeatCount : null,
    resetTimeS: "resetTimeS" in task ? task.resetTimeS : null,
  }));
  return Object.freeze({
    sourceLabel: preview.sourceLabel,
    sourceUrl: preview.sourceUrl ?? null,
    fileName: preview.fileName,
    format: preview.format,
    taskSpecHash: preview.taskSpecHash,
    runTitle: preview.specification.runTitle,
    runDescription: preview.specification.runDescription ?? "",
    cycleCount: preview.specification.cycleCount,
    tasks: Object.freeze(tasks),
    warnings: Object.freeze([...preview.warnings]),
  });
}

async function boundedResponseText(response: Response, label: string) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TASK_IMPORT_MAX_BYTES) {
    throw new Error(`${label} is larger than 1 MB`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > TASK_IMPORT_MAX_BYTES) {
    throw new Error(`${label} is larger than 1 MB`);
  }
  return text;
}

function normaliseBoundedText(value: string, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} is too long`);
  return trimmed;
}

function normaliseFileName(value: string | undefined) {
  return normaliseBoundedText(value ?? "", "Task file name", MAX_FILE_NAME_LENGTH);
}

function isTaskImportSource(value: unknown): value is SoloTaskImportSource {
  return value === "sample" || value === "gist" || value === "file";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
