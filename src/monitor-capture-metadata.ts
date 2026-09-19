import type { CaptureMetadataValue } from "../shared/capture-metadata.js";
import type { CaptureConfiguration, Episode, SessionSnapshot } from "../shared/protocol.js";

export interface CaptureMetadataInput {
  sessionId: string;
  snapshot: SessionSnapshot | null;
  configuration?: CaptureConfiguration;
  episode?: Episode | null;
  canEdit?: boolean;
  onEdit?: (field: CaptureMetadataEditableField, value: string) => void;
}

export type CaptureMetadataEditableField = "projectId" | "demonstratorId";

export interface CaptureMetadataFact {
  label: string;
  value: string;
  field?: CaptureMetadataEditableField;
}

export interface CaptureMetadataPresentation {
  context: "Live capture" | "Selected capture";
  task: string;
  instructions: string;
  position: CaptureMetadataFact[];
  metadata: CaptureMetadataFact[];
  recording: CaptureMetadataFact[];
}

interface MetadataRenderState {
  input: CaptureMetadataInput;
  signature: string | null;
  editing: HTMLInputElement | null;
}

const renderedMetadata = new WeakMap<HTMLElement, MetadataRenderState>();

export function captureMetadataPresentation(input: CaptureMetadataInput): CaptureMetadataPresentation {
  const { snapshot } = input;
  const configuration = input.configuration ?? snapshot?.configuration;
  const selected = input.episode ?? null;
  const active = snapshot?.currentEpisode ?? snapshot?.pendingEpisode ?? null;
  const episode = selected ?? active;
  const frozen = selected?.captureMetadata;
  const status = snapshot?.captureStatus;
  const taskIndex = selected
    ? selected.taskSpecification?.tasks.findIndex((item) => item.id === selected.taskId) ?? -1
    : snapshot?.run.activeTaskIndex ?? snapshot?.activeTaskIndex ?? 0;
  const tasks = selected ? selected.taskSpecification?.tasks : configuration?.tasks;
  const task = tasks?.[taskIndex];
  const study = selected ? frozen?.study : configuration?.studyMetadata;
  const headsetModel = selected ? knownValue(frozen?.device.headsetModel) : status?.headsetModel;
  const rate = selected ? knownValue(frozen?.recorder.rateHz) : configuration?.recorderRateHz;
  const width = selected ? knownValue(frozen?.camera.width) : status?.selectedCameraWidth;
  const height = selected ? knownValue(frozen?.camera.height) : status?.selectedCameraHeight;
  const metadata: CaptureMetadataFact[] = [
    fact("Session", input.sessionId),
    fact("Run", selected ? selected.runTitle : configuration?.runTitle),
  ];
  if (selected) metadata.push(fact("Capture ID", selected.id));
  metadata.push(
    fact("Project", study?.projectId, "projectId"),
    fact("Demonstrator", study?.demonstratorId, "demonstratorId"),
    fact("Headset", [text(study?.headsetId), text(headsetModel)].filter(Boolean).join("/")),
    fact("Started", displayTimestamp(episode?.startedAt ?? snapshot?.startedAt)),
  );
  if (selected?.taskSpecHash) metadata.push(fact("Task specification", selected.taskSpecHash));

  const cycleCount = selected ? selected.taskSpecification?.cycleCount : configuration?.totalCycles;
  const cycle = selected ? selected.cycle : snapshot?.run.cycle ?? (configuration ? 1 : undefined);
  const repetition = selected ? selected.repetition : snapshot?.run.repetition ?? (task ? 1 : undefined);
  const position = [
    fact("Cycle", positionValue(cycle, cycleCount)),
    fact("Task", positionValue(taskIndex >= 0 && task ? taskIndex + 1 : undefined, tasks?.length)),
    fact("Rep", task?.type === "pause" ? "--" : positionValue(repetition, task?.repeatCount)),
  ];
  const recording: CaptureMetadataFact[] = [];
  if (episode) {
    recording.push(
      fact("Attempt", count(selected ? selected.take : snapshot?.run.take)),
      fact("Outcome", episode.annotation ?? episode.outcome),
    );
  }
  const duration = episodeDurationSeconds(episode, rate, selected ? null : snapshot);
  recording.push(
    fact("Frames", count(episode?.frameCount)),
    fact("Duration", duration === null ? null : `${duration.toFixed(2)} s`),
    fact("Frame rate", positive(rate) ? `${rate} Hz` : null),
    fact("Video", positive(width) && positive(height) ? `${width} x ${height}` : null),
    fact("Source gaps", count(episode?.gapCount ?? episode?.qualitySummary.gapCount)),
  );

  return {
    context: selected ? "Selected capture" : "Live capture",
    task: text(selected ? selected.taskLabel : task?.label) || "No task",
    instructions: text(selected ? selected.taskDescription : task?.instructions),
    position,
    metadata,
    recording,
  };
}

export function renderCaptureMetadata(container: HTMLElement, input: CaptureMetadataInput): void {
  let state = renderedMetadata.get(container);
  if (!state) {
    state = { input, signature: null, editing: null };
    renderedMetadata.set(container, state);
  }
  state.input = input;
  const editable = canEditMetadata(input);
  if (state.editing && editable) return;
  state.editing = null;
  const presentation = captureMetadataPresentation(input);
  const signature = JSON.stringify({ presentation, editable });
  if (state.signature === signature) return;
  state.signature = signature;

  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();
  const heading = document.createElement("h3");
  heading.className = "capture-metadata-heading";
  heading.textContent = "Capture metadata";
  fragment.append(heading);
  const context = document.createElement("span");
  context.className = "capture-metadata-context";
  context.textContent = presentation.context;
  fragment.append(context);

  const task = document.createElement("section");
  task.className = "capture-metadata-group capture-metadata-task";
  const taskHeading = document.createElement("h4");
  taskHeading.textContent = "Current task";
  const label = document.createElement("strong");
  label.textContent = presentation.task;
  const position = document.createElement("dl");
  position.className = "capture-metadata-position";
  position.setAttribute("aria-label", "Cycle, task and repetition");
  for (const item of presentation.position) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = item.label;
    const value = document.createElement("dd");
    value.textContent = item.value;
    row.append(term, value);
    position.append(row);
  }
  task.append(taskHeading, position, label);
  if (presentation.instructions) {
    const instructions = document.createElement("p");
    instructions.textContent = presentation.instructions;
    instructions.title = presentation.instructions;
    task.append(instructions);
  }
  fragment.append(task);
  for (const [title, facts] of [["Metadata", presentation.metadata], ["Recording facts", presentation.recording]] as const) {
    const section = document.createElement("section");
    section.className = "capture-metadata-group";
    const sectionHeading = document.createElement("h4");
    sectionHeading.textContent = title;
    const list = document.createElement("dl");
    for (const item of facts) {
      const row = document.createElement("div");
      row.className = "capture-metadata-fact";
      const term = document.createElement("dt");
      term.textContent = item.label;
      const value = document.createElement("dd");
      if (editable && item.field) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "capture-metadata-edit";
        button.dataset.field = item.field;
        button.setAttribute("aria-label", `Edit ${item.label.toLowerCase()}`);
        button.textContent = item.value;
        button.title = `Click to edit ${item.label.toLowerCase()}`;
        button.addEventListener("click", () => editMetadata(container, item.field!, item.label, value));
        value.append(button);
      } else {
        value.textContent = item.value;
        value.title = item.value;
      }
      row.append(term, value);
      list.append(row);
    }
    section.append(sectionHeading, list);
    fragment.append(section);
  }
  container.classList.add("capture-metadata");
  container.replaceChildren(fragment);
}

function canEditMetadata(input: CaptureMetadataInput): boolean {
  return Boolean(input.onEdit)
    && input.canEdit !== false
    && !input.episode
    && input.snapshot?.run.status !== "running"
    && (!input.snapshot || input.snapshot.run.recordingState === "idle");
}

function editMetadata(
  container: HTMLElement,
  field: CaptureMetadataEditableField,
  label: string,
  target: HTMLElement,
): void {
  const state = renderedMetadata.get(container);
  if (!state || !canEditMetadata(state.input)) return;
  const input = container.ownerDocument.createElement("input");
  input.type = "text";
  input.className = "capture-metadata-input";
  input.maxLength = 128;
  input.setAttribute("aria-label", label);
  const configuration = state.input.configuration ?? state.input.snapshot?.configuration;
  input.value = configuration?.studyMetadata[field] ?? "";
  state.editing = input;
  const finish = (save: boolean, restoreFocus = false) => {
    if (state.editing !== input) return;
    state.editing = null;
    try {
      const value = input.value.trim().slice(0, input.maxLength);
      if (save && canEditMetadata(state.input) && value !== (configuration?.studyMetadata[field] ?? "")) {
        state.input.onEdit?.(field, value);
      }
    } finally {
      state.signature = null;
      renderCaptureMetadata(container, state.input);
      if (restoreFocus) container.querySelector<HTMLButtonElement>(`[data-field="${field}"]`)?.focus();
    }
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    finish(event.key === "Enter", true);
  });
  target.replaceChildren(input);
  input.focus();
  input.select();
}

function knownValue<T>(value: CaptureMetadataValue<T> | undefined): T | undefined {
  return value?.availability === "known" ? value.value : undefined;
}

function fact(label: string, value: string | null | undefined, field?: CaptureMetadataEditableField): CaptureMetadataFact {
  return { label, value: text(value) || "--", ...(field ? { field } : {}) };
}

function positionValue(value: number | undefined, total?: number): string | null {
  return positive(value) ? `${value}${positive(total) ? `/${total}` : ""}` : null;
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function count(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-GB")
    : null;
}

function displayTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace("T", " ")} UTC` : null;
}

function episodeDurationSeconds(
  episode: Episode | null,
  rate: number | undefined,
  snapshot: SessionSnapshot | null,
): number | null {
  if (!episode) return null;
  if (Number.isSafeInteger(episode.recorderSlotCount) && episode.recorderSlotCount! >= 0 && positive(rate)) {
    return episode.recorderSlotCount! / rate;
  }
  if (!episode.endedAt && snapshot && snapshot.run.recordingElapsedMs >= 0) {
    return snapshot.run.recordingElapsedMs / 1_000;
  }
  const start = Date.parse(episode.startedAt);
  const end = Date.parse(episode.endedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1_000 : null;
}
