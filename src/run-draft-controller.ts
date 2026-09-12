import {
  createTaskId,
  defaultConfiguration,
  isRepetitionTask,
  normaliseCaptureConfiguration,
  type CaptureConfiguration,
  type CaptureStudyMetadata,
  type RepetitionPlan,
  type TaskDefinition,
} from "../shared/protocol.js";
import { MINIMUM_TASK_RESET_SECONDS } from "../shared/run-sequencing.js";

export interface RunDraftSnapshot {
  configuration: CaptureConfiguration;
  selectedStartTaskId: string | null;
  focusedTaskId: string | null;
  locked: boolean;
}

export interface RunDraftMetadata {
  runTitle: string;
  runDescription: string;
  totalCycles: number;
}

export type RunDraftStudyMetadata = CaptureStudyMetadata;

export interface RunDraftTaskProperties {
  label: string;
  instructions: string;
  type: TaskDefinition["type"];
  durationS: number;
  repeatCount: number;
  resetTimeS: number;
}

interface TaskTypeMemory {
  timedDurationS?: number;
  pauseDurationS?: number;
  repeatCount?: number;
  resetTimeS?: number;
}

export class RunDraftController {
  private configurationValue: CaptureConfiguration;
  private selectedStartTaskIdValue: string | null;
  private focusedTaskIdValue: string | null = null;
  private lockedValue = false;
  private readonly taskTypeMemory = new Map<string, TaskTypeMemory>();

  constructor(configuration: CaptureConfiguration, selectedStartTaskId: string | null = null) {
    this.configurationValue = normaliseCaptureConfiguration(configuration);
    this.selectedStartTaskIdValue = this.validStartTaskId(selectedStartTaskId);
  }

  get snapshot(): RunDraftSnapshot {
    return {
      configuration: structuredClone(this.configurationValue),
      selectedStartTaskId: this.selectedStartTaskIdValue,
      focusedTaskId: this.focusedTaskIdValue,
      locked: this.lockedValue,
    };
  }

  readConfiguration() {
    return structuredClone(this.configurationValue);
  }

  setLocked(locked: boolean) {
    this.lockedValue = locked;
  }

  applyConfiguration(configuration: CaptureConfiguration) {
    this.assertEditable();
    const previousTasks = new Map(this.configurationValue.tasks.map((task) => [task.id, task]));
    const nextConfiguration = normaliseCaptureConfiguration(configuration);
    const taskIds = new Set(nextConfiguration.tasks.map((task) => task.id));
    for (const taskId of this.taskTypeMemory.keys()) {
      if (!taskIds.has(taskId)) this.taskTypeMemory.delete(taskId);
    }
    for (const task of nextConfiguration.tasks) {
      const previous = previousTasks.get(task.id);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(task)) {
        this.taskTypeMemory.delete(task.id);
      }
      this.rememberTaskValues(task);
    }
    this.configurationValue = nextConfiguration;
    this.selectedStartTaskIdValue = this.validStartTaskId(this.selectedStartTaskIdValue);
    this.focusedTaskIdValue = null;
    return this.readConfiguration();
  }

  setMetadata(metadata: RunDraftMetadata) {
    this.assertEditable();
    this.configurationValue = {
      ...this.configurationValue,
      runTitle: metadata.runTitle.trim() || defaultConfiguration.runTitle,
      runDescription: metadata.runDescription.trim(),
      totalCycles: Math.max(1, Math.trunc(metadata.totalCycles || 1)),
    };
    return this.readConfiguration();
  }

  setStudyMetadata(metadata: RunDraftStudyMetadata) {
    this.assertEditable();
    this.configurationValue = normaliseCaptureConfiguration({
      ...this.configurationValue,
      studyMetadata: {
        headsetId: metadata.headsetId,
        demonstratorId: metadata.demonstratorId,
        projectId: metadata.projectId,
        consentDate: metadata.consentDate,
        consentDocumentId: metadata.consentDocumentId,
      },
    });
    return this.readConfiguration();
  }

  focusTask(taskId: string | null) {
    this.focusedTaskIdValue = taskId && this.configurationValue.tasks.some((task) => task.id === taskId)
      ? taskId
      : null;
  }

  selectStartTask(taskId: string) {
    this.assertEditable();
    const task = this.configurationValue.tasks.find((candidate) => candidate.id === taskId);
    if (!task || !isRepetitionTask(task)) throw new Error("Select a recordable start task");
    this.selectedStartTaskIdValue = taskId;
    return taskId;
  }

  setSelectedStartTask(taskId: string | null) {
    this.selectedStartTaskIdValue = this.validStartTaskId(taskId);
  }

  updateTask(taskId: string, update: (task: TaskDefinition) => TaskDefinition) {
    this.assertEditable();
    let found = false;
    this.configurationValue = {
      ...this.configurationValue,
      tasks: this.configurationValue.tasks.map((task) => {
        if (task.id !== taskId) return task;
        found = true;
        return normaliseTaskDefinition(update(structuredClone(task)), task);
      }),
    };
    if (!found) throw new Error("The selected run task is no longer available");
    this.selectedStartTaskIdValue = this.validStartTaskId(this.selectedStartTaskIdValue);
    return this.readConfiguration();
  }

  convertTaskType(taskId: string, type: TaskDefinition["type"]) {
    return this.updateTask(taskId, (task) => {
      const memory = this.rememberTaskValues(task);
      const converted = convertRunDraftTaskType(task, type);
      if (converted.type === "pause") {
        return {
          ...converted,
          durationS: memory.pauseDurationS ?? converted.durationS,
        };
      }
      const repetition: RepetitionPlan = {
        repeatCount: memory.repeatCount ?? converted.repeatCount,
        resetTimeS: memory.resetTimeS ?? converted.resetTimeS,
      };
      if (converted.type === "open") return { ...converted, ...repetition };
      return {
        ...converted,
        ...repetition,
        durationS: memory.timedDurationS ?? converted.durationS,
      };
    });
  }

  setTaskProperties(taskId: string, properties: RunDraftTaskProperties) {
    return this.updateTask(taskId, (task) => {
      const converted = convertRunDraftTaskType(task, properties.type);
      const identity = {
        id: converted.id,
        label: properties.label,
        instructions: properties.instructions,
      };
      if (properties.type === "pause") {
        return {
          ...identity,
          type: "pause",
          durationS: properties.durationS,
        };
      }
      const repetition = {
        repeatCount: properties.repeatCount,
        resetTimeS: properties.resetTimeS,
      };
      if (properties.type === "open") {
        return {
          ...identity,
          ...repetition,
          type: "open",
        };
      }
      return {
        ...identity,
        ...repetition,
        type: "timed",
        durationS: properties.durationS,
      };
    });
  }

  addTask() {
    this.assertEditable();
    const tasks = this.configurationValue.tasks;
    const index = tasks.length + 1;
    const task: TaskDefinition = {
      id: createTaskId(new Set(tasks.map((candidate) => candidate.id))),
      label: `Task ${String(index).padStart(2, "0")}`,
      instructions: "--",
      type: "timed",
      durationS: 60,
      repeatCount: 1,
      resetTimeS: MINIMUM_TASK_RESET_SECONDS,
    };
    this.configurationValue = { ...this.configurationValue, tasks: [...tasks, task] };
    this.focusedTaskIdValue = task.id;
    return structuredClone(task);
  }

  deleteFocusedTask() {
    this.assertEditable();
    if (!this.focusedTaskIdValue) return null;
    const deletedTaskId = this.focusedTaskIdValue;
    this.configurationValue = {
      ...this.configurationValue,
      tasks: this.configurationValue.tasks.filter((task) => task.id !== deletedTaskId),
    };
    this.taskTypeMemory.delete(deletedTaskId);
    if (this.selectedStartTaskIdValue === deletedTaskId) this.selectedStartTaskIdValue = null;
    this.focusedTaskIdValue = null;
    return deletedTaskId;
  }

  moveTask(taskId: string, offset: number) {
    this.assertEditable();
    if (!Number.isSafeInteger(offset)) throw new Error("The task movement is invalid");
    const tasks = [...this.configurationValue.tasks];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) throw new Error("The selected run task is no longer available");
    const destination = Math.max(0, Math.min(tasks.length - 1, index + offset));
    if (destination === index) return index;
    const [task] = tasks.splice(index, 1);
    tasks.splice(destination, 0, task);
    this.configurationValue = { ...this.configurationValue, tasks };
    this.focusedTaskIdValue = taskId;
    return destination;
  }

  private rememberTaskValues(task: TaskDefinition) {
    const memory = this.taskTypeMemory.get(task.id) ?? {};
    if (task.type === "timed") memory.timedDurationS = task.durationS;
    if (task.type === "pause") memory.pauseDurationS = task.durationS;
    if (isRepetitionTask(task)) {
      memory.repeatCount = task.repeatCount;
      memory.resetTimeS = task.resetTimeS;
    }
    this.taskTypeMemory.set(task.id, memory);
    return memory;
  }

  private validStartTaskId(taskId: string | null) {
    if (!taskId) return null;
    const task = this.configurationValue.tasks.find((candidate) => candidate.id === taskId);
    return task && isRepetitionTask(task) ? task.id : null;
  }

  private assertEditable() {
    if (this.lockedValue) throw new Error("The run draft is locked while capture is active");
  }
}

export function convertRunDraftTaskType(
  task: TaskDefinition,
  type: TaskDefinition["type"],
): TaskDefinition {
  const identity = { id: task.id, label: task.label, instructions: task.instructions };
  if (type === "pause") {
    return {
      ...identity,
      type,
      durationS: task.type === "pause" ? task.durationS : 15,
    };
  }
  const repetition: RepetitionPlan = task.type === "pause"
    ? { repeatCount: 1, resetTimeS: MINIMUM_TASK_RESET_SECONDS }
    : { repeatCount: task.repeatCount, resetTimeS: task.resetTimeS };
  if (type === "open") return { ...identity, ...repetition, type };
  return {
    ...identity,
    ...repetition,
    type: "timed",
    durationS: task.type === "timed" ? task.durationS : 60,
  };
}

function normaliseTaskDefinition(task: TaskDefinition, fallback: TaskDefinition): TaskDefinition {
  const identity = {
    id: fallback.id,
    label: task.label.trim() || fallback.label,
    instructions: task.instructions.trim() || "--",
  };
  if (task.type === "pause") {
    return {
      ...identity,
      type: "pause",
      durationS: Math.max(0, Number(task.durationS) || 0),
    };
  }
  const repetition = {
    repeatCount: Math.max(1, Math.trunc(Number(task.repeatCount) || 1)),
    resetTimeS: Math.max(
      MINIMUM_TASK_RESET_SECONDS,
      Number(task.resetTimeS) || MINIMUM_TASK_RESET_SECONDS,
    ),
  };
  if (task.type === "open") return { ...identity, ...repetition, type: "open" };
  return {
    ...identity,
    ...repetition,
    type: "timed",
    durationS: Math.max(0, Number(task.durationS) || 0),
  };
}
