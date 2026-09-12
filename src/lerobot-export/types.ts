import type { AccountUploadManifestArtefact } from "../../shared/export-destination.js";
import type { Episode } from "../../shared/protocol.js";
import { WorkerErrorDetail } from "../worker-errors.js";
import type { ExportVideoPreparationProfile } from "./media.js";

export type MonitorExportStage =
  | "queued"
  | "reading"
  | "reducing"
  | "media"
  | "writing"
  | "uploading"
  | "completed"
  | "cancelled"
  | "failed";

export type MonitorExportFfmpegStage =
  | "ffmpeg_load"
  | "ffmpeg_write"
  | "ffmpeg_exec"
  | "ffmpeg_read"
  | "ffmpeg_inspect";

export type MonitorExportErrorStage = MonitorExportStage | MonitorExportFfmpegStage;

export interface MonitorExportStartMessage {
  type: "start";
  requestId: string;
  sessionId: string;
  episodeIds: string[];
  exportCapability?: string;
  source?: "server" | "monitor-opfs" | "solo-opfs";
  monitorEpisodes?: Episode[];
  monitorRecorderRateHz?: number;
  episodeIndexBase?: number;
  globalFrameIndexBase?: number;
  directoryHandle?: FileSystemDirectoryHandle;
}

export interface MonitorExportCancelMessage {
  type: "cancel";
  requestId: string;
}

export type MonitorExportWorkerRequest = MonitorExportStartMessage | MonitorExportCancelMessage;

export interface MonitorExportProgressEvent {
  type: "progress";
  requestId: string;
  stage: MonitorExportStage;
  detail: string;
  completed: number;
  total: number;
  episodeId?: string;
  backend?: string;
}

export interface MonitorExportMediaProfileEvent {
  type: "media-profile";
  requestId: string;
  episodeId: string;
  profile: ExportVideoPreparationProfile;
}

export interface MonitorExportCompleteEvent {
  type: "complete";
  requestId: string;
  episodeCount: number;
  artifactCount: number;
  episodeIds: string[];
  artefacts: AccountUploadManifestArtefact[];
}

export interface MonitorExportErrorEvent {
  type: "error";
  requestId: string;
  error: string;
  errorType?: string;
  errorTelemetry?: WorkerErrorDetail;
  stage?: MonitorExportErrorStage;
  cancelled: boolean;
}

export type MonitorExportWorkerEvent =
  | MonitorExportProgressEvent
  | MonitorExportMediaProfileEvent
  | MonitorExportCompleteEvent
  | MonitorExportErrorEvent;

export interface StoredExportArtifact extends AccountUploadManifestArtefact {
  file: File;
}
