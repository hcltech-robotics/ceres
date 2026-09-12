import {
  type CaptureConfiguration,
  type RepetitionPlan,
  type TaskDefinition,
} from "../shared/protocol.js";
import { MINIMUM_TASK_RESET_SECONDS } from "../shared/run-sequencing.js";
import {
  ArrowDown,
  ArrowUp,
  CircleDot,
  GripVertical,
  createIcons,
} from "lucide";
import { RunDraftController } from "./run-draft-controller.js";

const escapeHtml = (value: string) => value.replace(
  /[&<>"]/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]!,
);

export interface RunEditorOptions {
  root: HTMLElement;
  configuration: CaptureConfiguration;
  selectedStartTaskId?: string | null;
  onConfigurationChange: (configuration: CaptureConfiguration) => void;
  onStartTaskSelection?: (taskId: string) => void;
  onSave?: (configuration: CaptureConfiguration) => void;
  onActivity?: (message: string) => void;
}

export class RunEditor {
  private readonly root: HTMLElement;
  private readonly onConfigurationChange: RunEditorOptions["onConfigurationChange"];
  private readonly onStartTaskSelection: RunEditorOptions["onStartTaskSelection"];
  private readonly onSave: RunEditorOptions["onSave"];
  private readonly onActivity: NonNullable<RunEditorOptions["onActivity"]>;
  private readonly draft: RunDraftController;
  private draggedTaskId: string | null = null;
  private disposed = false;

  constructor(options: RunEditorOptions) {
    this.root = options.root;
    this.draft = new RunDraftController(options.configuration, options.selectedStartTaskId ?? null);
    this.onConfigurationChange = options.onConfigurationChange;
    this.onStartTaskSelection = options.onStartTaskSelection;
    this.onSave = options.onSave;
    this.onActivity = options.onActivity ?? (() => undefined);
  }

  mount() {
    if (this.disposed) throw new Error("A disposed run editor cannot be mounted");
    this.root.innerHTML = `
      <div id="run-editor-fields" class="run-editor-fields setup-details run-inspector">
        <div class="run-metadata">
          <div class="run-metadata-primary">
            <label>TITLE<input id="run-title" type="text" autocomplete="off"></label>
            <label class="run-cycles">TOTAL CYCLES<input id="run-total-cycles" type="number" min="1" step="1"></label>
          </div>
          <label>DESCRIPTION<textarea id="run-description" rows="2"></textarea></label>
        </div>
        <div class="task-list-heading">
          <span>TASKS</span>
          <span id="task-lock-indicator" class="task-lock-indicator" role="status" hidden>
            <span class="sr-only">Task list locked while run is active</span>
          </span>
        </div>
        <div id="task-slices" class="task-slices" role="list" aria-label="Run task list"></div>
        <div class="task-actions task-editor-actions">
          <button id="add-task" class="toolbar-button" type="button">ADD</button>
          <button id="delete-task" class="toolbar-button toolbar-danger" type="button" disabled>DELETE</button>
          <button id="save-draft" class="toolbar-button" type="button">SAVE</button>
        </div>
        <details id="run-recording-metadata" class="run-recording-metadata">
          <summary><span>RECORDING METADATA</span><small>OPTIONAL</small></summary>
          <div class="run-recording-metadata-content">
            <div class="run-recording-metadata-grid">
              <label>HEADSET ID<input id="capture-headset-id" type="text" maxlength="128" autocomplete="off" placeholder="Study asset ID"></label>
              <label>DEMONSTRATOR ID<input id="capture-demonstrator-id" type="text" maxlength="128" autocomplete="off" placeholder="Generated when blank"></label>
              <label>PROJECT ID<input id="capture-project-id" type="text" maxlength="128" autocomplete="off"></label>
              <label>CONSENT DATE<input id="capture-consent-date" type="date"></label>
              <label class="run-consent-document-id">CONSENT DOCUMENT ID<input id="capture-consent-document-id" type="text" maxlength="256" autocomplete="off"></label>
            </div>
          </div>
        </details>
      </div>
    `;
    this.root.querySelector<HTMLInputElement>("#run-title")!.addEventListener("input", () => this.commitMetadata());
    this.root.querySelector<HTMLTextAreaElement>("#run-description")!.addEventListener("input", () => this.commitMetadata());
    this.root.querySelector<HTMLInputElement>("#run-total-cycles")!.addEventListener("input", () => this.commitMetadata());
    this.root.querySelectorAll<HTMLInputElement>(
      "#capture-headset-id, #capture-demonstrator-id, #capture-project-id, #capture-consent-date, #capture-consent-document-id",
    ).forEach((input) => input.addEventListener(input.type === "date" ? "change" : "input", () => this.commitStudyMetadata()));
    this.root.querySelector<HTMLButtonElement>("#add-task")!.addEventListener("click", () => this.addTask());
    this.root.querySelector<HTMLButtonElement>("#delete-task")!.addEventListener("click", () => this.deleteFocusedTask());
    this.root.querySelector<HTMLButtonElement>("#save-draft")!.addEventListener("click", () => this.save());
    this.render();
  }

  dispose() {
    this.disposed = true;
    this.root.replaceChildren();
  }

  readConfiguration() {
    return this.draft.readConfiguration();
  }

  applyConfiguration(configuration: CaptureConfiguration, notify = true) {
    this.draft.applyConfiguration(configuration);
    this.render();
    if (notify) this.emitConfiguration();
  }

  setSelectedStartTask(taskId: string | null) {
    if (this.draft.snapshot.selectedStartTaskId === taskId) return;
    this.draft.setSelectedStartTask(taskId);
    this.renderTaskList();
  }

  setLocked(locked: boolean) {
    if (this.draft.snapshot.locked !== locked) this.draft.setLocked(locked);
    this.root.dataset.locked = String(locked);
    const lock = this.root.querySelector<HTMLElement>("#task-lock-indicator");
    if (lock) lock.hidden = !locked;
    this.root.querySelector("#task-slices")?.classList.toggle("is-locked", locked);
    this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      "input, textarea, select, button",
    ).forEach((control) => {
      control.disabled = locked && control.id !== "save-draft";
    });
    this.updateTaskActionAvailability();
  }

  private render() {
    const { configuration, locked } = this.draft.snapshot;
    this.root.querySelector<HTMLInputElement>("#run-title")!.value = configuration.runTitle;
    this.root.querySelector<HTMLTextAreaElement>("#run-description")!.value = configuration.runDescription;
    this.root.querySelector<HTMLInputElement>("#run-total-cycles")!.value = String(configuration.totalCycles);
    this.root.querySelector<HTMLInputElement>("#capture-headset-id")!.value = configuration.studyMetadata.headsetId;
    this.root.querySelector<HTMLInputElement>("#capture-demonstrator-id")!.value = configuration.studyMetadata.demonstratorId;
    this.root.querySelector<HTMLInputElement>("#capture-project-id")!.value = configuration.studyMetadata.projectId;
    this.root.querySelector<HTMLInputElement>("#capture-consent-date")!.value = configuration.studyMetadata.consentDate;
    this.root.querySelector<HTMLInputElement>("#capture-consent-document-id")!.value = configuration.studyMetadata.consentDocumentId;
    this.renderTaskList();
    this.setLocked(locked);
  }

  private renderTaskList() {
    const list = this.root.querySelector<HTMLElement>("#task-slices");
    if (!list) return;
    const { configuration, selectedStartTaskId, focusedTaskId } = this.draft.snapshot;
    list.innerHTML = configuration.tasks.map((task, index) => {
      const selectedForStart = task.id === selectedStartTaskId;
      const focused = task.id === focusedTaskId;
      const kind = task.type === "timed" ? "TIMED" : task.type === "open" ? "OPEN" : "PAUSE";
      const controls = task.type === "pause"
        ? `<label class="task-metric"><span>DUR</span><input class="task-duration" type="number" min="0" step="1" value="${task.durationS}" aria-label="Pause duration in seconds"></label>`
        : `${task.type === "timed" ? `<label class="task-metric"><span>DUR</span><input class="task-duration" type="number" min="0" step="1" value="${task.durationS}" aria-label="Task duration in seconds"></label>` : ""}<label class="task-metric"><span>REP</span><input class="task-repeat-count" type="number" min="1" step="1" value="${Math.max(1, task.repeatCount)}" aria-label="Repetitions"></label><label class="task-metric"><span>RST</span><input class="task-reset-time" type="number" min="${MINIMUM_TASK_RESET_SECONDS}" step="1" value="${task.resetTimeS}" aria-label="Task reset in seconds"></label>`;
      return `
        <article class="task-slice task-slice-${task.type}${focused ? " is-selected" : ""}${selectedForStart ? " is-start" : ""}" draggable="true" role="listitem" tabindex="${focused || (!focusedTaskId && index === 0) ? 0 : -1}" aria-current="${focused}" aria-label="${escapeHtml(task.label)}, ${kind.toLowerCase()} task" aria-keyshortcuts="ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown Delete" data-index="${index}" data-task-id="${escapeHtml(task.id)}" data-type="${task.type}">
          <button class="task-grip" type="button" draggable="true" aria-label="Drag ${escapeHtml(task.label)}" tabindex="-1"><i data-lucide="grip-vertical" aria-hidden="true"></i></button>
          <div class="task-slice-main">
            <input class="task-label" value="${escapeHtml(task.label)}" aria-label="Task ${index + 1} name">
            <textarea class="task-cue" rows="2" aria-label="Cue for ${escapeHtml(task.label)}">${escapeHtml(task.instructions.trim())}</textarea>
          </div>
          <select class="task-type" aria-label="Type for ${escapeHtml(task.label)}">
            <option value="timed"${task.type === "timed" ? " selected" : ""}>TIMED</option>
            <option value="open"${task.type === "open" ? " selected" : ""}>OPEN</option>
            <option value="pause"${task.type === "pause" ? " selected" : ""}>PAUSE</option>
          </select>
          <div class="task-slice-controls">${controls}</div>
          <div class="task-row-actions" aria-label="Order and start controls for ${escapeHtml(task.label)}">
            <button class="task-row-action task-move" data-move="-1" type="button" aria-label="Move ${escapeHtml(task.label)} up"><i data-lucide="arrow-up" aria-hidden="true"></i></button>
            <button class="task-row-action task-start" type="button" aria-label="${this.onStartTaskSelection ? `Start with ${escapeHtml(task.label)}` : `Select ${escapeHtml(task.label)}`}" aria-pressed="${this.onStartTaskSelection ? selectedForStart : focused}"><i data-lucide="circle-dot" aria-hidden="true"></i></button>
            <button class="task-row-action task-move" data-move="1" type="button" aria-label="Move ${escapeHtml(task.label)} down"><i data-lucide="arrow-down" aria-hidden="true"></i></button>
          </div>
        </article>
      `;
    }).join("");
    createIcons({
      icons: { ArrowDown, ArrowUp, CircleDot, GripVertical },
      root: list,
    });
    this.wireTaskList();
    this.updateTaskActionAvailability();
  }

  private wireTaskList() {
    const list = this.root.querySelector<HTMLElement>("#task-slices")!;
    list.querySelectorAll<HTMLElement>(".task-slice").forEach((slice) => {
      const taskId = slice.dataset.taskId!;
      const focus = () => this.focusTask(taskId);
      slice.addEventListener("pointerdown", (event) => {
        if (!(event.target as HTMLElement).closest(".task-row-action")) focus();
      });
      slice.addEventListener("focus", focus);
      slice.addEventListener("keydown", (event) => {
        if (event.target !== slice) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const direction = event.key === "ArrowUp" ? -1 : 1;
          if (event.altKey) this.moveTask(taskId, direction);
          else this.focusAdjacentTask(slice, direction);
          event.preventDefault();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          this.deleteFocusedTask();
          event.preventDefault();
        }
      });
      slice.querySelector<HTMLElement>(".task-grip")!.addEventListener("pointerdown", () => {
        this.draggedTaskId = taskId;
        focus();
      });
      slice.addEventListener("dragstart", (event) => {
        this.draggedTaskId = taskId;
        focus();
        event.dataTransfer?.setData("text/plain", taskId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      slice.addEventListener("dragend", () => {
        this.draggedTaskId = null;
      });
      slice.addEventListener("dragover", (event) => event.preventDefault());
      slice.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!this.draggedTaskId || this.draggedTaskId === taskId) return;
        const tasks = this.draft.snapshot.configuration.tasks;
        const from = tasks.findIndex(({ id }) => id === this.draggedTaskId);
        const to = tasks.findIndex(({ id }) => id === taskId);
        this.draggedTaskId = null;
        if (from < 0 || to < 0 || from === to) return;
        this.moveTask(tasks[from]!.id, to - from);
      });
      slice.querySelector<HTMLButtonElement>(".task-start")!.addEventListener("click", () => {
        if (this.draft.snapshot.locked) return;
        focus();
        if (!this.onStartTaskSelection) return;
        this.draft.selectStartTask(taskId);
        this.renderTaskList();
        this.onStartTaskSelection(taskId);
      });
      slice.querySelector<HTMLSelectElement>(".task-type")!.addEventListener("change", (event) => {
        const type = (event.currentTarget as HTMLSelectElement).value as TaskDefinition["type"];
        this.draft.convertTaskType(taskId, type);
        this.renderTaskList();
        this.renderedTask(taskId)?.querySelector<HTMLSelectElement>(".task-type")?.focus({
          preventScroll: true,
        });
        this.emitConfiguration();
      });
      slice.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        ".task-label, .task-cue, .task-duration, .task-repeat-count, .task-reset-time",
      ).forEach((input) => input.addEventListener("input", () => {
        this.updateTask(taskId, (task) => this.readTaskSlice(slice, task), false);
      }));
      slice.querySelectorAll<HTMLButtonElement>(".task-move").forEach((button) => {
        button.addEventListener("click", () => this.moveTask(taskId, Number(button.dataset.move)));
      });
    });
  }

  private focusAdjacentTask(slice: HTMLElement, offset: number) {
    const tasks = [...this.root.querySelectorAll<HTMLElement>("#task-slices > .task-slice")];
    const target = tasks[tasks.indexOf(slice) + offset];
    target?.focus();
  }

  private renderedTask(taskId: string) {
    return [...this.root.querySelectorAll<HTMLElement>("#task-slices > .task-slice")]
      .find((slice) => slice.dataset.taskId === taskId);
  }

  private focusTask(taskId: string) {
    this.draft.focusTask(taskId);
    this.root.querySelectorAll<HTMLElement>(".task-slice").forEach((candidate) => {
      const focused = candidate.dataset.taskId === taskId;
      candidate.classList.toggle("is-selected", focused);
      candidate.setAttribute("aria-current", String(focused));
      candidate.tabIndex = focused ? 0 : -1;
      if (!this.onStartTaskSelection) {
        candidate.querySelector(".task-start")?.setAttribute("aria-pressed", String(focused));
      }
    });
    this.updateTaskActionAvailability();
  }

  private commitMetadata() {
    if (this.draft.snapshot.locked) return;
    this.draft.setMetadata({
      runTitle: this.root.querySelector<HTMLInputElement>("#run-title")!.value,
      runDescription: this.root.querySelector<HTMLTextAreaElement>("#run-description")!.value.trim(),
      totalCycles: Math.max(
        1,
        Math.trunc(Number(this.root.querySelector<HTMLInputElement>("#run-total-cycles")!.value) || 1),
      ),
    });
    this.emitConfiguration();
  }

  private commitStudyMetadata() {
    if (this.draft.snapshot.locked) return;
    this.draft.setStudyMetadata({
      headsetId: this.root.querySelector<HTMLInputElement>("#capture-headset-id")!.value,
      demonstratorId: this.root.querySelector<HTMLInputElement>("#capture-demonstrator-id")!.value,
      projectId: this.root.querySelector<HTMLInputElement>("#capture-project-id")!.value,
      consentDate: this.root.querySelector<HTMLInputElement>("#capture-consent-date")!.value,
      consentDocumentId: this.root.querySelector<HTMLInputElement>("#capture-consent-document-id")!.value,
    });
    this.emitConfiguration();
  }

  private updateTask(taskId: string, update: (task: TaskDefinition) => TaskDefinition, rerender = true) {
    if (this.draft.snapshot.locked) return;
    this.draft.updateTask(taskId, update);
    if (rerender) this.renderTaskList();
    this.emitConfiguration();
  }

  private readTaskSlice(slice: HTMLElement, fallback: TaskDefinition): TaskDefinition {
    const identity = {
      id: fallback.id,
      label: slice.querySelector<HTMLInputElement>(".task-label")!.value.trim() || fallback.label,
      instructions: slice.querySelector<HTMLTextAreaElement>(".task-cue")!.value.trim() || "--",
    };
    const type = slice.querySelector<HTMLSelectElement>(".task-type")!.value as TaskDefinition["type"];
    if (type === "pause") return {
      ...identity,
      type,
      durationS: Math.max(0, Number(slice.querySelector<HTMLInputElement>(".task-duration")?.value) || 0),
    };
    const repetition: RepetitionPlan = {
      repeatCount: Math.max(
        1,
        Math.trunc(Number(slice.querySelector<HTMLInputElement>(".task-repeat-count")?.value) || 1),
      ),
      resetTimeS: Math.max(
        MINIMUM_TASK_RESET_SECONDS,
        Number(slice.querySelector<HTMLInputElement>(".task-reset-time")?.value) || MINIMUM_TASK_RESET_SECONDS,
      ),
    };
    if (type === "open") return { ...identity, ...repetition, type };
    return {
      ...identity,
      ...repetition,
      type: "timed",
      durationS: Math.max(0, Number(slice.querySelector<HTMLInputElement>(".task-duration")?.value) || 0),
    };
  }

  private addTask() {
    if (this.draft.snapshot.locked) return;
    this.draft.addTask();
    this.renderTaskList();
    this.emitConfiguration();
  }

  private deleteFocusedTask() {
    if (this.draft.snapshot.locked || !this.draft.snapshot.focusedTaskId) return;
    const deletedTaskId = this.draft.deleteFocusedTask();
    if (!deletedTaskId) return;
    this.renderTaskList();
    this.emitConfiguration();
    this.onActivity("Task deleted");
  }

  private moveTask(taskId: string, offset: number) {
    if (this.draft.snapshot.locked) return;
    const currentIndex = this.draft.snapshot.configuration.tasks.findIndex((task) => task.id === taskId);
    const destination = this.draft.moveTask(taskId, offset);
    if (destination === currentIndex) return;
    this.renderTaskList();
    this.renderedTask(taskId)?.focus({ preventScroll: true });
    this.emitConfiguration();
    this.onActivity(`Task moved to position ${destination + 1}`);
  }

  private updateTaskActionAvailability() {
    const { configuration, focusedTaskId, locked } = this.draft.snapshot;
    this.root.querySelectorAll<HTMLElement>(".task-slice").forEach((slice) => {
      const index = Number(slice.dataset.index);
      slice.querySelectorAll<HTMLButtonElement>(".task-move").forEach((button) => {
        const offset = Number(button.dataset.move);
        button.disabled = locked || index + offset < 0 || index + offset >= configuration.tasks.length;
      });
      const start = slice.querySelector<HTMLButtonElement>(".task-start");
      if (start) start.disabled = locked;
    });
    const deleteButton = this.root.querySelector<HTMLButtonElement>("#delete-task");
    if (deleteButton) deleteButton.disabled = locked || !focusedTaskId;
  }

  private emitConfiguration() {
    this.onConfigurationChange(this.draft.readConfiguration());
  }

  private save() {
    const configuration = this.draft.readConfiguration();
    if (this.onSave) {
      this.onSave(configuration);
      return;
    }
    const serialised = JSON.stringify({
      schema: "ceres-run-v5",
      configuration,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([serialised], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ceres-run.json";
    link.click();
    URL.revokeObjectURL(url);
    this.onActivity("Run file saved");
  }
}
