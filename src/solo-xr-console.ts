import { PanelDocument, PanelUI } from "@iwsdk/core/dist/ui/ui.js";
import {
  PokeInteractable,
  RayInteractable,
} from "@iwsdk/core/dist/input/state-tags.js";
import { Container, Text } from "@pmndrs/uikit";
import {
  Button,
  ButtonLabel,
  Checkbox,
} from "@pmndrs/uikit-horizon";
import { signal, type Signal } from "@preact/signals-core";
import { Group } from "three";
import { MINIMUM_TASK_RESET_SECONDS } from "../shared/run-sequencing.js";
import type {
  SoloXrConsoleIntent,
  SoloXrConsoleInput,
  SoloXrConsolePage,
  SoloXrConsolePresentation,
  SoloXrTaskPropertiesPresentation,
} from "./solo-xr-console-presentation.js";

export const SOLO_XR_CONSOLE_WIDTH_M = 1.8;
export const SOLO_XR_CONSOLE_HEIGHT_M = 0.76;
export const SOLO_XR_CONSOLE_DISTANCE_M = 1.55;
export const SOLO_XR_CONSOLE_VERTICAL_OFFSET_M = -0.06;
export const SOLO_XR_CONSOLE_MIN_TARGET_M = 0.064;
export const SOLO_XR_CONSOLE_CONFIG = "/ui/solo-console.json";

const DOCUMENT_WAIT_MS = 50;

interface UIKitElement {
  name: string;
  visible: boolean;
  addEventListener: (type: string, listener: (event: any) => void) => void;
  setProperties: (properties: Record<string, unknown>) => void;
}

interface SoloXrConsoleDocument {
  intersectChildren: boolean;
  getElementById: (id: string) => UIKitElement | null;
}

interface SoloXrRowView {
  button: Button;
  label: ButtonLabel;
  checkbox: Checkbox;
  primary: Text;
  secondary: Text;
}

interface SoloXrActionView {
  button: Button;
  label: ButtonLabel;
  text: Text;
}

interface SoloXrTaskPropertiesDraft extends SoloXrTaskPropertiesPresentation {
  dirty: boolean;
  saving: boolean;
}

interface SoloXrTextSignalBinding {
  generation: number;
  semanticIdentity: string;
  value: Signal<string>;
}

interface SoloXrTaskPropertySignalBinding {
  taskId: string;
  value: Signal<string>;
}

export interface SoloXrConsoleOptions {
  onIntent: (intent: SoloXrConsoleIntent) => boolean | void | Promise<boolean | void>;
}

export interface SoloXrConsoleInputBinding {
  readonly generation: number;
  readonly semanticIdentity: string;
}

export function soloXrConsoleInputSemanticIdentity(input: SoloXrConsoleInput) {
  const intent = input.onChange(input.value);
  const semanticIntent = Object.entries(intent)
    .filter(([key]) => key !== "value")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([input.id, semanticIntent]);
}

export function resolveSoloXrConsoleInputIntent(
  currentInputs: readonly SoloXrConsoleInput[],
  binding: SoloXrConsoleInputBinding,
  currentGeneration: number,
  value: string,
): SoloXrConsoleIntent | null {
  if (binding.generation !== currentGeneration) return null;
  const input = currentInputs.find(
    (candidate) => soloXrConsoleInputSemanticIdentity(candidate) === binding.semanticIdentity,
  );
  return input?.onChange(value) ?? null;
}

export class SoloXrConsoleInputDrafts {
  private semanticIdentities: readonly string[] = [];
  private readonly values = new Map<string, string>();

  update(inputs: readonly SoloXrConsoleInput[]) {
    const semanticIdentities = inputs.slice(0, 5).map(soloXrConsoleInputSemanticIdentity);
    if (semanticIdentities.length === this.semanticIdentities.length
      && semanticIdentities.every((identity, index) => identity === this.semanticIdentities[index])) {
      return false;
    }
    this.semanticIdentities = semanticIdentities;
    this.values.clear();
    return true;
  }

  read(input: SoloXrConsoleInput) {
    return this.values.get(soloXrConsoleInputSemanticIdentity(input)) ?? input.value;
  }

  write(input: SoloXrConsoleInput, value: string) {
    this.values.set(soloXrConsoleInputSemanticIdentity(input), value);
  }

  clear() {
    this.semanticIdentities = [];
    this.values.clear();
  }
}

export class SoloXrConsole {
  private readonly group = new Group();
  private readonly entity: any;
  private readonly inputDrafts = new SoloXrConsoleInputDrafts();
  private readonly rowViews = new Map<string, SoloXrRowView>();
  private readonly actionViews = new Map<string, SoloXrActionView>();
  private readonly inputRenderSignatures = new Map<string, string>();
  private readonly controlRenderSignatures = new Map<string, string>();
  private readonly taskPropertyRenderSignatures = new Map<string, string>();
  private readonly inputValueSignals = new Map<string, SoloXrTextSignalBinding>();
  private readonly taskPropertyValueSignals = new Map<string, SoloXrTaskPropertySignalBinding>();
  private document: SoloXrConsoleDocument | null = null;
  private rowsContainer: Container | null = null;
  private actionsContainer: Container | null = null;
  private presentation: SoloXrConsolePresentation | null = null;
  private documentTimer: number | null = null;
  private disposed = false;
  private requestedOpen = true;
  private sessionActive = false;
  private inputGeneration = 0;
  private pendingInputIntent: {
    generation: number;
    intent: SoloXrConsoleIntent;
  } | null = null;
  private taskPropertiesDraft: SoloXrTaskPropertiesDraft | null = null;
  private intentQueue = Promise.resolve();

  constructor(
    private readonly world: any,
    private readonly options: SoloXrConsoleOptions,
  ) {
    this.group.name = "ceres-solo-spatial-console";
    this.group.position.set(
      0,
      SOLO_XR_CONSOLE_VERTICAL_OFFSET_M,
      -SOLO_XR_CONSOLE_DISTANCE_M,
    );
    this.group.visible = false;
    this.entity = world.createTransformEntity(this.group, {
      parent: world.cameraEntity,
      persistent: true,
    });
    this.entity.addComponent(PanelUI, {
      config: SOLO_XR_CONSOLE_CONFIG,
      maxWidth: SOLO_XR_CONSOLE_WIDTH_M,
      maxHeight: SOLO_XR_CONSOLE_HEIGHT_M,
    });
    this.entity.addComponent(RayInteractable);
    this.entity.addComponent(PokeInteractable);
    this.waitForDocument();
  }

  get page(): SoloXrConsolePage {
    return this.presentation?.page ?? "run";
  }

  get open() {
    return this.requestedOpen;
  }

  show() {
    this.requestedOpen = true;
    this.applyVisibility();
  }

  hide() {
    this.requestedOpen = false;
    this.applyVisibility();
  }

  toggle() {
    this.requestedOpen = !this.requestedOpen;
    this.applyVisibility();
  }

  setSessionActive(active: boolean) {
    if (this.sessionActive !== active) {
      this.inputGeneration += 1;
      this.cancelPendingInputIntent();
      if (!active) {
        this.inputDrafts.clear();
        this.inputValueSignals.clear();
        this.taskPropertiesDraft = null;
        this.taskPropertyValueSignals.clear();
        this.taskPropertyRenderSignatures.clear();
      }
    }
    this.sessionActive = active;
    this.applyVisibility();
    if (this.document) this.renderDocument();
  }

  update(presentation: SoloXrConsolePresentation) {
    if (this.disposed) return;
    const pageChanged = this.presentation !== null
      && this.presentation.page !== presentation.page;
    if (pageChanged) {
      this.cancelPendingInputIntent();
      this.resetRowsForPage();
    }
    this.updateInputGeneration(presentation.inputs);
    this.syncTaskPropertiesDraft(presentation.taskProperties);
    this.presentation = presentation;
    this.applyVisibility();
    if (this.document) this.renderDocument();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.inputGeneration += 1;
    this.cancelPendingInputIntent();
    this.inputDrafts.clear();
    this.inputValueSignals.clear();
    this.inputRenderSignatures.clear();
    this.controlRenderSignatures.clear();
    this.taskPropertyRenderSignatures.clear();
    this.taskPropertyValueSignals.clear();
    this.taskPropertiesDraft = null;
    if (this.documentTimer !== null) window.clearTimeout(this.documentTimer);
    this.documentTimer = null;
    this.disposeRows();
    this.disposeActions();
    this.document = null;
    this.rowsContainer = null;
    this.actionsContainer = null;
    this.presentation = null;
    try {
      this.entity.dispose();
    } catch {
      this.group.removeFromParent();
    }
  }

  private waitForDocument() {
    if (this.disposed) return;
    const document = PanelDocument.data.document[this.entity.index] as SoloXrConsoleDocument | undefined;
    if (document) {
      this.document = document;
      this.applyVisibility();
      this.configureDocument();
      this.bindInteractions();
      this.renderDocument();
      return;
    }
    this.documentTimer = window.setTimeout(() => this.waitForDocument(), DOCUMENT_WAIT_MS);
  }

  private bindInteractions() {
    const document = this.document;
    if (!document) return;
    const navigation: ReadonlyArray<readonly [string, SoloXrConsolePage]> = [
      ["nav-run", "run"],
      ["nav-tasks", "tasks"],
      ["nav-import", "import"],
      ["nav-episodes", "episodes"],
      ["nav-export", "export"],
    ];
    for (const [id, page] of navigation) {
      this.bind(id, () => ({ type: "navigate", page }));
    }
    this.bind(
      "solo-console-back",
      () => ({ type: "close-console" }),
      "ceres-solo-back-to-capture",
    );
    this.bind(
      "solo-console-exit",
      () => ({ type: "quit-xr" }),
      "ceres-solo-exit-xr",
    );
    this.bind(
      "task-properties-close",
      () => ({ type: "draft-focus-task", taskId: null }),
      "ceres-solo-task-properties-close",
    );
    const save = document.getElementById("task-properties-save");
    if (!save) throw new Error("The Solo task properties save button is missing");
    save.name = "ceres-solo-task-properties-save";
    save.addEventListener("click", (event: any) => {
      if (this.disposed || !this.sessionActive) return;
      this.blurNativeInput();
      const draft = this.taskPropertiesDraft;
      if (!draft?.dirty || draft.saving) return;
      event.stopPropagation?.();
      draft.saving = true;
      this.renderTaskPropertiesSaveState();
      this.dispatchIntent({
        type: "draft-save-task-properties",
        taskId: draft.taskId,
        properties: {
          label: draft.label,
          instructions: draft.instructions,
          type: draft.type,
          durationS: draft.durationS,
          repeatCount: draft.repeatCount,
          resetTimeS: draft.resetTimeS,
        },
      }, (success) => {
        const current = this.taskPropertiesDraft;
        if (!current || current.taskId !== draft.taskId) return;
        const confirmed = this.presentation?.taskProperties ?? null;
        if (success && confirmed?.taskId === draft.taskId) {
          this.taskPropertiesDraft = createTaskPropertiesDraft(confirmed);
          this.taskPropertyRenderSignatures.clear();
        } else {
          current.saving = false;
          if (success) current.dirty = false;
        }
        this.renderTaskProperties(this.presentation?.taskProperties ?? null);
      });
    });
  }

  private bind(
    id: string,
    intent: () => SoloXrConsoleIntent | null,
    semanticName?: string,
  ) {
    const element = this.document?.getElementById(id);
    if (!element) throw new Error(`The Solo console element ${id} is missing`);
    element.name = semanticName ?? `ceres-solo-control:${id}`;
    element.addEventListener("click", (event: any) => {
      if (this.disposed) return;
      const next = intent();
      if (!next) return;
      event.stopPropagation?.();
      this.blurNativeInput();
      this.flushPendingInputIntent();
      this.dispatchIntent(next);
    });
  }

  private renderDocument() {
    const presentation = this.presentation;
    if (!presentation || !this.document) return;
    this.setText("solo-console-identity", presentation.identity);
    this.setText("solo-console-hint", presentation.hint);
    for (const page of ["run", "tasks", "import", "episodes", "export"] as const) {
      const selected = presentation.page === page;
      this.setButtonState(`nav-${page}`, true, selected, "normal");
      this.document.getElementById(`nav-${page}`)?.setProperties({
        variant: selected ? "primary" : "tertiary",
      });
    }
    this.renderTaskProperties(presentation.taskProperties);
    this.renderRows(presentation);
    this.renderSemanticControls(presentation);
    this.renderActions(presentation);
    const hasInputs = presentation.inputs.length > 0;
    const hasRows = presentation.rows.length > 0;
    const hasControls = presentation.controls.length > 0;
    const hasActions = presentation.actions.length > 0;
    this.setDisplay("fields-container", hasInputs);
    this.setDisplay("rows-container", hasRows);
    this.setDisplay("semantic-controls", hasControls);
    this.setDisplay("actions-container", hasActions);
    this.document.getElementById("rows-container")?.setProperties({
      height: hasInputs ? 100 : 280,
    });
    this.document.getElementById("fields-container")?.setProperties({
      height: presentation.inputs.some((input) => input.multiline) ? 212 : 188,
    });
    this.document.getElementById("actions-container")?.setProperties({
      height: presentation.actions.length > 5 ? 136 : 64,
    });
    for (let index = 0; index < 5; index += 1) {
      const input = presentation.inputs[index];
      const fieldWidth = input?.multiline
        ? 976
        : index < 2 || presentation.inputs.length <= 4
          ? 482
          : 316;
      const fieldHeight = input?.multiline ? 112 : 88;
      this.setDisplay(`field-${index}`, Boolean(input));
      this.document.getElementById(`field-${index}`)?.setProperties({
        width: fieldWidth,
        height: fieldHeight,
      });
      const singleLineElement = this.document.getElementById(`field-${index}-input`);
      const multilineElement = this.document.getElementById(`field-${index}-textarea`);
      const sliderElement = this.document.getElementById(`field-${index}-slider`);
      const activeElement = input?.slider
        ? sliderElement
        : input?.multiline
          ? multilineElement
          : singleLineElement;
      this.setDisplay(
        `field-${index}-input`,
        Boolean(input) && !input?.multiline && !input?.slider,
      );
      this.setDisplay(`field-${index}-textarea`, Boolean(input) && input?.multiline === true);
      this.setDisplay(`field-${index}-slider`, Boolean(input?.slider));
      for (const [kind, element] of [
        ["input", singleLineElement],
        ["textarea", multilineElement],
        ["slider", sliderElement],
      ] as const) {
        if (!element) continue;
        element.name = element === activeElement && input
          ? `ceres-solo-input:${input.id}`
          : `ceres-solo-control:field-${index}-${kind}`;
      }
      const binding: SoloXrConsoleInputBinding | null = input
        ? {
            generation: this.inputGeneration,
            semanticIdentity: soloXrConsoleInputSemanticIdentity(input),
          }
        : null;
      for (const element of [singleLineElement, multilineElement, sliderElement]) {
        if (!element) continue;
        const active = element === activeElement && Boolean(input);
        const elementId = `field-${index}-${
          element === singleLineElement
            ? "input"
            : element === multilineElement
              ? "textarea"
              : "slider"
        }`;
        const value = active && input ? this.inputDrafts.read(input) : "";
        const textValueSignal = active && input && binding && element !== sliderElement
          ? this.resolveInputValueSignal(elementId, binding, value)
          : undefined;
        const signatureFor = (nextValue: string) => JSON.stringify([
          active,
          binding?.semanticIdentity ?? null,
          binding?.generation ?? null,
          nextValue,
          active ? input?.placeholder ?? "" : "",
          !active || input?.enabled === false,
          fieldWidth,
          input?.slider ?? null,
        ]);
        const signature = signatureFor(value);
        if (this.inputRenderSignatures.get(elementId) === signature) continue;
        if (element === sliderElement) {
          const numericValue = Number(value);
          element.setProperties({
            width: fieldWidth,
            value: Number.isFinite(numericValue) ? numericValue : 0,
            min: input?.slider?.min ?? 0,
            max: input?.slider?.max ?? 100,
            step: input?.slider?.step ?? 1,
            size: "md",
            leftLabel: active ? String(input?.slider?.min ?? "") : "",
            rightLabel: active ? String(input?.slider?.max ?? "") : "",
            pointerEvents: active && input?.enabled !== false ? "listener" : "none",
            opacity: !active ? 0 : input?.enabled === false ? 0.46 : 1,
            onValueChange: active && binding
              ? (nextValue: number) => {
                  if (this.disposed || !this.sessionActive || !input) return;
                  const nextString = String(nextValue);
                  this.inputDrafts.write(input, nextString);
                  element.setProperties({ value: nextValue });
                  this.inputRenderSignatures.set(elementId, signatureFor(nextString));
                  const intent = resolveSoloXrConsoleInputIntent(
                    this.presentation?.inputs ?? [],
                    binding,
                    this.inputGeneration,
                    nextString,
                  );
                  if (intent) this.queueInputIntent(intent, binding.generation);
                }
              : undefined,
          });
          this.inputRenderSignatures.set(elementId, signature);
          continue;
        }
        element.setProperties({
          width: fieldWidth,
          height: fieldHeight,
          label: active ? input?.label ?? "" : "",
          value: textValueSignal,
          defaultValue: undefined,
          placeholder: active ? input?.placeholder ?? "" : "",
          disabled: !active || input?.enabled === false,
          opacity: !active ? 0 : input?.enabled === false ? 0.46 : 1,
          onValueChange: active && binding
              ? (nextValue: string) => {
                  if (this.disposed || !this.sessionActive || !input) return;
                  if (textValueSignal) textValueSignal.value = nextValue;
                  this.inputDrafts.write(input, nextValue);
                  this.inputRenderSignatures.set(elementId, signatureFor(nextValue));
                  const intent = resolveSoloXrConsoleInputIntent(
                    this.presentation?.inputs ?? [],
                  binding,
                  this.inputGeneration,
                    nextValue,
                  );
                  if (intent) this.queueInputIntent(intent, binding.generation);
                }
              : undefined,
          onFocusChange: active && binding
            ? (focused: boolean) => {
                if (!focused) this.flushPendingInputIntent(binding.generation);
              }
            : undefined,
        });
        this.inputRenderSignatures.set(elementId, signature);
      }
    }
  }

  private dispatchIntent(
    intent: SoloXrConsoleIntent,
    onResult?: (success: boolean) => void,
  ) {
    this.intentQueue = this.intentQueue
      .then(async () => {
        if (this.disposed || !this.sessionActive) {
          onResult?.(false);
          return;
        }
        const result = await this.options.onIntent(intent);
        onResult?.(result !== false);
      })
      .catch(() => onResult?.(false));
  }

  private queueInputIntent(intent: SoloXrConsoleIntent, generation: number) {
    this.pendingInputIntent = { generation, intent };
  }

  private flushPendingInputIntent(generation = this.inputGeneration) {
    const pending = this.pendingInputIntent;
    this.pendingInputIntent = null;
    if (!pending || pending.generation !== generation || generation !== this.inputGeneration) return;
    this.dispatchIntent(pending.intent);
  }

  private cancelPendingInputIntent() {
    this.pendingInputIntent = null;
  }

  private blurNativeInput() {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
      activeElement.blur();
    }
  }

  private resolveInputValueSignal(
    elementId: string,
    binding: SoloXrConsoleInputBinding,
    value: string,
  ) {
    const current = this.inputValueSignals.get(elementId);
    if (current
      && current.generation === binding.generation
      && current.semanticIdentity === binding.semanticIdentity) {
      return current.value;
    }
    const next: SoloXrTextSignalBinding = {
      generation: binding.generation,
      semanticIdentity: binding.semanticIdentity,
      value: signal(value),
    };
    this.inputValueSignals.set(elementId, next);
    return next.value;
  }

  private updateInputGeneration(inputs: readonly SoloXrConsoleInput[]) {
    if (!this.inputDrafts.update(inputs)) return;
    this.cancelPendingInputIntent();
    this.inputValueSignals.clear();
    this.inputRenderSignatures.clear();
    this.inputGeneration += 1;
  }

  private syncTaskPropertiesDraft(
    properties: SoloXrTaskPropertiesPresentation | null,
  ) {
    if (!properties) {
      if (this.taskPropertiesDraft) this.taskPropertyRenderSignatures.clear();
      this.taskPropertiesDraft = null;
      this.taskPropertyValueSignals.clear();
      return;
    }
    const draft = this.taskPropertiesDraft;
    if (!draft || draft.taskId !== properties.taskId) {
      this.taskPropertiesDraft = createTaskPropertiesDraft(properties);
      this.taskPropertyValueSignals.clear();
      this.taskPropertyRenderSignatures.clear();
      return;
    }
    if (draft.saving && taskPropertiesEqual(draft, properties)) {
      draft.dirty = false;
      draft.saving = false;
      return;
    }
    if (draft.dirty || draft.saving || taskPropertiesEqual(draft, properties)) return;
    this.taskPropertiesDraft = createTaskPropertiesDraft(properties);
    this.taskPropertyValueSignals.clear();
    this.taskPropertyRenderSignatures.clear();
  }

  private renderTaskProperties(
    properties: SoloXrTaskPropertiesPresentation | null,
  ) {
    const root = this.document?.getElementById("solo-console-root");
    root?.setProperties({ width: properties ? 1536 : 1040 });
    this.setDisplay("task-properties-pane", Boolean(properties));
    const draft = this.taskPropertiesDraft;
    if (!properties || !draft || draft.taskId !== properties.taskId) return;

    this.renderTaskPropertiesTextInput(
      "task-properties-title",
      "label",
      "Task title",
      draft.label,
    );
    this.renderTaskPropertiesTextInput(
      "task-properties-instructions",
      "instructions",
      "Task instructions",
      draft.instructions,
    );

    const typeGroup = this.document?.getElementById("task-properties-type-radio");
    if (typeGroup) {
      typeGroup.name = "ceres-solo-radio:task-type";
      for (const type of ["timed", "open", "pause"] as const) {
        const item = this.document?.getElementById(`task-properties-type-${type}`);
        if (!item) continue;
        item.name = `ceres-solo-radio:task-type-${type}`;
      }
      const signature = JSON.stringify([draft.taskId, draft.type]);
      if (this.taskPropertyRenderSignatures.get("task-properties-type-radio") !== signature) {
        typeGroup.setProperties({
          value: draft.type,
          onValueChange: (value: string) => {
            const current = this.taskPropertiesDraft;
            if (!current || current.taskId !== draft.taskId || current.saving) return;
            if (value !== "timed" && value !== "open" && value !== "pause") return;
            current.type = value;
            current.dirty = true;
            this.taskPropertyRenderSignatures.set(
              "task-properties-type-radio",
              JSON.stringify([current.taskId, current.type]),
            );
            this.renderTaskProperties(this.presentation?.taskProperties ?? null);
          },
        });
        this.taskPropertyRenderSignatures.set("task-properties-type-radio", signature);
      }
    }

    this.setDisplay("task-properties-duration-field", draft.type !== "open");
    this.setDisplay("task-properties-repetitions-field", draft.type !== "pause");
    this.setDisplay("task-properties-reset-field", draft.type !== "pause");
    this.renderTaskPropertiesSlider(
      "task-properties-duration",
      "durationS",
      0,
      300,
      1,
      draft.durationS,
      `Duration/${Math.round(draft.durationS)} s`,
    );
    this.renderTaskPropertiesSlider(
      "task-properties-repetitions",
      "repeatCount",
      1,
      20,
      1,
      draft.repeatCount,
      `Repetitions/${Math.round(draft.repeatCount)}`,
    );
    this.renderTaskPropertiesSlider(
      "task-properties-reset",
      "resetTimeS",
      MINIMUM_TASK_RESET_SECONDS,
      60,
      1,
      draft.resetTimeS,
      `Reset/${Math.round(draft.resetTimeS)} s`,
    );
    this.renderTaskPropertiesSaveState();
  }

  private renderTaskPropertiesTextInput(
    id: "task-properties-title" | "task-properties-instructions",
    field: "label" | "instructions",
    placeholder: string,
    value: string,
  ) {
    const element = this.document?.getElementById(id);
    const draft = this.taskPropertiesDraft;
    if (!element || !draft) return;
    element.name = field === "label"
      ? "ceres-solo-input:task-label"
      : "ceres-solo-input:task-instructions";
    const valueSignal = this.resolveTaskPropertyValueSignal(id, draft.taskId, value);
    const signature = JSON.stringify([draft.taskId, value, draft.saving]);
    if (this.taskPropertyRenderSignatures.get(id) === signature) return;
    element.setProperties({
      label: field === "label" ? "Title" : "Instructions",
      value: valueSignal,
      defaultValue: undefined,
      placeholder,
      disabled: draft.saving,
      opacity: draft.saving ? 0.64 : 1,
      onValueChange: (nextValue: string) => {
        const current = this.taskPropertiesDraft;
        if (!current || current.taskId !== draft.taskId || current.saving) return;
        valueSignal.value = nextValue;
        current[field] = nextValue;
        current.dirty = true;
        this.taskPropertyRenderSignatures.set(
          id,
          JSON.stringify([current.taskId, nextValue, current.saving]),
        );
        this.renderTaskPropertiesSaveState();
      },
    });
    this.taskPropertyRenderSignatures.set(id, signature);
  }

  private resolveTaskPropertyValueSignal(
    id: "task-properties-title" | "task-properties-instructions",
    taskId: string,
    value: string,
  ) {
    const current = this.taskPropertyValueSignals.get(id);
    if (current?.taskId === taskId) return current.value;
    const next: SoloXrTaskPropertySignalBinding = {
      taskId,
      value: signal(value),
    };
    this.taskPropertyValueSignals.set(id, next);
    return next.value;
  }

  private renderTaskPropertiesSlider(
    id: "task-properties-duration" | "task-properties-repetitions" | "task-properties-reset",
    field: "durationS" | "repeatCount" | "resetTimeS",
    min: number,
    max: number,
    step: number,
    value: number,
    label: string,
  ) {
    const element = this.document?.getElementById(id);
    const draft = this.taskPropertiesDraft;
    if (!element || !draft) return;
    const labelId = `${id}-label`;
    this.setText(labelId, label);
    element.name = `ceres-solo-slider:${field}`;
    const signature = JSON.stringify([draft.taskId, value, draft.saving]);
    if (this.taskPropertyRenderSignatures.get(id) === signature) return;
    element.setProperties({
      value,
      min,
      max,
      step,
      size: "md",
      leftLabel: String(min),
      rightLabel: String(max),
      pointerEvents: draft.saving ? "none" : "listener",
      opacity: draft.saving ? 0.64 : 1,
      onValueChange: (nextValue: number) => {
        const current = this.taskPropertiesDraft;
        if (!current || current.taskId !== draft.taskId || current.saving) return;
        const normalisedValue = field === "repeatCount" ? Math.round(nextValue) : nextValue;
        current[field] = normalisedValue;
        current.dirty = true;
        element.setProperties({ value: normalisedValue });
        this.setText(
          labelId,
          field === "repeatCount"
            ? `Repetitions/${normalisedValue}`
            : `${field === "durationS" ? "Duration" : "Reset"}/${Math.round(normalisedValue)} s`,
        );
        this.taskPropertyRenderSignatures.set(
          id,
          JSON.stringify([current.taskId, current[field], current.saving]),
        );
        this.renderTaskPropertiesSaveState();
      },
    });
    this.taskPropertyRenderSignatures.set(id, signature);
  }

  private renderTaskPropertiesSaveState() {
    const draft = this.taskPropertiesDraft;
    if (!draft) return;
    this.setText(
      "task-properties-status",
      draft.saving
        ? "Saving task"
        : draft.dirty
          ? "Unsaved changes"
          : "No unsaved changes",
    );
    this.setText("task-properties-save-label", draft.saving ? "Saving" : "Save task");
    this.setButtonState(
      "task-properties-save",
      draft.dirty && !draft.saving,
      false,
      "primary",
    );
  }

  private configureDocument() {
    const root = this.document?.getElementById("solo-console-root");
    if (!root) throw new Error("The Solo console root element is missing");
    root.name = "ceres-solo-horizon-workspace";
    const consolePanel = this.document?.getElementById("solo-console-panel");
    if (!consolePanel) throw new Error("The Solo console panel is missing");
    consolePanel.name = "ceres-solo-horizon-panel";
    const taskPropertiesPane = this.document?.getElementById("task-properties-pane");
    if (!taskPropertiesPane) throw new Error("The Solo task properties pane is missing");
    taskPropertiesPane.name = "ceres-solo-task-properties-panel";
    const rowsContainer = this.document?.getElementById("rows-container");
    if (!rowsContainer) throw new Error("The Solo console rows container is missing");
    this.rowsContainer = rowsContainer as unknown as Container;
    (this.rowsContainer as unknown as UIKitElement).name = "ceres-solo-scroll:rows";
    this.rowsContainer.scrollPosition.value = [0, 0];
    const actionsContainer = this.document?.getElementById("actions-container");
    if (!actionsContainer) throw new Error("The Solo console actions container is missing");
    this.actionsContainer = actionsContainer as unknown as Container;
    (this.actionsContainer as unknown as UIKitElement).name = "ceres-solo-actions";
  }

  private renderSemanticControls(presentation: SoloXrConsolePresentation) {
    if (!this.document) return;
    const visibility = presentation.controls.find(
      (control) => control.kind === "toggle" && control.id === "visibility",
    );
    const taskType = presentation.controls.find(
      (control) => control.kind === "radio" && control.id === "task-type",
    );
    const progress = presentation.controls.find(
      (control) => control.kind === "progress" && control.id === "export-progress",
    );

    this.setDisplay("visibility-control", Boolean(visibility));
    this.setDisplay("task-type-control", Boolean(taskType));
    this.setDisplay("export-progress-control", Boolean(progress));

    for (const control of [visibility]) {
      if (!control || control.kind !== "toggle") continue;
      const toggleId = `${control.id}-toggle`;
      const toggle = this.document.getElementById(toggleId);
      const stateLabel = control.checked ? control.onLabel : control.offLabel;
      this.setText(`${control.id}-value`, stateLabel);
      if (!toggle) continue;
      toggle.name = `ceres-solo-toggle:${control.id}`;
      const signature = JSON.stringify([
        control.checked,
        control.enabled,
        control.onChange(control.checked),
      ]);
      if (this.controlRenderSignatures.get(toggleId) === signature) continue;
      toggle.setProperties({
        checked: control.checked,
        disabled: !control.enabled,
        opacity: control.enabled ? 1 : 0.46,
        onCheckedChange: (checked: boolean) => {
          if (this.disposed || !this.sessionActive) return;
          const current = this.presentation?.controls.find(
            (candidate) => candidate.kind === "toggle" && candidate.id === control.id,
          );
          if (current?.kind === "toggle" && current.enabled) {
            this.dispatchIntent(current.onChange(checked));
          }
        },
      });
      this.controlRenderSignatures.set(toggleId, signature);
    }

    const taskTypeGroup = this.document.getElementById("task-type-radio");
    if (taskType && taskType.kind === "radio" && taskTypeGroup) {
      taskTypeGroup.name = "ceres-solo-radio:task-type";
      for (const option of taskType.options) {
        const item = this.document.getElementById(`task-type-${option.value}`);
        if (!item) continue;
        item.name = `ceres-solo-radio:task-type-${option.value}`;
        item.setProperties({
          disabled: !taskType.enabled,
          opacity: taskType.enabled ? 1 : 0.46,
        });
      }
      const signature = JSON.stringify([
        taskType.value,
        taskType.enabled,
        taskType.onChange(taskType.value),
      ]);
      if (this.controlRenderSignatures.get("task-type-radio") !== signature) {
        taskTypeGroup.setProperties({
          value: taskType.value,
          onValueChange: (value: string) => {
            if (this.disposed || !this.sessionActive) return;
            const current = this.presentation?.controls.find(
              (control) => control.kind === "radio" && control.id === "task-type",
            );
            if (current?.kind !== "radio" || !current.enabled) return;
            const option = current.options.find((candidate) => candidate.value === value);
            if (option) this.dispatchIntent(current.onChange(option.value));
          },
        });
        this.controlRenderSignatures.set("task-type-radio", signature);
      }
    }

    const progressBar = this.document.getElementById("export-progress-bar");
    if (progress && progress.kind === "progress" && progressBar) {
      this.setText("export-progress-label", progress.label);
      progressBar.name = "ceres-solo-progress:export";
      progressBar.setProperties({
        value: Math.round(Math.max(0, Math.min(1, progress.value)) * 100),
      });
    }
  }

  private renderRows(presentation: SoloXrConsolePresentation) {
    const container = this.rowsContainer;
    if (!container) return;
    const activeIds = new Set(presentation.rows.map(({ id }) => id));
    const orderedButtons: Button[] = [];
    for (const [id, view] of this.rowViews) {
      if (activeIds.has(id)) continue;
      this.disposeRowView(view);
      this.rowViews.delete(id);
    }
    for (const row of presentation.rows) {
      let view = this.rowViews.get(row.id);
      if (!view) {
        view = this.createRowView(row.id);
        this.rowViews.set(row.id, view);
      }
      view.button.name = `ceres-solo-row:${row.id}`;
      view.primary.setProperties({ text: row.primary });
      view.secondary.setProperties({ text: row.secondary });
      const checkboxVisible = row.control === "checkbox";
      view.checkbox.visible = checkboxVisible;
      view.checkbox.setProperties({
        display: checkboxVisible ? "flex" : "none",
        checked: row.selected,
        pointerEvents: "none",
      });
      view.button.setProperties({
        disabled: !row.enabled || row.intent === null,
        opacity: row.intent === null ? 0.72 : row.enabled ? 1 : 0.46,
        variant: row.intent === null
          ? "tertiary"
          : row.selected
            ? "primary"
            : "secondary",
      });
      orderedButtons.push(view.button);
    }
    if (orderedButtons.some((button, index) => container.children[index] !== button)) {
      for (const button of orderedButtons) container.remove(button);
      container.add(...orderedButtons);
    }
  }

  private createRowView(rowId: string): SoloXrRowView {
    const button = new Button(
      { variant: "secondary", size: "lg" },
      ["row"],
    );
    const label = new ButtonLabel(undefined, ["row-label"]);
    const checkbox = new Checkbox(
      { checked: false, pointerEvents: "none" },
      ["row-checkbox"],
    );
    const primary = new Text({ text: "" }, ["row-primary", "noninteractive"]);
    const secondary = new Text({ text: "" }, ["row-secondary", "noninteractive"]);
    label.add(checkbox, primary, secondary);
    button.add(label);
    (button as unknown as UIKitElement).addEventListener("click", (event: any) => {
      if (this.disposed) return;
      const row = this.presentation?.rows.find(({ id }) => id === rowId);
      if (!row?.enabled || !row.intent) return;
      event.stopPropagation?.();
      this.dispatchIntent(row.intent);
    });
    return { button, label, checkbox, primary, secondary };
  }

  private renderActions(presentation: SoloXrConsolePresentation) {
    const container = this.actionsContainer;
    if (!container) return;
    const activeIds = new Set(presentation.actions.map(({ id }) => id));
    const orderedButtons: Button[] = [];
    for (const [id, view] of this.actionViews) {
      if (activeIds.has(id)) continue;
      this.disposeActionView(view);
      this.actionViews.delete(id);
    }
    for (const action of presentation.actions) {
      let view = this.actionViews.get(action.id);
      if (!view) {
        view = this.createActionView(action.id);
        this.actionViews.set(action.id, view);
      }
      view.button.name = `ceres-solo-action:${action.id}`;
      view.text.setProperties({ text: action.label });
      view.button.setProperties({
        disabled: !action.enabled,
        opacity: action.enabled ? 1 : 0.46,
        width: action.group ? 188 : 188,
        variant: action.tone === "danger"
          ? "negative"
          : action.tone === "primary" || action.selected
            ? "primary"
            : "secondary",
      });
      orderedButtons.push(view.button);
    }
    if (orderedButtons.some((button, index) => container.children[index] !== button)) {
      for (const button of orderedButtons) container.remove(button);
      container.add(...orderedButtons);
    }
  }

  private createActionView(actionId: string): SoloXrActionView {
    const button = new Button(
      { variant: "secondary", size: "lg" },
      ["action"],
    );
    const label = new ButtonLabel(undefined, ["action-label"]);
    const text = new Text({ text: "" }, ["noninteractive"]);
    label.add(text);
    button.add(label);
    (button as unknown as UIKitElement).addEventListener("click", (event: any) => {
      if (this.disposed) return;
      const action = this.presentation?.actions.find(({ id }) => id === actionId);
      if (!action?.enabled) return;
      event.stopPropagation?.();
      this.dispatchIntent(action.intent);
    });
    return { button, label, text };
  }

  private resetRowsForPage() {
    this.disposeRows();
    if (this.rowsContainer) this.rowsContainer.scrollPosition.value = [0, 0];
    this.disposeActions();
    this.inputRenderSignatures.clear();
    this.controlRenderSignatures.clear();
  }

  private disposeRows() {
    for (const view of this.rowViews.values()) this.disposeRowView(view);
    this.rowViews.clear();
  }

  private disposeRowView(view: SoloXrRowView) {
    view.secondary.dispose();
    view.primary.dispose();
    view.checkbox.dispose();
    view.label.dispose();
    view.button.dispose();
  }

  private disposeActions() {
    for (const view of this.actionViews.values()) this.disposeActionView(view);
    this.actionViews.clear();
  }

  private disposeActionView(view: SoloXrActionView) {
    view.text.dispose();
    view.label.dispose();
    view.button.dispose();
  }

  private setText(id: string, text: string) {
    this.document?.getElementById(id)?.setProperties({ text });
  }

  private setDisplay(id: string, visible: boolean) {
    const element = this.document?.getElementById(id);
    if (!element) return;
    element.visible = visible;
    element.setProperties({ display: visible ? "flex" : "none" });
  }

  private setButtonState(
    id: string,
    enabled: boolean,
    selected: boolean,
    tone: "normal" | "primary" | "danger",
  ) {
    const element = this.document?.getElementById(id);
    if (!element) return;
    const variant = tone === "danger"
      ? "negative"
      : tone === "primary" || selected
        ? "primary"
        : "secondary";
    element.setProperties({
      disabled: !enabled,
      opacity: enabled ? 1 : 0.46,
      variant,
    });
  }

  private applyVisibility() {
    const active = this.sessionActive
      && this.requestedOpen;
    this.group.visible = active;
    if (this.document) this.document.intersectChildren = active;
  }
}

function createTaskPropertiesDraft(
  properties: SoloXrTaskPropertiesPresentation,
): SoloXrTaskPropertiesDraft {
  return {
    ...properties,
    dirty: false,
    saving: false,
  };
}

function taskPropertiesEqual(
  left: SoloXrTaskPropertiesDraft,
  right: SoloXrTaskPropertiesPresentation,
) {
  return left.taskId === right.taskId
    && left.label === right.label
    && left.instructions === right.instructions
    && left.type === right.type
    && left.durationS === right.durationS
    && left.repeatCount === right.repeatCount
    && left.resetTimeS === right.resetTimeS;
}
