import type {
  CaptureConfiguration,
  Episode,
  SessionSnapshot,
  TaskDefinition,
} from "../shared/protocol.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import { MINIMUM_TASK_RESET_SECONDS } from "../shared/run-sequencing.js";
import type { DirectRunControlAction } from "./direct-session-reducer.js";
import {
  RunDraftController,
  type RunDraftTaskProperties,
} from "./run-draft-controller.js";
import type { XrHudStatusIcon } from "./xr-hud-icons.js";

export type SoloXrConsolePage = "run" | "tasks" | "import" | "episodes" | "export";

export type SoloXrDraftNumericField =
  | "total-cycles"
  | "recorder-rate-hz"
  | "duration-s"
  | "repeat-count"
  | "reset-time-s";

export type SoloXrDraftTextField = "run-title" | "run-description" | "task-label" | "task-instructions";

export type SoloXrConsoleIntent =
  | { type: "navigate"; page: SoloXrConsolePage }
  | { type: "open-console" }
  | { type: "close-console" }
  | { type: "quit-xr" }
  | { type: "select-start-task"; taskId: string }
  | { type: "run-control"; action: DirectRunControlAction }
  | { type: "draft-focus-task"; taskId: string | null }
  | { type: "draft-add-task" }
  | { type: "draft-delete-focused-task" }
  | { type: "draft-move-task"; taskId: string; offset: -1 | 1 }
  | { type: "draft-convert-task"; taskId: string; taskType: TaskDefinition["type"] }
  | {
      type: "draft-save-task-properties";
      taskId: string;
      properties: RunDraftTaskProperties;
    }
  | {
      type: "draft-adjust-number";
      field: SoloXrDraftNumericField;
      delta: number;
      taskId?: string;
    }
  | {
      type: "draft-set-number";
      field: SoloXrDraftNumericField;
      value: string;
      taskId?: string;
    }
  | { type: "draft-set-text"; field: SoloXrDraftTextField; value: string; taskId?: string }
  | { type: "import-file" }
  | { type: "import-select-sample"; sampleId: string }
  | { type: "import-gist-change"; value: string }
  | { type: "import-fetch-gist" }
  | { type: "import-select-candidate"; candidateId: string }
  | { type: "import-preview" }
  | { type: "import-confirm" }
  | { type: "import-cancel" }
  | { type: "episode-select"; episodeId: string; selected: boolean }
  | { type: "episode-delete"; episodeId: string }
  | { type: "episode-delete-confirm"; episodeId: string }
  | { type: "episode-delete-cancel" }
  | { type: "export-local"; episodeIds: readonly string[] }
  | { type: "export-folder"; episodeIds: readonly string[] }
  | { type: "export-repository-change"; value: string }
  | { type: "export-branch-change"; value: string }
  | { type: "export-visibility-change"; visibility: "public" | "private" }
  | { type: "export-cancel" }
  | { type: "export-retry" }
  | { type: "hf-sign-in" }
  | { type: "hf-sign-out" }
  | { type: "hf-upload"; episodeIds: readonly string[] };

export interface SoloXrConsoleAccountPresentation {
  state: "unavailable" | "signed-out" | "signed-in";
  label: string;
  uploadEnabled: boolean;
  actionLabel?: string | null;
}

export interface SoloXrConsolePresentationOptions {
  page?: SoloXrConsolePage;
  focusedTaskId?: string | null;
  selectedEpisodeIds?: ReadonlySet<string>;
  account?: SoloXrConsoleAccountPresentation;
  importState?: SoloXrConsoleImportState;
  exportState?: SoloXrConsoleExportState;
  notice?: string | null;
  finalising?: boolean;
  sessionRecovery?: "new" | "restored" | "active";
  pendingDelete?: Readonly<{ episodeId: string; label: string }> | null;
}

export interface SoloXrConsoleImportChoice {
  id: string;
  label: string;
  detail: string;
}

export interface SoloXrConsoleImportState {
  stage: "choose" | "loading" | "preview" | "error";
  gist: string;
  samples: readonly SoloXrConsoleImportChoice[];
  selectedSampleId: string | null;
  candidates: readonly SoloXrConsoleImportChoice[];
  selectedCandidateId: string | null;
  previewLabel: string | null;
  preview: SoloXrConsoleImportPreview | null;
  message: string;
}

export interface SoloXrConsoleImportPreviewTask {
  id: string;
  type: TaskDefinition["type"];
  label: string;
  instructions: string;
  durationS: number | null;
  repeatCount: number | null;
  resetTimeS: number | null;
}

export interface SoloXrConsoleImportPreview {
  sourceLabel: string;
  fileName: string;
  runTitle: string;
  runDescription: string;
  cycleCount: number;
  taskSpecHash: string;
  warnings: readonly string[];
  tasks: readonly SoloXrConsoleImportPreviewTask[];
}

export interface SoloXrConsoleExportState {
  repository: string;
  branch: string;
  visibility: "public" | "private";
  state: "idle" | "preparing" | "uploading" | "completed" | "failed";
  progress: number | null;
  message: string;
  canCancel: boolean;
  canRetry: boolean;
  jobs: readonly SoloXrConsoleExportJob[];
}

export interface SoloXrConsoleExportJob {
  id: string;
  type: "export" | "upload";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  detail: string;
  updatedAt: string;
}

export interface SoloXrConsoleRow {
  id: string;
  primary: string;
  secondary: string;
  selected: boolean;
  enabled: boolean;
  control?: "button" | "checkbox";
  intent: SoloXrConsoleIntent | null;
}

export interface SoloXrConsoleAction {
  id: string;
  label: string;
  enabled: boolean;
  selected?: boolean;
  group?: "task-type" | "visibility";
  tone: "normal" | "primary" | "danger";
  intent: SoloXrConsoleIntent;
}

export interface SoloXrConsoleInput {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  multiline: boolean;
  slider?: Readonly<{
    min: number;
    max: number;
    step: number;
  }>;
  enabled?: boolean;
  onChange: (value: string) => SoloXrConsoleIntent;
}

export type SoloXrConsoleControl =
  | Readonly<{
      kind: "toggle";
      id: "visibility";
      label: string;
      checked: boolean;
      enabled: boolean;
      offLabel: string;
      onLabel: string;
      onChange: (checked: boolean) => SoloXrConsoleIntent;
    }>
  | Readonly<{
      kind: "radio";
      id: "task-type";
      label: string;
      value: TaskDefinition["type"];
      enabled: boolean;
      options: readonly Readonly<{
        value: TaskDefinition["type"];
        label: string;
      }>[];
      onChange: (value: TaskDefinition["type"]) => SoloXrConsoleIntent;
    }>
  | Readonly<{
      kind: "progress";
      id: "export-progress";
      label: string;
      value: number;
    }>;

export type SoloXrConsoleStatusTone = "muted" | "action" | "success" | "warning" | "danger";

export interface SoloXrConsoleStatusIndicator {
  icon: XrHudStatusIcon;
  state: string;
  label: string;
  tone: SoloXrConsoleStatusTone;
}

export interface SoloXrTaskPropertiesPresentation extends RunDraftTaskProperties {
  taskId: string;
}

export interface SoloXrConsolePresentation {
  page: SoloXrConsolePage;
  hint: string;
  identity: string;
  collapsed: boolean;
  statusIndicators: readonly SoloXrConsoleStatusIndicator[];
  rows: readonly SoloXrConsoleRow[];
  actions: readonly SoloXrConsoleAction[];
  inputs: readonly SoloXrConsoleInput[];
  controls: readonly SoloXrConsoleControl[];
  taskProperties: SoloXrTaskPropertiesPresentation | null;
}

const DEFAULT_ACCOUNT: SoloXrConsoleAccountPresentation = {
  state: "unavailable",
  label: "Account service unavailable",
  uploadEnabled: false,
  actionLabel: null,
};

const DEFAULT_IMPORT_STATE: SoloXrConsoleImportState = {
  stage: "choose",
  gist: "",
  samples: [],
  selectedSampleId: null,
  candidates: [],
  selectedCandidateId: null,
  previewLabel: null,
  preview: null,
  message: "Choose a sample, public Gist or local file",
};

const DEFAULT_EXPORT_STATE: SoloXrConsoleExportState = {
  repository: "",
  branch: "main",
  visibility: "private",
  state: "idle",
  progress: null,
  message: "Choose accepted episodes to export",
  canCancel: false,
  canRetry: false,
  jobs: [],
};

export function buildSoloXrConsolePresentation(
  snapshot: SessionSnapshot,
  options: SoloXrConsolePresentationOptions = {},
): SoloXrConsolePresentation {
  const page = options.page ?? "run";
  const selectedEpisodeIds = options.selectedEpisodeIds ?? new Set<string>();
  const collapsed = soloXrConsoleShouldCollapse(snapshot, options.finalising === true);
  const account = options.account ?? DEFAULT_ACCOUNT;
  const importState = options.importState ?? DEFAULT_IMPORT_STATE;
  const exportState = options.exportState ?? DEFAULT_EXPORT_STATE;
  const selectedStartTaskId = snapshot.solo?.selectedStartTaskId ?? null;
  const focusedTaskId = options.focusedTaskId ?? null;
  const rawTaskActions = collapsed
    ? []
    : actionsForPage(
      snapshot,
      page,
      focusedTaskId,
      selectedEpisodeIds,
      account,
      importState,
      exportState,
      options.pendingDelete ?? null,
    );
  const rows = rowsForPage(
    snapshot,
    page,
    selectedStartTaskId,
    focusedTaskId,
    selectedEpisodeIds,
    importState,
    exportState,
    account,
  );
  const actions = collapsed
    ? []
    : rawTaskActions;
  const inputs = collapsed
    ? []
    : inputsForPage(snapshot, page, focusedTaskId, importState, exportState);
  const controls = collapsed
    ? []
    : controlsForPage(snapshot, page, focusedTaskId, exportState);
  const taskProperties = collapsed
    ? null
    : taskPropertiesForPage(snapshot, page, focusedTaskId);
  const hint = pageHint(
    snapshot,
    page,
    importState,
    exportState,
  );
  const visibleHint = collapsed ? "Capture controls remain on the demonstrator HUD" : hint;
  return deepFreeze({
    page,
    hint: options.notice ? `${options.notice} / ${visibleHint}` : visibleHint,
    identity: sessionIdentity(snapshot.sessionId, options.sessionRecovery ?? "active"),
    collapsed,
    statusIndicators: statusIndicators(snapshot, options.finalising === true, exportState),
    rows,
    actions,
    inputs,
    controls,
    taskProperties,
  });
}

export function soloXrConsoleShouldCollapse(snapshot: SessionSnapshot, finalising = false) {
  return finalising
    || snapshot.run.status === "running"
    || snapshot.solo?.startCountdownDeadlineMs != null
    || snapshot.run.recordingState !== "idle"
    || snapshot.currentEpisode !== null
    || snapshot.pendingEpisode !== null;
}

export function applySoloXrDraftIntent(
  controller: RunDraftController,
  intent: Extract<
    SoloXrConsoleIntent,
    {
      type:
        | "draft-focus-task"
        | "draft-add-task"
        | "draft-delete-focused-task"
        | "draft-move-task"
        | "draft-convert-task"
        | "draft-save-task-properties"
        | "draft-adjust-number"
        | "draft-set-number"
        | "draft-set-text";
    }
  >,
): CaptureConfiguration {
  if (intent.type === "draft-focus-task") {
    controller.focusTask(intent.taskId);
    return controller.readConfiguration();
  }
  if (intent.type === "draft-add-task") {
    controller.addTask();
    return controller.readConfiguration();
  }
  if (intent.type === "draft-delete-focused-task") {
    controller.deleteFocusedTask();
    return controller.readConfiguration();
  }
  if (intent.type === "draft-move-task") {
    controller.moveTask(intent.taskId, intent.offset);
    return controller.readConfiguration();
  }
  if (intent.type === "draft-convert-task") {
    return controller.convertTaskType(intent.taskId, intent.taskType);
  }
  if (intent.type === "draft-save-task-properties") {
    return controller.setTaskProperties(intent.taskId, intent.properties);
  }
  const configuration = controller.readConfiguration();
  if (intent.type === "draft-set-text") {
    if (intent.field === "run-title" || intent.field === "run-description") {
      return controller.setMetadata({
        runTitle: intent.field === "run-title" ? intent.value : configuration.runTitle,
        runDescription: intent.field === "run-description" ? intent.value : configuration.runDescription,
        totalCycles: configuration.totalCycles,
      });
    }
    if (!intent.taskId) throw new Error("A task is required for this text edit");
    return controller.updateTask(intent.taskId, (task) => ({
      ...task,
      [intent.field === "task-label" ? "label" : "instructions"]: intent.value,
    }));
  }
  if (intent.type === "draft-set-number") {
    const value = Number(intent.value);
    if (!Number.isFinite(value)) return configuration;
    if (intent.field === "total-cycles") {
      return controller.setMetadata({
        runTitle: configuration.runTitle,
        runDescription: configuration.runDescription,
        totalCycles: Math.max(1, Math.round(value)),
      });
    }
    if (intent.field === "recorder-rate-hz") {
      return controller.applyConfiguration({
        ...configuration,
        recorderRateHz: Math.max(1, Math.min(1_000, Math.round(value))),
      });
    }
    if (!intent.taskId) throw new Error("A task is required for this run edit");
    const field = intent.field as Exclude<SoloXrDraftNumericField, "total-cycles" | "recorder-rate-hz">;
    return controller.updateTask(intent.taskId, (task) => setTaskNumber(task, field, value));
  }
  if (intent.field === "total-cycles") {
    return controller.setMetadata({
      runTitle: configuration.runTitle,
      runDescription: configuration.runDescription,
      totalCycles: configuration.totalCycles + intent.delta,
    });
  }
  if (intent.field === "recorder-rate-hz") {
    return controller.applyConfiguration({
      ...configuration,
      recorderRateHz: Math.max(1, Math.round(configuration.recorderRateHz + intent.delta)),
    });
  }
  if (intent.field !== "duration-s"
    && intent.field !== "repeat-count"
    && intent.field !== "reset-time-s") {
    throw new Error("The selected run edit is invalid");
  }
  if (!intent.taskId) throw new Error("A task is required for this run edit");
  const taskField: "duration-s" | "repeat-count" | "reset-time-s" = intent.field;
  return controller.updateTask(intent.taskId, (task) => adjustTaskNumber(task, taskField, intent.delta));
}

function adjustTaskNumber(
  task: TaskDefinition,
  field: Exclude<SoloXrDraftNumericField, "total-cycles" | "recorder-rate-hz">,
  delta: number,
): TaskDefinition {
  if (field === "duration-s") {
    if (task.type === "open") throw new Error("Open tasks do not have a duration");
    return { ...task, durationS: Math.max(0, task.durationS + delta) };
  }
  if (task.type === "pause") throw new Error("Pause tasks do not repeat");
  if (field === "repeat-count") {
    return { ...task, repeatCount: Math.max(1, Math.round(task.repeatCount + delta)) };
  }
  return {
    ...task,
    resetTimeS: Math.max(MINIMUM_TASK_RESET_SECONDS, task.resetTimeS + delta),
  };
}

function setTaskNumber(
  task: TaskDefinition,
  field: Exclude<SoloXrDraftNumericField, "total-cycles" | "recorder-rate-hz">,
  value: number,
): TaskDefinition {
  if (field === "duration-s") {
    if (task.type === "open") throw new Error("Open tasks do not have a duration");
    return { ...task, durationS: Math.max(0, value) };
  }
  if (task.type === "pause") throw new Error("Pause tasks do not repeat");
  if (field === "repeat-count") {
    return { ...task, repeatCount: Math.max(1, Math.round(value)) };
  }
  return {
    ...task,
    resetTimeS: Math.max(MINIMUM_TASK_RESET_SECONDS, value),
  };
}

function rowsForPage(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  selectedStartTaskId: string | null,
  focusedTaskId: string | null,
  selectedEpisodeIds: ReadonlySet<string>,
  importState: SoloXrConsoleImportState,
  exportState: SoloXrConsoleExportState,
  account: SoloXrConsoleAccountPresentation,
): SoloXrConsoleRow[] {
  if (page === "run" || page === "tasks") {
    const startSelectionAvailable = (snapshot.run.status === "stopped"
      || snapshot.run.status === "complete")
      && snapshot.run.recordingState === "idle"
      && snapshot.currentEpisode === null
      && snapshot.pendingEpisode === null
      && snapshot.sequenceReadiness.ready;
    return snapshot.configuration.tasks.map((task) => ({
        id: task.id,
        primary: task.label,
        secondary: taskSummary(task),
        selected: page === "run" ? task.id === selectedStartTaskId : task.id === focusedTaskId,
        enabled: page === "tasks"
          ? true
          : task.type !== "pause" && startSelectionAvailable,
        intent: page === "run"
          ? task.type === "pause"
            ? null
            : { type: "select-start-task", taskId: task.id }
          : { type: "draft-focus-task", taskId: task.id },
    }));
  }
  if (page === "episodes") {
    const episodesAndAttempts = [
      ...snapshot.episodes.map((episode) => ({ episode, kind: "episode" as const })),
      ...snapshot.attempts
        .filter((attempt) => !snapshot.episodes.some((episode) => episode.id === attempt.id))
        .map((episode) => ({ episode, kind: "attempt" as const })),
    ];
    return episodesAndAttempts.map(
      ({ episode, kind }) => episodeRow(episode, selectedEpisodeIds.has(episode.id), kind),
    );
  }
  if (page === "import") {
    if (importState.stage === "preview" && importState.preview) {
      return importPreviewRows(importState.preview);
    }
    const choices = importState.candidates.length > 0 ? importState.candidates : importState.samples;
    const selectedId = importState.candidates.length > 0
      ? importState.selectedCandidateId
      : importState.selectedSampleId;
    return choices.map((choice) => ({
      id: choice.id,
      primary: choice.label,
      secondary: choice.detail,
      selected: choice.id === selectedId,
      enabled: importState.stage !== "loading",
      intent: importState.candidates.length > 0
        ? { type: "import-select-candidate", candidateId: choice.id }
        : { type: "import-select-sample", sampleId: choice.id },
    }));
  }
  const accountRow: SoloXrConsoleRow = account.state === "signed-in"
    ? {
        id: "hf-account",
        primary: "Hugging Face",
        secondary: `${account.label} (log out)`,
        selected: true,
        enabled: exportState.state !== "preparing" && exportState.state !== "uploading",
        intent: { type: "hf-sign-out" },
      }
    : account.state === "signed-out"
      ? {
          id: "hf-account",
          primary: account.actionLabel ?? "Sign in to Hugging Face",
          secondary: "Authorise this headset",
          selected: false,
          enabled: exportState.state !== "preparing" && exportState.state !== "uploading",
          intent: { type: "hf-sign-in" },
        }
      : {
          id: "hf-account",
          primary: "Hugging Face",
          secondary: account.label,
          selected: false,
          enabled: false,
          intent: null,
        };
  return [accountRow, ...exportState.jobs.map((job) => ({
    id: `export-job-${job.id}`,
    primary: `${job.type === "upload" ? "Hugging Face" : "Local export"} / ${job.state}`,
    secondary: `${compactText(job.detail, 54)} / ${formatJobTime(job.updatedAt)}`,
    selected: job.state === "queued" || job.state === "running",
    enabled: true,
    intent: null,
  }))];
}

function actionsForPage(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  focusedTaskId: string | null,
  selectedEpisodeIds: ReadonlySet<string>,
  account: SoloXrConsoleAccountPresentation,
  importState: SoloXrConsoleImportState,
  exportState: SoloXrConsoleExportState,
  pendingDelete: Readonly<{ episodeId: string; label: string }> | null,
): SoloXrConsoleAction[] {
  if (page === "run") {
    const runActive = snapshot.run.status === "running";
    const actions: SoloXrConsoleAction[] = [];
    if (runActive) {
      const finishAvailable = snapshot.run.recordingState !== "arming"
        && snapshot.run.recordingState !== "stopping";
      actions.push({
        id: "finish-run",
        label: "Finish",
        enabled: finishAvailable,
        tone: "primary",
        intent: { type: "run-control", action: "finish" },
      });
    }
    return actions;
  }
  if (page === "tasks") {
    const focusedTask = snapshot.configuration.tasks.find((task) => task.id === focusedTaskId) ?? null;
    const focusedIndex = focusedTask
      ? snapshot.configuration.tasks.findIndex((task) => task.id === focusedTask.id)
      : -1;
    const actions: SoloXrConsoleAction[] = [
      {
        id: "add-task",
        label: "Add task",
        enabled: true,
        tone: "primary",
        intent: { type: "draft-add-task" },
      },
    ];
    if (!focusedTask) return actions;
    actions.push(
      {
        id: "move-task-up",
        label: "Move up",
        enabled: focusedIndex > 0,
        tone: "normal",
        intent: { type: "draft-move-task", taskId: focusedTask.id, offset: -1 },
      },
      {
        id: "move-task-down",
        label: "Move down",
        enabled: focusedIndex >= 0 && focusedIndex + 1 < snapshot.configuration.tasks.length,
        tone: "normal",
        intent: { type: "draft-move-task", taskId: focusedTask.id, offset: 1 },
      },
      {
        id: "delete-task",
        label: "Delete",
        enabled: true,
        tone: "danger",
        intent: { type: "draft-delete-focused-task" },
      },
    );
    return actions;
  }
  if (page === "import") {
    if (importState.stage === "preview") {
      const actions: SoloXrConsoleAction[] = [
        {
          id: "import-confirm",
          label: "Import",
          enabled: true,
          tone: "primary",
          intent: { type: "import-confirm" },
        },
        {
          id: "import-cancel",
          label: "Cancel",
          enabled: true,
          tone: "normal",
          intent: { type: "import-cancel" },
        },
      ];
      return actions;
    }
    const actions: SoloXrConsoleAction[] = [
      {
        id: "import-file",
        label: "Choose file",
        enabled: importState.stage !== "loading",
        tone: "primary",
        intent: { type: "import-file" },
      },
      {
        id: "import-fetch-gist",
        label: "Fetch Gist",
        enabled: importState.stage !== "loading" && importState.gist.trim().length > 0,
        tone: "normal",
        intent: { type: "import-fetch-gist" },
      },
      {
        id: "import-preview",
        label: "Preview",
        enabled: importState.stage !== "loading"
          && Boolean(importState.selectedCandidateId || importState.selectedSampleId),
        tone: "normal",
        intent: { type: "import-preview" },
      },
      {
        id: "import-cancel",
        label: importState.stage === "loading" ? "Cancel" : "Clear",
        enabled: true,
        tone: "normal",
        intent: { type: "import-cancel" },
      },
    ];
    return actions;
  }
  if (page === "episodes") {
    if (pendingDelete) {
      const actions: SoloXrConsoleAction[] = [
        {
          id: "confirm-delete-episode",
          label: `Confirm delete ${pendingDelete.label}`,
          enabled: true,
          tone: "danger",
          intent: { type: "episode-delete-confirm", episodeId: pendingDelete.episodeId },
        },
        {
          id: "cancel-delete-episode",
          label: "Cancel",
          enabled: true,
          tone: "normal",
          intent: { type: "episode-delete-cancel" },
        },
      ];
      return actions;
    }
    const selected = [...selectedEpisodeIds];
    const actions: SoloXrConsoleAction[] = selected.length === 1
      ? [{
          id: "delete-episode",
          label: "Delete selected",
          enabled: true,
          tone: "danger",
          intent: { type: "episode-delete", episodeId: selected[0] },
        }]
      : [];
    return actions;
  }
  const exportableEpisodeIds = uniqueExportableEpisodeIds(snapshot);
  const availableEpisodeIds = selectedEpisodeIds.size > 0
    ? exportableEpisodeIds.filter((episodeId) => selectedEpisodeIds.has(episodeId))
    : exportableEpisodeIds;
  const exportIdle = exportState.state !== "preparing" && exportState.state !== "uploading";
  const actions: SoloXrConsoleAction[] = [
    {
      id: "export-folder",
      label: "Export to device",
      enabled: exportIdle && availableEpisodeIds.length > 0,
      tone: "primary",
      intent: { type: "export-folder", episodeIds: availableEpisodeIds },
    },
  ];
  if (exportState.canCancel) {
    actions.push({
      id: "export-cancel",
      label: "Cancel export",
      enabled: true,
      tone: "danger",
      intent: { type: "export-cancel" },
    });
  }
  if (exportState.canRetry) {
    actions.push({
      id: "export-retry",
      label: "Retry export",
      enabled: true,
      tone: "primary",
      intent: { type: "export-retry" },
    });
  }
  if (account.state === "signed-in") {
    actions.push({
      id: "hf-upload",
      label: "Upload to HF",
      enabled: exportIdle && account.uploadEnabled && availableEpisodeIds.length > 0,
      tone: "primary",
      intent: { type: "hf-upload", episodeIds: availableEpisodeIds },
    });
  }
  return actions;
}

function controlsForPage(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  _focusedTaskId: string | null,
  exportState: SoloXrConsoleExportState,
): SoloXrConsoleControl[] {
  if (page === "run") return [];
  if (page !== "export") return [];
  const exportIdle = exportState.state !== "preparing" && exportState.state !== "uploading";
  const controls: SoloXrConsoleControl[] = [{
    kind: "toggle",
    id: "visibility",
    label: "Dataset visibility",
    checked: exportState.visibility === "private",
    enabled: exportIdle,
    offLabel: "Public",
    onLabel: "Private",
    onChange: (checked) => ({
      type: "export-visibility-change",
      visibility: checked ? "private" : "public",
    }),
  }];
  if (exportState.progress !== null
    || exportState.state === "preparing"
    || exportState.state === "uploading") {
    const progress = Math.max(0, Math.min(1, exportState.progress ?? 0));
    controls.push({
      kind: "progress",
      id: "export-progress",
      label: `${exportState.message} / ${Math.round(progress * 100)}%`,
      value: progress,
    });
  }
  return controls;
}

function inputsForPage(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  _focusedTaskId: string | null,
  importState: SoloXrConsoleImportState,
  exportState: SoloXrConsoleExportState,
): SoloXrConsoleInput[] {
  if (page === "run") {
    return [
      {
        id: "run-title",
        label: "Run title",
        value: snapshot.configuration.runTitle,
        placeholder: "Run title",
        multiline: false,
        onChange: (value) => ({ type: "draft-set-text", field: "run-title", value }),
      },
      {
        id: "total-cycles",
        label: "Cycles",
        value: String(snapshot.configuration.totalCycles),
        placeholder: "1",
        multiline: false,
        slider: { min: 1, max: 20, step: 1 },
        onChange: (value) => ({ type: "draft-set-number", field: "total-cycles", value }),
      },
      {
        id: "run-description",
        label: "Run description",
        value: snapshot.configuration.runDescription,
        placeholder: "Run description",
        multiline: true,
        onChange: (value) => ({ type: "draft-set-text", field: "run-description", value }),
      },
    ];
  }
  if (page === "tasks") return [];
  if (page === "import") {
    if (importState.stage === "preview") return [];
    return [{
      id: "gist",
      label: "Public Gist URL or ID",
      value: importState.gist,
      placeholder: "gist.github.com/user/id",
      multiline: false,
      onChange: (value) => ({ type: "import-gist-change", value }),
    }];
  }
  if (page === "export") {
    const exportIdle = exportState.state !== "preparing" && exportState.state !== "uploading";
    return [
      {
        id: "repository",
        label: "Hugging Face repository",
        value: exportState.repository,
        placeholder: "organisation/dataset",
        multiline: false,
        enabled: exportIdle,
        onChange: (value) => ({ type: "export-repository-change", value }),
      },
      {
        id: "branch",
        label: "Branch",
        value: exportState.branch,
        placeholder: "main",
        multiline: false,
        enabled: exportIdle,
        onChange: (value) => ({ type: "export-branch-change", value }),
      },
    ];
  }
  return [];
}

function taskPropertiesForPage(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  focusedTaskId: string | null,
): SoloXrTaskPropertiesPresentation | null {
  if (page !== "tasks") return null;
  const task = snapshot.configuration.tasks.find((candidate) => candidate.id === focusedTaskId);
  if (!task) return null;
  return {
    taskId: task.id,
    label: task.label,
    instructions: task.instructions,
    type: task.type,
    durationS: task.type === "open" ? 60 : task.durationS,
    repeatCount: task.type === "pause" ? 1 : task.repeatCount,
    resetTimeS: task.type === "pause" ? MINIMUM_TASK_RESET_SECONDS : task.resetTimeS,
  };
}

function episodeRow(
  episode: Episode,
  selected: boolean,
  kind: "episode" | "attempt",
): SoloXrConsoleRow {
  const exportability = isExportableEpisode(episode) ? "EXPORTABLE" : "NOT EXPORTABLE";
  return {
    id: episode.id,
    primary: episode.taskLabel || episode.runTitle || episode.id,
    secondary: `${kind} / ${episode.outcome} / ${episode.integrity} / ${exportability} / take ${episode.take}`,
    selected,
    enabled: episode.integrity !== "pending",
    control: "checkbox",
    intent: {
      type: "episode-select",
      episodeId: episode.id,
      selected: !selected,
    },
  };
}

function taskSummary(task: TaskDefinition) {
  if (task.type === "pause") return `Pause / ${task.durationS}s`;
  if (task.type === "open") return `Open / ${task.repeatCount} repeat`;
  return `Timed / ${task.durationS}s / ${task.repeatCount} repeat`;
}

function statusIndicators(
  snapshot: SessionSnapshot,
  finalising: boolean,
  exportState: SoloXrConsoleExportState,
): readonly SoloXrConsoleStatusIndicator[] {
  const storage = snapshot.solo?.storageHeadroom.state ?? "checking";
  const uploadActive = exportState.state === "preparing" || exportState.state === "uploading";
  const promptRequired = snapshot.configuration.promptAudio.enabled
    || snapshot.configuration.promptAudio.useTextToSpeech;
  return [
    {
      icon: "camera",
      state: snapshot.captureStatus.camera,
      label: `Camera ${snapshot.captureStatus.camera}`,
      tone: snapshot.captureStatus.camera === "ready"
        ? "success"
        : snapshot.captureStatus.camera === "requesting"
          ? "action"
          : snapshot.captureStatus.camera === "error"
            ? "danger"
            : "muted",
    },
    {
      icon: "xr",
      state: snapshot.captureStatus.xr,
      label: `XR ${snapshot.captureStatus.xr}`,
      tone: snapshot.captureStatus.xr === "active"
        ? "success"
        : snapshot.captureStatus.xr === "requesting"
          ? "action"
          : snapshot.captureStatus.xr === "error"
            ? "danger"
            : snapshot.captureStatus.xr === "ended"
              ? "warning"
              : "muted",
    },
    recorderStatusIndicator(snapshot, finalising),
    {
      icon: "prompt",
      state: promptRequired ? snapshot.promptAudioStatus.state : "off",
      label: promptRequired
        ? `Prompt audio ${snapshot.promptAudioStatus.state}`
        : "Prompt audio off",
      tone: !promptRequired
        ? "muted"
        : snapshot.promptAudioStatus.state === "ready"
          ? "success"
          : snapshot.promptAudioStatus.state === "locked"
            ? "warning"
            : "danger",
    },
    {
      icon: "storage",
      state: uploadActive ? exportState.state : storage,
      label: uploadActive ? `Hugging Face ${exportState.state}` : `Storage ${storage}`,
      tone: uploadActive
        ? "action"
        : storage === "ready" ? "success" : storage === "blocked" ? "danger" : "action",
    },
  ];
}

function recorderStatusIndicator(
  snapshot: SessionSnapshot,
  finalising: boolean,
): SoloXrConsoleStatusIndicator {
  if (finalising || snapshot.run.recordingState === "stopping") {
    return {
      icon: "recorder",
      state: "finalising",
      label: "Recorder finalising",
      tone: "warning",
    };
  }
  if (snapshot.solo?.startCountdownDeadlineMs != null) {
    return {
      icon: "recorder",
      state: "countdown",
      label: "Recorder countdown",
      tone: "warning",
    };
  }
  const state = snapshot.captureStatus.recorder;
  return {
    icon: "recorder",
    state,
    label: `Recorder ${state}`,
    tone: state === "recording"
      ? "danger"
      : state === "armed"
        ? "success"
        : state === "arming"
          ? "action"
          : state === "paused"
            ? "warning"
            : state === "failed"
              ? "danger"
              : "muted",
  };
}

function pageHint(
  snapshot: SessionSnapshot,
  page: SoloXrConsolePage,
  importState: SoloXrConsoleImportState,
  exportState: SoloXrConsoleExportState,
) {
  if (page !== "export" && (exportState.state === "preparing" || exportState.state === "uploading")) {
    const progress = exportState.progress === null
      ? ""
      : ` / ${Math.round(Math.max(0, Math.min(1, exportState.progress)) * 100)}%`;
    return `${exportState.message}${progress}`;
  }
  if (page === "run") {
    if (!snapshot.sequenceReadiness.ready) {
      return `Capture unavailable: ${readinessSummary(snapshot)}`;
    }
    return "Choose a start task";
  }
  if (page === "tasks") {
    return "Edit the focused task";
  }
  if (page === "import") {
    const preview = importState.preview
      ? ` / ${importState.preview.runTitle} / ${importState.preview.tasks.length} tasks`
      : importState.previewLabel
        ? ` / ${importState.previewLabel}`
        : "";
    return `${importState.message}${preview}`;
  }
  if (page === "episodes") {
    return "Select captures";
  }
  const progress = exportState.progress === null
    ? ""
    : ` / ${Math.round(Math.max(0, Math.min(1, exportState.progress)) * 100)}%`;
  return `${exportState.message}${progress}`;
}

function importPreviewRows(preview: SoloXrConsoleImportPreview): SoloXrConsoleRow[] {
  const warnings = preview.warnings.length > 0
    ? preview.warnings.join("; ")
    : "No warnings";
  return [
    {
      id: "preview-run",
      primary: compactText(preview.runTitle || "Untitled run", 48),
      secondary: `${preview.cycleCount} cycle${preview.cycleCount === 1 ? "" : "s"} / ${compactText(preview.runDescription || "No description", 72)}`,
      selected: false,
      enabled: true,
      intent: null,
    },
    {
      id: "preview-provenance",
      primary: compactText(`${preview.sourceLabel} / ${preview.fileName}`, 52),
      secondary: `SHA-256 ${compactHash(preview.taskSpecHash)} / ${compactText(warnings, 52)}`,
      selected: false,
      enabled: true,
      intent: null,
    },
    ...preview.tasks.map((task, index): SoloXrConsoleRow => ({
      id: `preview-task-${task.id}`,
      primary: compactText(`${index + 1}. ${task.label}`, 48),
      secondary: `${previewTaskTiming(task)} / ${compactText(task.instructions || "No instructions", 56)}`,
      selected: false,
      enabled: true,
      intent: null,
    })),
  ];
}

function previewTaskTiming(task: SoloXrConsoleImportPreviewTask) {
  if (task.type === "pause") return `Pause / ${task.durationS ?? 0}s`;
  if (task.type === "open") {
    return `Open / ${task.repeatCount ?? 1} repeat / ${task.resetTimeS ?? 0}s reset`;
  }
  return `Timed / ${task.durationS ?? 0}s / ${task.repeatCount ?? 1} repeat / ${task.resetTimeS ?? 0}s reset`;
}

function readinessSummary(snapshot: SessionSnapshot) {
  const messages = snapshot.sequenceReadiness.blockers
    .slice(0, 2)
    .map(({ message }) => message.replace(/^The demonstrator /, "Solo capture "));
  return messages.length > 0 ? messages.join(" / ") : "Capture is not ready";
}

function sessionIdentity(
  sessionId: string,
  recovery: NonNullable<SoloXrConsolePresentationOptions["sessionRecovery"]>,
) {
  const displayId = sessionId.length > 20
    ? `${sessionId.slice(0, 10)}...${sessionId.slice(-6)}`
    : sessionId;
  return `SESSION ${displayId} / ${recovery.toUpperCase()}`;
}

function formatJobTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "time unavailable";
  return new Date(time).toISOString().replace("T", " ").slice(0, 19);
}

function compactHash(value: string) {
  if (value.length <= 28) return value;
  return `${value.slice(0, 16)}...${value.slice(-8)}`;
}

function compactText(value: string, maxLength: number) {
  const normalised = value.replace(/\s+/g, " ").trim();
  if (normalised.length <= maxLength) return normalised;
  return `${normalised.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function uniqueExportableEpisodeIds(snapshot: SessionSnapshot) {
  const seen = new Set<string>();
  return [...snapshot.episodes, ...snapshot.attempts]
    .filter((episode) => {
      if (seen.has(episode.id)) return false;
      seen.add(episode.id);
      return isExportableEpisode(episode);
    })
    .map((episode) => episode.id);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
