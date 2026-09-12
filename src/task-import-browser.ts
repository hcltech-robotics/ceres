import type { CaptureConfiguration } from "../shared/protocol.js";
import {
  TASK_IMPORT_MAX_BYTES,
  loadCatalogueImport,
  loadGistImportCandidates,
  normaliseTaskCatalogue,
  parseTaskImportText,
  type GistImportCandidate,
  type TaskCatalogue,
  type TaskImportPreview,
} from "./task-import.js";

const escapeHtml = (value: string) => value.replace(
  /[&<>"]/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!,
);

const workspaceMarkup = (
  headerActionLabel: string,
  secondaryHeaderActionLabel: string | null,
  backHeaderActionLabel: string | null,
) => `
  <section id="task-editor-modal" class="job-error-modal task-editor-modal" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" hidden>
    <div class="task-editor-card">
      <header class="task-editor-header">
        <div><span class="inspector-label">RUN EDITOR</span><h2 id="task-editor-title">Edit and import run</h2></div>
        <div class="workspace-header-actions">
          ${backHeaderActionLabel ? `<button id="task-editor-back" class="toolbar-button" type="button">${escapeHtml(backHeaderActionLabel)}</button>` : ""}
          ${secondaryHeaderActionLabel ? `<button id="task-editor-secondary-action" class="toolbar-button" type="button">${escapeHtml(secondaryHeaderActionLabel)}</button>` : ""}
          <button id="task-editor-close" class="toolbar-button toolbar-primary" type="button">${escapeHtml(headerActionLabel)}</button>
        </div>
      </header>
      <div class="task-editor-grid">
        <section class="workspace-draft" aria-labelledby="run-draft-heading">
          <div class="workspace-section-heading"><span id="run-draft-heading">CURRENT RUN</span></div>
          <div id="task-editor-host" class="task-editor-host setup-details"></div>
        </section>
        <aside class="task-importer setup-details" aria-labelledby="task-import-heading">
          <div class="workspace-section-heading">
            <span id="task-import-heading">IMPORT</span>
            <select id="run-import-source-selector" aria-label="Task import source">
              <option value="sample">SAMPLES</option>
              <option value="gist">GIST</option>
              <option value="file">FILE</option>
            </select>
          </div>
          <section id="task-source-sample" class="task-import-source-panel" aria-label="Sample catalogue">
            <div id="catalogue-status" class="import-source-status">LOADING CATALOGUE</div>
            <div id="task-catalogue-list" class="task-catalogue-list"></div>
          </section>
          <section id="task-source-gist" class="task-import-source-panel" aria-label="GitHub Gist" hidden>
            <label>PUBLIC GIST URL OR ID<input id="task-gist-reference" type="text" autocomplete="off" placeholder="gist.github.com/user/id"></label>
            <button id="task-gist-fetch" class="toolbar-button" type="button">FETCH</button>
            <label id="task-gist-file-field" hidden>VALID JSON FILE<select id="task-gist-file"><option value="">SELECT FILE</option></select></label>
          </section>
          <section id="task-source-file" class="task-import-source-panel" aria-label="Local file" hidden>
            <p>Select a saved CERES run file or a versioned task specification.</p>
            <button id="task-local-file" class="toolbar-button" type="button">CHOOSE FILE</button>
            <span id="task-local-file-name">NO FILE SELECTED</span>
            <input id="run-load-file" type="file" accept="application/json,.json" hidden>
          </section>
          <div id="task-import-status" class="task-import-status" role="status" aria-live="polite" hidden></div>
          <article id="task-import-preview" class="task-import-preview" aria-label="Task import preview">
            <div class="task-import-empty"><span>NO PREVIEW</span><small>Select a source to inspect it before importing.</small></div>
          </article>
          <div class="task-import-actions"><button id="task-import-append" class="toolbar-button" type="button" disabled>APPEND</button><button id="task-import-confirm" class="toolbar-button toolbar-primary" type="button" disabled>IMPORT</button></div>
        </aside>
      </div>
    </div>
  </section>
`;

export interface TaskImportWorkspaceOptions {
  root: HTMLElement;
  readConfiguration: () => CaptureConfiguration;
  applyConfiguration: (configuration: CaptureConfiguration) => void;
  hasUnsavedChanges: () => boolean;
  openOverlay: () => void;
  closeOverlay: () => void;
  headerActionLabel?: string;
  headerActionDisabled?: () => boolean;
  onHeaderAction?: () => void;
  secondaryHeaderActionLabel?: string;
  secondaryHeaderActionDisabled?: () => boolean;
  onSecondaryHeaderAction?: () => void;
  backHeaderActionLabel?: string;
  backHeaderActionDisabled?: () => boolean;
  onBackHeaderAction?: () => void;
}

export class TaskImportWorkspace {
  private readonly root: HTMLElement;
  private readonly readConfiguration: () => CaptureConfiguration;
  private readonly applyConfiguration: (configuration: CaptureConfiguration) => void;
  private readonly hasUnsavedChanges: () => boolean;
  private readonly openOverlay: () => void;
  private readonly closeOverlay: () => void;
  private readonly headerActionLabel: string;
  private readonly headerActionDisabled: () => boolean;
  private readonly onHeaderAction: (() => void) | null;
  private readonly secondaryHeaderActionLabel: string | null;
  private readonly secondaryHeaderActionDisabled: () => boolean;
  private readonly onSecondaryHeaderAction: (() => void) | null;
  private readonly backHeaderActionLabel: string | null;
  private readonly backHeaderActionDisabled: () => boolean;
  private readonly onBackHeaderAction: (() => void) | null;
  private catalogue: TaskCatalogue | null = null;
  private preview: TaskImportPreview | null = null;
  private gistCandidates: GistImportCandidate[] = [];
  private abortController: AbortController | null = null;
  private feedbackTimer: number | null = null;
  private mounted = false;
  private readonly handleDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape") return;
    const modal = this.root.querySelector<HTMLElement>("#task-editor-modal");
    if (!modal || modal.hidden) return;
    event.preventDefault();
    this.requestClose();
  };

  constructor(options: TaskImportWorkspaceOptions) {
    this.root = options.root;
    this.readConfiguration = options.readConfiguration;
    this.applyConfiguration = options.applyConfiguration;
    this.hasUnsavedChanges = options.hasUnsavedChanges;
    this.openOverlay = options.openOverlay;
    this.closeOverlay = options.closeOverlay;
    this.headerActionLabel = options.headerActionLabel ?? "APPLY & CLOSE";
    this.headerActionDisabled = options.headerActionDisabled ?? (() => false);
    this.onHeaderAction = options.onHeaderAction ?? null;
    this.secondaryHeaderActionLabel = options.secondaryHeaderActionLabel ?? null;
    this.secondaryHeaderActionDisabled = options.secondaryHeaderActionDisabled ?? (() => false);
    this.onSecondaryHeaderAction = options.onSecondaryHeaderAction ?? null;
    this.backHeaderActionLabel = options.backHeaderActionLabel ?? null;
    this.backHeaderActionDisabled = options.backHeaderActionDisabled ?? (() => false);
    this.onBackHeaderAction = options.onBackHeaderAction ?? null;
  }

  open() {
    this.mount();
    const modal = this.root.querySelector<HTMLElement>("#task-editor-modal")!;
    if (!modal.hidden) return;
    this.root.querySelector("#task-editor-host")!.append(this.root.querySelector("#run-editor-home")!);
    this.reset();
    this.root.querySelector<HTMLButtonElement>("#task-editor-close")!.disabled = this.headerActionDisabled();
    const secondaryAction = this.root.querySelector<HTMLButtonElement>("#task-editor-secondary-action");
    if (secondaryAction) secondaryAction.disabled = this.secondaryHeaderActionDisabled();
    const backAction = this.root.querySelector<HTMLButtonElement>("#task-editor-back");
    if (backAction) backAction.disabled = this.backHeaderActionDisabled();
    this.openOverlay();
    this.selectSource("sample");
  }

  close() {
    const modal = this.root.querySelector<HTMLElement>("#task-editor-modal");
    if (!modal || modal.hidden) return;
    this.abortController?.abort();
    this.abortController = null;
    this.closeOverlay();
    this.returnEditor();
    this.reset();
  }

  dispose() {
    this.abortController?.abort();
    this.abortController = null;
    if (this.feedbackTimer !== null) window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    document.removeEventListener("keydown", this.handleDocumentKeyDown);
    this.returnEditor();
    this.root.querySelector("#task-editor-mount")?.replaceChildren();
    this.mounted = false;
  }

  private mount() {
    if (this.mounted) return;
    const mount = this.root.querySelector<HTMLElement>("#task-editor-mount")!;
    mount.innerHTML = workspaceMarkup(
      this.headerActionLabel,
      this.secondaryHeaderActionLabel,
      this.backHeaderActionLabel,
    );
    this.mounted = true;
    document.addEventListener("keydown", this.handleDocumentKeyDown);
    this.root.querySelector<HTMLButtonElement>("#task-editor-close")!.addEventListener("click", (event) => {
      if ((event.currentTarget as HTMLButtonElement).disabled) return;
      if (this.onHeaderAction) this.onHeaderAction();
      else this.close();
    });
    this.root.querySelector<HTMLButtonElement>("#task-editor-secondary-action")?.addEventListener("click", (event) => {
      if ((event.currentTarget as HTMLButtonElement).disabled) return;
      this.onSecondaryHeaderAction?.();
    });
    this.root.querySelector<HTMLButtonElement>("#task-editor-back")?.addEventListener("click", (event) => {
      if ((event.currentTarget as HTMLButtonElement).disabled) return;
      if (this.onBackHeaderAction) this.onBackHeaderAction();
      else this.requestClose();
    });
    this.root.querySelector("#task-editor-modal")!.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) this.requestClose();
    });
    this.root.querySelector<HTMLSelectElement>("#run-import-source-selector")!.addEventListener("change", (event) => {
      this.selectSource((event.currentTarget as HTMLSelectElement).value as "sample" | "gist" | "file");
    });
    this.root.querySelector("#task-gist-fetch")!.addEventListener("click", () => void this.prepareGist());
    this.root.querySelector<HTMLInputElement>("#task-gist-reference")!.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.prepareGist();
      }
    });
    this.root.querySelector<HTMLSelectElement>("#task-gist-file")!.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value;
      const index = value === "" ? Number.NaN : Number(value);
      this.setPreview(Number.isInteger(index) ? this.gistCandidates[index]?.preview ?? null : null);
    });
    this.root.querySelector("#task-local-file")!.addEventListener("click", () => {
      this.root.querySelector<HTMLInputElement>("#run-load-file")!.click();
    });
    this.root.querySelector<HTMLInputElement>("#run-load-file")!.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      void this.prepareLocalFile(input.files?.[0]);
    });
    this.root.querySelector("#task-catalogue-list")!.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-task-sample-id]");
      if (button) void this.prepareCatalogueSample(button.dataset.taskSampleId!);
    });
    this.root.querySelector("#task-import-confirm")!.addEventListener("click", () => this.confirm());
    this.root.querySelector("#task-import-append")!.addEventListener("click", () => this.confirm("append"));
  }

  private returnEditor() {
    const editor = this.root.querySelector<HTMLElement>("#run-editor-home");
    if (editor) this.root.querySelector("#run-editor-home-slot")?.append(editor);
  }

  private reset() {
    this.abortController?.abort();
    this.abortController = null;
    if (this.feedbackTimer !== null) window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    this.preview = null;
    this.gistCandidates = [];
    this.root.querySelector<HTMLButtonElement>("#task-import-confirm")!.disabled = true;
    this.root.querySelector<HTMLButtonElement>("#task-import-append")!.disabled = true;
    this.renderPreview(null);
    this.setStatus("");
    this.root.querySelector<HTMLElement>("#task-gist-file-field")!.hidden = true;
    this.root.querySelector<HTMLSelectElement>("#task-gist-file")!.innerHTML = `<option value="">SELECT FILE</option>`;
    this.root.querySelector<HTMLElement>("#task-local-file-name")!.textContent = "NO FILE SELECTED";
    this.root.querySelector<HTMLInputElement>("#run-load-file")!.value = "";
  }

  private selectSource(source: "sample" | "gist" | "file") {
    this.abortController?.abort();
    this.abortController = null;
    this.preview = null;
    this.gistCandidates = [];
    this.root.querySelector<HTMLSelectElement>("#run-import-source-selector")!.value = source;
    (["sample", "gist", "file"] as const).forEach((candidate) => {
      this.root.querySelector<HTMLElement>(`#task-source-${candidate}`)!.hidden = candidate !== source;
    });
    this.root.querySelector<HTMLButtonElement>("#task-import-confirm")!.disabled = true;
    this.root.querySelector<HTMLButtonElement>("#task-import-append")!.disabled = true;
    this.renderPreview(null);
    this.setStatus("");
    if (source === "sample") void this.loadCatalogue();
  }

  private beginRequest(message: string) {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.preview = null;
    this.root.querySelector<HTMLButtonElement>("#task-import-confirm")!.disabled = true;
    this.setStatus(message, "loading");
    return controller;
  }

  private finishRequest(controller: AbortController) {
    if (this.abortController === controller) this.abortController = null;
  }

  private setStatus(message: string, state?: "loading" | "error" | "success") {
    const status = this.root.querySelector<HTMLElement>("#task-import-status")!;
    status.textContent = message;
    status.className = `task-import-status${state ? ` is-${state}` : ""}`;
    status.hidden = message.length === 0;
  }

  private async loadCatalogue() {
    if (this.catalogue) {
      this.renderCatalogue();
      return;
    }
    const controller = this.beginRequest("LOADING SAMPLE CATALOGUE");
    const catalogueStatus = this.root.querySelector<HTMLElement>("#catalogue-status")!;
    catalogueStatus.textContent = "LOADING CATALOGUE";
    catalogueStatus.className = "import-source-status is-loading";
    try {
      const response = await fetch("/task-catalogue.json", {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Sample catalogue could not be loaded (HTTP ${response.status})`);
      this.catalogue = normaliseTaskCatalogue(await response.json());
      if (controller.signal.aborted) return;
      this.renderCatalogue();
      this.setStatus("");
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Sample catalogue could not be loaded";
      catalogueStatus.textContent = message.toUpperCase();
      catalogueStatus.className = "import-source-status is-error";
      this.setStatus(message.toUpperCase(), "error");
    } finally {
      this.finishRequest(controller);
    }
  }

  private renderCatalogue() {
    const catalogue = this.catalogue;
    if (!catalogue) return;
    this.root.querySelector<HTMLElement>("#catalogue-status")!.textContent = `${catalogue.entries.length} VERIFIED SAMPLES`;
    this.root.querySelector<HTMLElement>("#catalogue-status")!.className = "import-source-status";
    this.root.querySelector<HTMLElement>("#task-catalogue-list")!.innerHTML = catalogue.entries.map((entry) => `
      <button type="button" class="task-sample-card" data-task-sample-id="${escapeHtml(entry.id)}">
        <span class="task-sample-card-heading"><b>${escapeHtml(entry.title)}</b><em>${escapeHtml(entry.category.toUpperCase())}</em></span>
        <span>${escapeHtml(entry.summary)}</span>
        <small>${entry.taskCount} TASK${entry.taskCount === 1 ? "" : "S"} / SPEC V${entry.taskSpecVersion}</small>
      </button>
    `).join("");
  }

  private async prepareCatalogueSample(id: string) {
    const entry = this.catalogue?.entries.find((candidate) => candidate.id === id);
    if (!entry) {
      this.setStatus("SAMPLE IS NOT IN THE CATALOGUE", "error");
      return;
    }
    const controller = this.beginRequest(`LOADING ${entry.title.toUpperCase()}`);
    try {
      const preview = await loadCatalogueImport(
        entry,
        this.readConfiguration(),
        fetch,
        controller.signal,
      );
      if (!controller.signal.aborted) this.setPreview(preview);
    } catch (error) {
      if (!controller.signal.aborted) this.reportError(error);
    } finally {
      this.finishRequest(controller);
    }
  }

  private async prepareGist() {
    const reference = this.root.querySelector<HTMLInputElement>("#task-gist-reference")!.value;
    const controller = this.beginRequest("FETCHING PUBLIC GIST");
    this.gistCandidates = [];
    this.root.querySelector<HTMLElement>("#task-gist-file-field")!.hidden = true;
    try {
      const candidates = await loadGistImportCandidates(
        reference,
        this.readConfiguration(),
        fetch,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      this.gistCandidates = candidates;
      if (candidates.length === 1) {
        this.setPreview(candidates[0].preview);
        return;
      }
      const field = this.root.querySelector<HTMLElement>("#task-gist-file-field")!;
      const select = this.root.querySelector<HTMLSelectElement>("#task-gist-file")!;
      select.innerHTML = `<option value="">SELECT FILE</option>${candidates.map((candidate, index) => `<option value="${index}">${escapeHtml(candidate.fileName)}</option>`).join("")}`;
      field.hidden = false;
      select.focus();
      this.setStatus(`${candidates.length} VALID FILES FOUND / SELECT ONE`);
    } catch (error) {
      if (!controller.signal.aborted) this.reportError(error);
    } finally {
      this.finishRequest(controller);
    }
  }

  private async prepareLocalFile(file?: File) {
    if (!file) {
      this.setStatus("SELECT A LOCAL JSON FILE", "error");
      return;
    }
    this.root.querySelector<HTMLElement>("#task-local-file-name")!.textContent = file.name.toUpperCase();
    const controller = this.beginRequest(`READING ${file.name.toUpperCase()}`);
    try {
      if (file.size > TASK_IMPORT_MAX_BYTES) throw new Error("The task file is larger than 1 MB");
      const preview = await parseTaskImportText(
        await file.text(),
        this.readConfiguration(),
        {
          sourceLabel: "Local file",
          fileName: file.name,
        },
      );
      if (!controller.signal.aborted) this.setPreview(preview);
    } catch (error) {
      if (!controller.signal.aborted) this.reportError(error);
    } finally {
      this.finishRequest(controller);
    }
  }

  private reportError(error: unknown) {
    this.preview = null;
    this.root.querySelector<HTMLButtonElement>("#task-import-confirm")!.disabled = true;
    this.root.querySelector<HTMLButtonElement>("#task-import-append")!.disabled = true;
    const message = error instanceof Error ? error.message : "Task source could not be loaded";
    this.setStatus(message.toUpperCase(), "error");
    this.root.querySelector<HTMLElement>("#task-import-preview")!.innerHTML = `
      <div class="task-import-empty is-error"><span>PREVIEW FAILED</span><small>${escapeHtml(message)}</small></div>
    `;
  }

  private setPreview(preview: TaskImportPreview | null) {
    this.preview = preview;
    const confirm = this.root.querySelector<HTMLButtonElement>("#task-import-confirm")!;
    const append = this.root.querySelector<HTMLButtonElement>("#task-import-append")!;
    confirm.disabled = !preview;
    append.disabled = !preview;
    if (!preview) {
      this.renderPreview(null);
      this.setStatus("");
      return;
    }
    this.renderPreview(preview);
    this.setStatus(
      preview.warnings.length > 0
        ? `${preview.warnings.length} IMPORT WARNING${preview.warnings.length === 1 ? "" : "S"}`
        : "",
      preview.warnings.length > 0 ? "error" : undefined,
    );
  }

  private renderPreview(preview: TaskImportPreview | null) {
    const host = this.root.querySelector<HTMLElement>("#task-import-preview")!;
    if (!preview) {
      host.innerHTML = `
        <div class="task-import-empty"><span>NO PREVIEW</span><small>Select a source to inspect it before importing.</small></div>
      `;
      return;
    }
    const specification = preview.specification;
    const warningMarkup = preview.warnings.length > 0
      ? `<ul class="task-import-warnings">${preview.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
      : "";
    const sourceMarkup = preview.sourceUrl
      ? `<a href="${escapeHtml(preview.sourceUrl)}" target="_blank" rel="noopener noreferrer">VIEW SOURCE</a>`
      : "";
    host.innerHTML = `
      <header>
        <div><span>${escapeHtml(preview.sourceLabel)}</span><b>${escapeHtml(specification.runTitle)}</b></div>
        ${sourceMarkup}
      </header>
      <dl>
        <div><dt>CYCLES</dt><dd>${specification.cycleCount}</dd></div>
        <div><dt>TASKS</dt><dd>${specification.tasks.length}</dd></div>
        <div><dt>FORMAT</dt><dd>${preview.format === "task-specification" ? `SPEC V${specification.version}` : "LEGACY RUN"}</dd></div>
      </dl>
      ${specification.runDescription ? `<p>${escapeHtml(specification.runDescription)}</p>` : ""}
      <ol>${specification.tasks.map((task, index) => {
        const metrics = task.type === "pause"
          ? `${task.durationS}S`
          : `${task.type === "timed" ? `${task.durationS}S / ` : ""}${task.repeatCount} REP / ${task.resetTimeS}S RESET`;
        return `<li><span class="task-import-task-index">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(task.label)}</b><span class="task-import-task-cue">${escapeHtml(task.instructions)}</span></div><small>${task.type.toUpperCase()} / ${metrics}</small></li>`;
      }).join("")}</ol>
      ${warningMarkup}
      <footer><span>SHA-256</span><code>${escapeHtml(preview.taskSpecHash)}</code></footer>
    `;
  }

  private confirm(mode: "replace" | "append" = "replace") {
    const preview = this.preview;
    if (!preview) return;
    const configuration = mode === "append"
      ? this.appendImportedTasks(preview.configuration)
      : preview.configuration;
    try {
      this.applyConfiguration(configuration);
    } catch (error) {
      this.reportError(error);
      return;
    }
    this.setStatus("");
    this.flashImportAction(mode);
  }

  private flashImportAction(mode: "replace" | "append") {
    if (this.feedbackTimer !== null) window.clearTimeout(this.feedbackTimer);
    const button = this.root.querySelector<HTMLButtonElement>(
      mode === "append" ? "#task-import-append" : "#task-import-confirm",
    )!;
    const label = mode === "append" ? "APPEND" : "IMPORT";
    button.textContent = mode === "append" ? "APPENDED" : "IMPORTED";
    button.classList.add("is-success");
    this.feedbackTimer = window.setTimeout(() => {
      this.feedbackTimer = null;
      button.textContent = label;
      button.classList.remove("is-success");
    }, 1_200);
  }

  requestClose() {
    if (this.hasUnsavedChanges() && !window.confirm("Apply unsaved run changes before closing?")) return;
    this.close();
  }

  private appendImportedTasks(imported: CaptureConfiguration) {
    const current = this.readConfiguration();
    const usedIds = new Set(current.tasks.map((task) => task.id));
    const tasks = imported.tasks.map((task) => {
      let id = task.id;
      while (usedIds.has(id)) id = `${task.id}-${crypto.randomUUID().slice(0, 8)}`;
      usedIds.add(id);
      return { ...task, id };
    });
    return { ...current, tasks: [...current.tasks, ...tasks] };
  }
}
