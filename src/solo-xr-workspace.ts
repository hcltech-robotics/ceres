import type { SessionSnapshot } from "../shared/protocol.js";
import { SoloXrConsole } from "./solo-xr-console.js";
import {
  buildSoloXrConsolePresentation,
  type SoloXrConsoleAccountPresentation,
  type SoloXrConsoleExportState,
  type SoloXrConsoleImportState,
  type SoloXrConsoleIntent,
  type SoloXrConsolePage,
} from "./solo-xr-console-presentation.js";

export interface SoloXrConsoleState {
  snapshot: SessionSnapshot;
  account?: SoloXrConsoleAccountPresentation;
  importState?: SoloXrConsoleImportState;
  exportState?: SoloXrConsoleExportState;
  notice?: string | null;
  selectedEpisodeIds?: readonly string[];
  focusedTaskId?: string | null;
  page?: SoloXrConsolePage;
  pendingDelete?: Readonly<{ episodeId: string; label: string }> | null;
  finalising?: boolean;
  sessionRecovery?: "new" | "restored" | "active";
}

export interface SoloXrWorkspaceOptions {
  onIntent: (intent: SoloXrConsoleIntent) => boolean | void | Promise<boolean | void>;
  onOpenChange?: (open: boolean) => void;
}

export class SoloXrWorkspace {
  private console: SoloXrConsole | null = null;
  private state: SoloXrConsoleState | null = null;
  private page: SoloXrConsolePage = "run";
  private focusedTaskId: string | null = null;
  private readonly selectedEpisodes = new Set<string>();
  private intentTail: Promise<void> = Promise.resolve();
  private sessionActive = false;
  private disposed = false;

  constructor(private readonly options: SoloXrWorkspaceOptions) {}

  get open() {
    return this.console?.open === true;
  }

  mount(world: any) {
    if (this.disposed) throw new Error("A disposed Solo XR workspace cannot be mounted");
    if (this.console) return;
    this.console = new SoloXrConsole(world, {
      onIntent: (intent) => this.handleIntent(intent),
    });
    this.console.setSessionActive(this.sessionActive);
    this.render();
    this.emitOpenState();
  }

  setSessionActive(active: boolean) {
    this.sessionActive = active;
    this.console?.setSessionActive(active);
    this.emitOpenState();
  }

  update(state: SoloXrConsoleState) {
    if (this.disposed) return;
    this.state = {
      ...state,
      snapshot: structuredClone(state.snapshot),
      account: state.account ? { ...state.account } : undefined,
      importState: state.importState ? structuredClone(state.importState) : undefined,
      exportState: state.exportState ? { ...state.exportState } : undefined,
      pendingDelete: state.pendingDelete ? { ...state.pendingDelete } : null,
      selectedEpisodeIds: state.selectedEpisodeIds ? [...state.selectedEpisodeIds] : undefined,
    };
    if (state.page) this.page = state.page;
    if (state.focusedTaskId !== undefined) this.focusedTaskId = state.focusedTaskId;
    if (state.selectedEpisodeIds) {
      this.selectedEpisodes.clear();
      for (const episodeId of state.selectedEpisodeIds) this.selectedEpisodes.add(episodeId);
    }
    this.render();
  }

  restorePage(page: SoloXrConsolePage) {
    this.page = page;
    this.render();
  }

  show() {
    if (this.open) return;
    this.console?.show();
    this.render();
    this.emitOpenState();
  }

  hide() {
    if (!this.open) return;
    this.console?.hide();
    this.render();
    this.emitOpenState();
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  unmount() {
    const mountedConsole = this.console;
    this.console = null;
    this.sessionActive = false;
    mountedConsole?.dispose();
    this.emitOpenState();
  }

  dispose() {
    if (this.disposed) return;
    this.unmount();
    this.disposed = true;
    this.state = null;
  }

  private handleIntent(intent: SoloXrConsoleIntent) {
    const operation = this.intentTail.then(() => this.applyAcknowledgedIntent(intent));
    this.intentTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyAcknowledgedIntent(intent: SoloXrConsoleIntent) {
    const accepted = await this.options.onIntent(structuredClone(intent));
    if (accepted === false || this.disposed) return false;
    if (intent.type === "navigate") {
      this.page = intent.page;
    } else if (intent.type === "close-console") {
      this.hide();
    } else if (intent.type === "open-console") {
      this.show();
    } else if (intent.type === "select-start-task") {
      this.hide();
    } else if (intent.type === "draft-focus-task") {
      this.focusedTaskId = intent.taskId;
    } else if (intent.type === "episode-select") {
      if (intent.selected) this.selectedEpisodes.add(intent.episodeId);
      else this.selectedEpisodes.delete(intent.episodeId);
    }
    this.render();
    return true;
  }

  private render() {
    const state = this.state;
    if (this.console && state) {
      this.console.update(buildSoloXrConsolePresentation(state.snapshot, {
        page: this.page,
        focusedTaskId: this.focusedTaskId,
        selectedEpisodeIds: this.selectedEpisodes,
        account: state.account,
        importState: state.importState,
        exportState: state.exportState,
        notice: state.notice,
        pendingDelete: state.pendingDelete,
        finalising: state.finalising,
        sessionRecovery: state.sessionRecovery,
      }));
    }
  }

  private emitOpenState() {
    this.options.onOpenChange?.(this.sessionActive && this.open);
  }
}
