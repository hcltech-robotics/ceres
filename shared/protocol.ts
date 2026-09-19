import type { HandDisplaySettings } from "./hand-display.js";
import type { CameraRegistration } from "./camera-registration.js";
import type { CameraCaptureFrame } from "./camera-capture-frame.js";
import type { CaptureMetadata } from "./capture-metadata.js";
import type { CeresTaskSpecification } from "./task-specification.js";
import type {
  AccountUploadManifestArtefact,
  HuggingFaceAppendAllocation,
  HuggingFaceMissingRepositoryBehaviour,
} from "./export-destination.js";
import { MINIMUM_TASK_RESET_SECONDS } from "./run-sequencing.js";

export type ClientRole = "capture" | "monitor" | "monitor-control" | "recorder";
export type SessionTelemetryMode = "standard" | "disabled";

export function normaliseSessionTelemetryMode(
  value: unknown,
  missing: SessionTelemetryMode = "standard",
): SessionTelemetryMode {
  if (value === undefined) return missing;
  return value === "standard" ? "standard" : "disabled";
}

export const CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE = 4401;
export const CAPTURE_PAIRING_REJECTED_CLOSE_CODE = 4403;
export const PAIRING_CONNECTION_ACTIVE_CLOSE_CODE = 4409;

export type CapturePairingRejectionCode =
  | "capture-pairing-required"
  | "capture-already-paired"
  | "capture-superseded"
  | "capture-session-restarted"
  | "recorder-pairing-required"
  | "recorder-pairing-pending"
  | "recorder-pairing-rejected"
  | "recorder-superseded";

export const RECORDER_BLOCK_MAGIC = 0x31425243;
export const RECORDER_BLOCK_VERSION = 1;
export const RECORDER_BLOCK_HEADER_BYTES = 48;
export const RECORDER_BLOCK_CHECKSUM_OFFSET = 40;

export enum RecorderBlockFlags {
  Gap = 1 << 0,
  SensorFrameJson = 1 << 1,
  RunEvent = 1 << 2,
  MediaChunk = 1 << 3,
  AudioChunk = 1 << 4,
}

export type RecorderRunEvent =
  | {
    type: "segment-start" | "segment-end";
    segmentId: string;
    taskId: string;
    taskLabel: string;
  }
  | {
    type: "annotation";
    segmentId: string;
    annotationId: string;
    action: "pass" | "fail" | "retry" | "next";
    actor: "director" | "demonstrator";
  };

export interface RecorderBlockInput {
  sessionId: string;
  episodeId: string;
  sequence: number;
  recorderFrameIndex: number;
  sourceTimestampUs: number;
  flags: number;
  payload: Uint8Array;
}

export interface RecorderBlock extends RecorderBlockInput {
  checksum: number;
}

export type RecorderErrorCode =
  | "invalid-block"
  | "checksum-mismatch"
  | "session-mismatch"
  | "episode-mismatch"
  | "not-capture"
  | "not-recording"
  | "out-of-order"
  | "sequence-conflict"
  | "write-failed"
  | "storage-unsafe";

export class RecorderProtocolError extends Error {
  readonly code: RecorderErrorCode;
  readonly sequence?: number;
  readonly sessionId?: string;

  constructor(code: RecorderErrorCode, message: string, context: { sequence?: number; sessionId?: string } = {}) {
    super(message);
    this.name = "RecorderProtocolError";
    this.code = code;
    this.sequence = context.sequence;
    this.sessionId = context.sessionId;
  }
}

const recorderTextEncoder = new TextEncoder();
const recorderTextDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeRecorderBlock(input: RecorderBlockInput): Uint8Array {
  const sessionId = recorderTextEncoder.encode(input.sessionId);
  const episodeId = recorderTextEncoder.encode(input.episodeId);
  if (sessionId.byteLength === 0 || sessionId.byteLength > 0xffff) throw new RecorderProtocolError("invalid-block", "Recorder session identifier length is invalid");
  if (episodeId.byteLength === 0 || episodeId.byteLength > 0xffff) throw new RecorderProtocolError("invalid-block", "Recorder episode identifier length is invalid");
  if (input.payload.byteLength > 0xffffffff) throw new RecorderProtocolError("invalid-block", "Recorder payload is too large");
  assertRecorderInteger("sequence", input.sequence);
  assertRecorderInteger("recorder frame index", input.recorderFrameIndex);
  assertRecorderInteger("source timestamp", input.sourceTimestampUs);
  if (!Number.isInteger(input.flags) || input.flags < 0 || input.flags > 0xffff) throw new RecorderProtocolError("invalid-block", "Recorder flags are invalid");

  const output = new Uint8Array(RECORDER_BLOCK_HEADER_BYTES + sessionId.byteLength + episodeId.byteLength + input.payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, RECORDER_BLOCK_MAGIC, true);
  view.setUint8(4, RECORDER_BLOCK_VERSION);
  view.setUint8(5, RECORDER_BLOCK_HEADER_BYTES);
  view.setUint16(6, input.flags, true);
  view.setBigUint64(8, BigInt(input.sequence), true);
  view.setBigUint64(16, BigInt(input.recorderFrameIndex), true);
  view.setBigUint64(24, BigInt(input.sourceTimestampUs), true);
  view.setUint32(32, input.payload.byteLength, true);
  view.setUint16(36, sessionId.byteLength, true);
  view.setUint16(38, episodeId.byteLength, true);
  view.setUint32(44, 0, true);
  let offset = RECORDER_BLOCK_HEADER_BYTES;
  output.set(sessionId, offset);
  offset += sessionId.byteLength;
  output.set(episodeId, offset);
  offset += episodeId.byteLength;
  output.set(input.payload, offset);
  view.setUint32(RECORDER_BLOCK_CHECKSUM_OFFSET, recorderBlockChecksum(output), true);
  return output;
}

export function decodeRecorderBlock(value: Uint8Array): RecorderBlock {
  if (value.byteLength < RECORDER_BLOCK_HEADER_BYTES) throw new RecorderProtocolError("invalid-block", "Recorder block is shorter than its fixed header");
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const sequence = safeRecorderInteger(view.getBigUint64(8, true), "sequence");
  if (view.getUint32(0, true) !== RECORDER_BLOCK_MAGIC) throw new RecorderProtocolError("invalid-block", "Recorder block magic is invalid", { sequence });
  if (view.getUint8(4) !== RECORDER_BLOCK_VERSION) throw new RecorderProtocolError("invalid-block", "Recorder block version is unsupported", { sequence });
  if (view.getUint8(5) !== RECORDER_BLOCK_HEADER_BYTES) throw new RecorderProtocolError("invalid-block", "Recorder block header length is invalid", { sequence });
  if (view.getUint32(44, true) !== 0) throw new RecorderProtocolError("invalid-block", "Recorder block reserved field must be zero", { sequence });

  const totalLength = recorderBlockByteLength(value);
  if (totalLength !== value.byteLength) throw new RecorderProtocolError("invalid-block", "Recorder block length does not match its header", { sequence });
  const expectedChecksum = view.getUint32(RECORDER_BLOCK_CHECKSUM_OFFSET, true);
  if (recorderBlockChecksum(value) !== expectedChecksum) throw new RecorderProtocolError("checksum-mismatch", "Recorder block checksum does not match", { sequence });

  const sessionLength = view.getUint16(36, true);
  const episodeLength = view.getUint16(38, true);
  let offset = RECORDER_BLOCK_HEADER_BYTES;
  let sessionId: string;
  let episodeId: string;
  try {
    sessionId = recorderTextDecoder.decode(value.subarray(offset, offset + sessionLength));
    offset += sessionLength;
    episodeId = recorderTextDecoder.decode(value.subarray(offset, offset + episodeLength));
  } catch {
    throw new RecorderProtocolError("invalid-block", "Recorder identifiers are not valid UTF-8", { sequence });
  }
  if (!sessionId || !episodeId) throw new RecorderProtocolError("invalid-block", "Recorder identifiers must not be empty", { sequence, sessionId });
  offset += episodeLength;
  return {
    sessionId,
    episodeId,
    sequence,
    recorderFrameIndex: safeRecorderInteger(view.getBigUint64(16, true), "recorder frame index"),
    sourceTimestampUs: safeRecorderInteger(view.getBigUint64(24, true), "source timestamp"),
    flags: view.getUint16(6, true),
    checksum: expectedChecksum,
    payload: value.subarray(offset),
  };
}

export function recorderBlockByteLength(value: Uint8Array, offset = 0): number {
  if (!Number.isInteger(offset) || offset < 0 || value.byteLength - offset < RECORDER_BLOCK_HEADER_BYTES) {
    throw new RecorderProtocolError("invalid-block", "Recorder journal contains a truncated header");
  }
  const view = new DataView(value.buffer, value.byteOffset + offset, value.byteLength - offset);
  if (view.getUint32(0, true) !== RECORDER_BLOCK_MAGIC || view.getUint8(4) !== RECORDER_BLOCK_VERSION || view.getUint8(5) !== RECORDER_BLOCK_HEADER_BYTES) {
    throw new RecorderProtocolError("invalid-block", "Recorder journal contains an invalid block header");
  }
  return RECORDER_BLOCK_HEADER_BYTES + view.getUint16(36, true) + view.getUint16(38, true) + view.getUint32(32, true);
}

export function recorderBlockChecksum(value: Uint8Array): number {
  let checksum = 0xffffffff;
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = index >= RECORDER_BLOCK_CHECKSUM_OFFSET && index < RECORDER_BLOCK_CHECKSUM_OFFSET + 4 ? 0 : value[index];
    checksum = (checksum >>> 8) ^ crc32Table[(checksum ^ byte) & 0xff];
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export function encodeRecorderMediaPayload(mimeType: string, data: Uint8Array): Uint8Array {
  const mime = recorderTextEncoder.encode(mimeType);
  if (mime.byteLength === 0 || mime.byteLength > 0xffff) throw new RecorderProtocolError("invalid-block", "Recorder media MIME type length is invalid");
  const output = new Uint8Array(2 + mime.byteLength + data.byteLength);
  new DataView(output.buffer).setUint16(0, mime.byteLength, true);
  output.set(mime, 2);
  output.set(data, 2 + mime.byteLength);
  return output;
}

export function decodeRecorderMediaPayload(payload: Uint8Array): { mimeType: string; data: Uint8Array } {
  if (payload.byteLength < 3) throw new RecorderProtocolError("invalid-block", "Recorder media payload is truncated");
  const mimeLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, true);
  if (mimeLength === 0 || 2 + mimeLength > payload.byteLength) throw new RecorderProtocolError("invalid-block", "Recorder media MIME header is invalid");
  let mimeType: string;
  try {
    mimeType = recorderTextDecoder.decode(payload.subarray(2, 2 + mimeLength));
  } catch {
    throw new RecorderProtocolError("invalid-block", "Recorder media MIME type is not valid UTF-8");
  }
  return { mimeType, data: payload.subarray(2 + mimeLength) };
}

export function encodeRecorderRunEvent(event: RecorderRunEvent): Uint8Array {
  assertRecorderRunEvent(event);
  return recorderTextEncoder.encode(JSON.stringify(event));
}

export function decodeRecorderRunEvent(payload: Uint8Array): RecorderRunEvent {
  let value: unknown;
  try {
    value = JSON.parse(recorderTextDecoder.decode(payload));
  } catch {
    throw new RecorderProtocolError("invalid-block", "Recorder run event is not valid UTF-8 JSON");
  }
  assertRecorderRunEvent(value);
  return value;
}

function assertRecorderRunEvent(value: unknown): asserts value is RecorderRunEvent {
  if (!value || typeof value !== "object") {
    throw new RecorderProtocolError("invalid-block", "Recorder run event must be an object");
  }
  const event = value as Partial<RecorderRunEvent> & Record<string, unknown>;
  if (typeof event.segmentId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(event.segmentId)) {
    throw new RecorderProtocolError("invalid-block", "Recorder run event segment identity is invalid");
  }
  if (event.type === "segment-start" || event.type === "segment-end") {
    assertRecorderRunEventKeys(event, ["type", "segmentId", "taskId", "taskLabel"]);
    if (typeof event.taskId !== "string" || !event.taskId.trim() || typeof event.taskLabel !== "string" || !event.taskLabel.trim()) {
      throw new RecorderProtocolError("invalid-block", "Recorder segment event task metadata is invalid");
    }
    return;
  }
  if (event.type === "annotation") {
    assertRecorderRunEventKeys(event, ["type", "segmentId", "annotationId", "action", "actor"]);
    if (typeof event.annotationId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/.test(event.annotationId)
      && (event.action === "pass" || event.action === "fail" || event.action === "retry" || event.action === "next")
      && (event.actor === "director" || event.actor === "demonstrator")) return;
  }
  throw new RecorderProtocolError("invalid-block", "Recorder run event type is unsupported");
}

function assertRecorderRunEventKeys(event: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(event);
  if (actual.length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(event, key))) {
    throw new RecorderProtocolError("invalid-block", "Recorder run event contains unsupported fields");
  }
}

const crc32Table = new Uint32Array(256);
for (let index = 0; index < crc32Table.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crc32Table[index] = value >>> 0;
}

function assertRecorderInteger(label: string, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RecorderProtocolError("invalid-block", `Recorder ${label} is invalid`);
}

function safeRecorderInteger(value: bigint, label: string): number {
  const number = Number(value);
  assertRecorderInteger(label, number);
  return number;
}

export type WebRtcSignal = {
  negotiationId?: string;
  description?: { type: string; sdp?: string };
  candidate?: {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
  turnPermit?: {
    permitId: string;
    expiresAt: string;
    iceServers: Array<{
      urls: string | string[];
      username?: string;
      credential?: string;
      credentialType?: "password" | "oauth";
    }>;
  };
};

export function isWebRtcNegotiationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function webRtcSignalNegotiationId(value: unknown, peerId: string) {
  if (value === undefined) return `legacy:${peerId}`;
  return isWebRtcNegotiationId(value) ? value : null;
}

export interface Vec3 { x: number; y: number; z: number; }
export interface Quat { x: number; y: number; z: number; w: number; }
export interface Transform { position: Vec3; rotation: Quat; }
export type CameraSide = "left" | "right" | "unknown";

export interface CameraViewPose {
  side: Exclude<CameraSide, "unknown"> | "none";
  transform: Transform;
  projectionMatrix: number[];
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface HandState {
  tracked: boolean;
  joints: Record<string, Transform & { radius?: number }>;
  pinch: number;
}

export interface ProjectedHandJoint {
  x: number;
  y: number;
  inFrame: boolean;
}

export interface ProjectedHandState {
  tracked: boolean;
  joints: Record<string, ProjectedHandJoint>;
}

export interface HandCameraProjection {
  source: "calibrated-media-camera";
  cameraSide: CameraSide;
  width: number;
  height: number;
  leftHand: ProjectedHandState;
  rightHand: ProjectedHandState;
}

export interface SensorFrame {
  timestampMs: number;
  frameIndex: number;
  head: Transform | null;
  cameraSide?: CameraSide;
  camera?: CameraViewPose | null;
  handProjection?: HandCameraProjection | null;
  leftHand: HandState;
  rightHand: HandState;
  sceneStatus: { planes: boolean; meshes: boolean; anchors: boolean };
}

export interface TaskIdentity {
  id: string;
  label: string;
  instructions: string;
}

export interface RepetitionPlan {
  repeatCount: number;
  resetTimeS: number;
}

export interface TimedTaskDefinition extends TaskIdentity, RepetitionPlan {
  type: "timed";
  durationS: number;
}

export interface OpenTaskDefinition extends TaskIdentity, RepetitionPlan {
  type: "open";
  durationS?: never;
}

export interface PauseTaskDefinition extends TaskIdentity {
  type: "pause";
  durationS: number;
}

export type TaskDefinition = TimedTaskDefinition | OpenTaskDefinition | PauseTaskDefinition;

export const CAPTURE_CONFIGURATION_SCHEMA_VERSION = 5 as const;

export type TextToSpeechProvider = "browser";
export type SpeechToTextProvider = "gateway";

export interface CaptureStudyMetadata {
  headsetId: string;
  demonstratorId: string;
  projectId: string;
  consentDate: string;
  consentDocumentId: string;
}

export interface CaptureConfiguration {
  schemaVersion: typeof CAPTURE_CONFIGURATION_SCHEMA_VERSION;
  runTitle: string;
  runDescription: string;
  totalCycles: number;
  tasks: TaskDefinition[];
  recorderRateHz: number;
  recordAudio: boolean;
  studyMetadata: CaptureStudyMetadata;
  sttProvider: SpeechToTextProvider;
  uploadAfterEpisode: boolean;
  hfRepository: string;
  hfPrivate: boolean;
  promptAudio: PromptAudioConfiguration;
}

export interface PromptAudioConfiguration {
  enabled: boolean;
  required: boolean;
  useTextToSpeech: boolean;
  ttsProvider: TextToSpeechProvider;
  taskStartAssetUrl: string;
  resetAssetUrl: string;
  completionAssetUrl: string;
}

export type CaptureSensorSource = "none" | "synthetic" | "iwer" | "native-webxr";

export function classifyCaptureSensorSource(signals: {
  synthetic: boolean;
  iwerDevice: boolean;
  metaManagedXr: boolean;
  nativeWebXr: boolean;
}): CaptureSensorSource {
  if (signals.synthetic) return "synthetic";
  if (signals.iwerDevice || signals.metaManagedXr) return "iwer";
  if (signals.nativeWebXr) return "native-webxr";
  return "none";
}

/**
 * Solo records hand demonstrations, so a run may only begin once both hands are
 * tracked. A hand holding a controller reports no joints, which is what keeps a
 * controller-driven menu selection from starting a run with missing hand data.
 */
export function soloHandsReadyToRecord(status: Pick<CaptureStatus, "leftHandTracked" | "rightHandTracked">) {
  return status.leftHandTracked === true && status.rightHandTracked === true;
}

export interface CaptureStatus {
  headsetModel: string | null;
  sensorSource?: CaptureSensorSource;
  questBrowser?: boolean;
  xrFrameCount?: number;
  viewerPoseFrameCount?: number;
  leftHandJointPoseCount?: number;
  rightHandJointPoseCount?: number;
  camera: "idle" | "requesting" | "ready" | "error";
  xr: "idle" | "requesting" | "active" | "ended" | "error";
  transport: "idle" | "connecting" | "connected" | "failed";
  selectedCameraDeviceId: string | null;
  selectedCameraLabel: string | null;
  selectedCameraWidth: number | null;
  selectedCameraHeight: number | null;
  selectedCameraFrame: CameraCaptureFrame | null;
  selectedCameraFrameRate: number | null;
  selectedCameraSide: CameraSide;
  handTracking: "waiting" | "active" | "unavailable";
  /**
   * Live per-hand tracking, unlike the cumulative joint pose counters above.
   * A hand holding a controller is not tracked, so Solo uses these to hold the
   * start countdown until the demonstrator has both hands free.
   */
  leftHandTracked?: boolean;
  rightHandTracked?: boolean;
  recorder: "idle" | "arming" | "armed" | "recording" | "paused" | "failed";
  recorderRateHz: number;
  recorderFrameIndex: number;
  recorderGaps: number;
  recorderPendingBlocks: number;
  recorderQueuedBlocks: number;
  recorderDurableAckSequence: number;
  recorderFinaliseStartAckSequence: number | null;
  recorderFinaliseTargetSequence: number | null;
  sensorRateHz: number;
  lastFrameAt: number | null;
  lastError: string | null;
}

export type EpisodeSegmentAnnotationAction = "pass" | "fail" | "retry" | "next";

export interface EpisodeSegmentAnnotation {
  id: string;
  action: EpisodeSegmentAnnotationAction;
  actor: "director" | "demonstrator";
  timestampMs: number;
  sourceTimestampUs?: number;
}

export interface EpisodeSegment {
  id: string;
  taskId: string;
  taskLabel: string;
  taskDescription: string;
  repetition: number;
  take: number;
  startedAt: string;
  endedAt?: string;
  startSourceTimestampUs?: number;
  endSourceTimestampUs?: number;
  frameCount?: number;
  gapCount?: number;
  recorderSlotCount?: number;
  outcome: "recording" | "completed" | "retry" | "stopped";
  accepted: boolean;
  annotations: EpisodeSegmentAnnotation[];
}

export interface Episode {
  id: string;
  runTitle: string;
  runDescription: string;
  taskId: string | null;
  taskLabel: string;
  taskDescription: string;
  cycle: number;
  repetition: number;
  take: number;
  startedAt: string;
  endedAt?: string;
  outcome: "recording" | "completed" | "successful" | "failed" | "retry" | "stopped";
  annotation: "pass" | "fail" | null;
  accepted: boolean;
  integrity: "pending" | "valid" | "interrupted";
  integrityReason?: string;
  recorderAcceptedAt?: string;
  /** Durable successful run termination state. Absent on non-terminal and legacy episodes. */
  runFinalisation?: "finish-requested" | "finish-completed";
  /** Configuration generation that created this episode. Absent on legacy episodes. */
  configurationRevision?: number;
  frameCount: number;
  mediaChunkCount: number;
  recorderSlotCount?: number;
  gapCount?: number;
  firstRecorderSequence?: number;
  lastRecorderSequence?: number;
  qualitySummary: CaptureQualitySummary;
  qualityEvents: CaptureQualityEvent[];
  /** Frozen capture provenance. Absent on recordings created before metadata v1. */
  captureMetadata?: CaptureMetadata;
  huggingFaceUpload?: EpisodeHuggingFaceUpload;
  /** Frozen task provenance. All three fields are absent on legacy episodes. */
  taskSpecVersion?: number;
  taskSpecHash?: string;
  taskSpecification?: CeresTaskSpecification;
  /** Solo operating provenance. All three fields are absent on non-Solo and legacy episodes. */
  operatingMode?: SessionOperatingMode;
  selectedStartTaskId?: string;
  startCountdownMs?: number;
  /** Task attempts within cycle-scoped episodes. Absent on legacy task-scoped episodes. */
  segments?: EpisodeSegment[];
}

export interface EpisodeHuggingFaceUpload {
  state: "completed";
  /** Client correlation identity for a backend-verified completion write. Absent on legacy metadata. */
  requestId?: string;
  /** Opaque backend upload job identity. Absent on legacy upload metadata. */
  jobId?: string;
  /** CERES session bound into the backend completion receipt. Absent on legacy metadata. */
  captureSessionId?: string;
  /** Exact sorted episode selection bound into the backend completion receipt. Absent on legacy metadata. */
  episodeIds?: string[];
  /** Opaque signed backend proof. Absent on legacy metadata. */
  completionReceipt?: string;
  /** Manifest and commit claims copied from the verified receipt. Absent on legacy metadata. */
  manifestHash?: string;
  visibility?: "private" | "public";
  commitUrl?: string;
  verifiedAt?: string;
  repository: string;
  branch: string;
  outcome: "uploaded" | "unchanged";
  uploadedAt: string;
  /** Legacy browser-authored accounting. New verified writes omit these unsigned fields. */
  artifactCount?: number;
  uploadedCount?: number;
  skippedCount?: number;
  commitOid?: string;
}

export interface VerifiedEpisodeHuggingFaceUpload extends EpisodeHuggingFaceUpload {
  requestId: string;
  jobId: string;
  captureSessionId: string;
  episodeIds: string[];
  completionReceipt: string;
  manifestHash: string;
  visibility: "private" | "public";
  commitUrl: string;
  verifiedAt: string;
  commitOid: string;
}

export function assertVerifiedEpisodeHuggingFaceUpload(
  upload: EpisodeHuggingFaceUpload,
  captureSessionId: string,
  episodeIds: readonly string[],
): asserts upload is VerifiedEpisodeHuggingFaceUpload {
  const expectedEpisodeIds = [...episodeIds].sort(compareProtocolText);
  const receivedEpisodeIds = Array.isArray(upload.episodeIds)
    ? [...upload.episodeIds]
    : [];
  if (
    upload.state !== "completed"
    || typeof upload.requestId !== "string"
    || !/^hf_upload_[A-Za-z0-9_-]{24}$/.test(upload.requestId)
    || typeof upload.jobId !== "string"
    || upload.jobId !== upload.requestId
    || upload.captureSessionId !== captureSessionId
    || expectedEpisodeIds.length === 0
    || expectedEpisodeIds.length > 100
    || new Set(expectedEpisodeIds).size !== expectedEpisodeIds.length
    || expectedEpisodeIds.some((episodeId) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(episodeId))
    || receivedEpisodeIds.length !== expectedEpisodeIds.length
    || !receivedEpisodeIds.every((episodeId, index) => episodeId === expectedEpisodeIds[index])
    || typeof upload.completionReceipt !== "string"
    || !upload.completionReceipt.startsWith("ceres-hf-upload-receipt.v1.")
    || upload.completionReceipt.length > 8_192
    || typeof upload.manifestHash !== "string"
    || !/^[a-f0-9]{64}$/.test(upload.manifestHash)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(upload.repository)
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(upload.branch)
    || upload.branch.includes("..")
    || upload.branch.includes("//")
    || upload.branch.includes("@{")
    || upload.branch.endsWith("/")
    || upload.branch.endsWith(".")
    || upload.branch.endsWith(".lock")
    || upload.branch.split("/").some((segment) => segment === "." || segment === "..")
    || (upload.visibility !== "private" && upload.visibility !== "public")
    || upload.outcome !== "uploaded"
    || !isCanonicalProtocolTimestamp(upload.uploadedAt)
    || typeof upload.verifiedAt !== "string"
    || !isCanonicalProtocolTimestamp(upload.verifiedAt)
    || Date.parse(upload.uploadedAt) < Date.parse(upload.verifiedAt)
    || typeof upload.commitOid !== "string"
    || !/^[a-f0-9]{40,64}$/.test(upload.commitOid)
    || typeof upload.commitUrl !== "string"
    || !isVerifiedHuggingFaceCommitUrl(upload.commitUrl, upload.repository, upload.commitOid)
    || upload.artifactCount !== undefined
    || upload.uploadedCount !== undefined
    || upload.skippedCount !== undefined
  ) {
    throw new Error("Hugging Face upload metadata does not carry a verified backend receipt");
  }
}

function compareProtocolText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalProtocolTimestamp(value: string) {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isVerifiedHuggingFaceCommitUrl(value: string, repository: string, commitOid: string) {
  if (value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "huggingface.co"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === `/datasets/${repository}/commit/${commitOid}`;
  } catch {
    return false;
  }
}

export interface CaptureQualitySummary {
  decision: "go" | "caution" | "stop";
  reasons: string[];
  frameCount: number;
  gapCount: number;
  maxLeftHandSpeedMps: number;
  maxRightHandSpeedMps: number;
  slowHandEvents: number;
  trackingLossEvents: number;
}

export interface CaptureQualityEvent {
  timestampMs: number;
  type: "slow-hands" | "tracking-loss" | "gap";
  hand?: "left" | "right";
  value?: number;
  detail?: string;
}

export interface CaptureJob {
  id: string;
  type: "export" | "upload";
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  detail: string;
  createdAt: string;
  updatedAt: string;
  browserRecovery?: {
    destination: "opfs" | "folder" | "hugging-face";
    episodeIds: string[];
    repository?: string;
    branch?: string;
    visibility?: "private" | "public";
    missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
    uploadMode?: "account" | "headset";
    uploadPrincipal?: string;
    accountUploadJobId?: string;
    appendAllocation?: HuggingFaceAppendAllocation;
    cancellationPending?: boolean;
    artefacts?: AccountUploadManifestArtefact[];
  };
}

export interface PromptDelivery {
  id: string;
  transition: "task-start" | "reset" | "completion";
  text: string;
  assetUrl: string;
  state: "queued" | "started" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptAudioStatus {
  state: "locked" | "ready" | "unavailable" | "error";
  detail: string;
}

export type DirectBeamDeliveryState = "received" | "visual-presented";

export interface DirectBeamCommand {
  type: "beam";
  deliveryId: string;
  text: string;
  speak: boolean;
  visual: boolean;
}

export interface DirectBeamAcknowledgement {
  type: "beam-ack";
  deliveryId: string;
  state: DirectBeamDeliveryState;
}

export interface DirectTaskPresentationAcknowledgement {
  type: "task-presented";
  revision: number;
  taskId: string;
  state: "assigned" | "active";
}

const directBeamDeliveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDirectBeamDeliveryId(value: unknown): value is string {
  return typeof value === "string" && directBeamDeliveryIdPattern.test(value);
}

export interface RuntimeFeatures {
  speech: boolean;
  relayedConnection?: boolean;
}

export type SessionOperatingMode = "paired" | "direct" | "solo";

export const DEFAULT_SOLO_START_COUNTDOWN_MS = 3_000;
export const MAX_SOLO_START_COUNTDOWN_MS = 60_000;
export const SOLO_MINIMUM_STORAGE_HEADROOM_BYTES = 512 * 1024 * 1024;

export interface SoloSessionPreferences {
  startCountdownMs: number;
}

export type SoloWorkspacePage = "run" | "tasks" | "import" | "episodes" | "export";

export interface SoloWorkspaceRepositorySettings {
  organisation: string;
  repository: string;
  branch: string;
  visibility: "private" | "public";
  missingRepositoryBehaviour: HuggingFaceMissingRepositoryBehaviour;
}

export type SoloExportDestinationPreference = "local" | "hugging-face";
export type SoloHuggingFaceSaveCadence = "cycle" | "run";

export interface SoloWorkspaceExportSettings {
  destination: SoloExportDestinationPreference;
  huggingFaceCadence: SoloHuggingFaceSaveCadence;
}

export interface SoloWorkspaceState {
  page: SoloWorkspacePage;
  focusedTaskId: string | null;
  selectedEpisodeIds: string[];
  repositorySettings: SoloWorkspaceRepositorySettings | null;
  exportSettings: SoloWorkspaceExportSettings;
  runEditorReviewed: boolean;
}

export type SoloStorageHeadroomState = "checking" | "ready" | "blocked";

export interface SoloStorageHeadroom {
  state: SoloStorageHeadroomState;
  availableBytes: number | null;
  requiredBytes: number;
  checkedAtMs: number | null;
  detail: string;
}

export interface SoloSessionState {
  preferences: SoloSessionPreferences;
  selectedStartTaskId: string | null;
  startCountdownDeadlineMs: number | null;
  storageHeadroom: SoloStorageHeadroom;
  workspace?: SoloWorkspaceState;
}

const soloWorkspaceEntityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const soloWorkspaceRepositorySegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const soloWorkspaceBranchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function isSoloWorkspaceRepositorySegment(value: unknown): value is string {
  return typeof value === "string" && soloWorkspaceRepositorySegmentPattern.test(value);
}

export function defaultSoloWorkspaceState(): SoloWorkspaceState {
  return {
    page: "run",
    focusedTaskId: null,
    selectedEpisodeIds: [],
    repositorySettings: null,
    exportSettings: {
      destination: "hugging-face",
      huggingFaceCadence: "run",
    },
    runEditorReviewed: false,
  };
}

export function normaliseSoloWorkspaceState(value: unknown): SoloWorkspaceState {
  const raw = value && typeof value === "object"
    ? value as Partial<SoloWorkspaceState>
    : {};
  const selectedEpisodeIds = Array.isArray(raw.selectedEpisodeIds)
    ? [...new Set(raw.selectedEpisodeIds.filter(
        (episodeId): episodeId is string => (
          typeof episodeId === "string" && soloWorkspaceEntityIdPattern.test(episodeId)
        ),
      ))].slice(0, 512)
    : [];
  const repository = raw.repositorySettings && typeof raw.repositorySettings === "object"
    ? raw.repositorySettings as Partial<SoloWorkspaceRepositorySettings>
    : null;
  const repositorySettings = repository
    && isSoloWorkspaceRepositorySegment(repository.organisation)
    && isSoloWorkspaceRepositorySegment(repository.repository)
    && typeof repository.branch === "string"
    && soloWorkspaceBranchPattern.test(repository.branch)
    && (repository.visibility === "private" || repository.visibility === "public")
    ? {
        organisation: repository.organisation,
        repository: repository.repository,
        branch: repository.branch,
        visibility: repository.visibility,
        missingRepositoryBehaviour: repository.missingRepositoryBehaviour === "do-not-create"
          || repository.missingRepositoryBehaviour === "private"
          || repository.missingRepositoryBehaviour === "public"
          ? repository.missingRepositoryBehaviour
          : repository.visibility,
      }
    : null;
  const exportSettingsValue = raw.exportSettings && typeof raw.exportSettings === "object"
    ? raw.exportSettings as Partial<SoloWorkspaceExportSettings>
    : {};
  const legacyHuggingFaceCadence = (exportSettingsValue as {
    huggingFaceCadence?: unknown;
  }).huggingFaceCadence;
  const exportSettings: SoloWorkspaceExportSettings = {
    destination: exportSettingsValue.destination === "local"
      ? "local"
      : "hugging-face",
    huggingFaceCadence: legacyHuggingFaceCadence === "task"
      || legacyHuggingFaceCadence === "cycle"
      ? "cycle"
      : "run",
  };
  return {
    page: isSoloWorkspacePage(raw.page) ? raw.page : "run",
    focusedTaskId: typeof raw.focusedTaskId === "string"
      && soloWorkspaceEntityIdPattern.test(raw.focusedTaskId)
      ? raw.focusedTaskId
      : null,
    selectedEpisodeIds,
    repositorySettings,
    exportSettings,
    runEditorReviewed: raw.runEditorReviewed === true,
  };
}

function isSoloWorkspacePage(value: unknown): value is SoloWorkspacePage {
  return value === "run"
    || value === "tasks"
    || value === "import"
    || value === "episodes"
    || value === "export";
}

export function normaliseSoloSessionPreferences(value: unknown): SoloSessionPreferences {
  const raw = value && typeof value === "object"
    ? value as Partial<SoloSessionPreferences>
    : {};
  const startCountdownMs = raw.startCountdownMs ?? DEFAULT_SOLO_START_COUNTDOWN_MS;
  if (!Number.isSafeInteger(startCountdownMs)
    || startCountdownMs < 0
    || startCountdownMs > MAX_SOLO_START_COUNTDOWN_MS) {
    throw new Error(`Solo start countdown must be a whole number from 0 to ${MAX_SOLO_START_COUNTDOWN_MS} milliseconds`);
  }
  return { startCountdownMs };
}

export function unverifiedSoloStorageHeadroom(): SoloStorageHeadroom {
  return {
    state: "checking",
    availableBytes: null,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs: null,
    detail: "Solo storage headroom has not been verified",
  };
}

export function normaliseSoloStorageHeadroom(value: unknown): SoloStorageHeadroom {
  const raw = value && typeof value === "object"
    ? value as Partial<SoloStorageHeadroom>
    : {};
  const availableBytes = typeof raw.availableBytes === "number"
    && Number.isFinite(raw.availableBytes)
    && raw.availableBytes >= 0
    ? Math.floor(raw.availableBytes)
    : null;
  const checkedAtMs = Number.isSafeInteger(raw.checkedAtMs)
    && (raw.checkedAtMs ?? -1) >= 0
    ? raw.checkedAtMs!
    : null;
  let state: SoloStorageHeadroomState = raw.state === "ready" || raw.state === "blocked"
    ? raw.state
    : "checking";
  if (state === "ready" && (
    availableBytes === null
    || availableBytes < SOLO_MINIMUM_STORAGE_HEADROOM_BYTES
    || checkedAtMs === null
  )) {
    state = "blocked";
  }
  const fallbackDetail = state === "ready"
    ? "Solo storage headroom is ready"
    : state === "blocked"
      ? "Solo storage headroom is not ready"
      : "Solo storage headroom has not been verified";
  return {
    state,
    availableBytes,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs,
    detail: typeof raw.detail === "string" && raw.detail.trim()
      ? raw.detail.trim()
      : fallbackDetail,
  };
}

export interface SessionSnapshot {
  sessionId: string;
  startedAt: string;
  telemetryMode: SessionTelemetryMode;
  telemetryModeAuthoritative: boolean;
  operatingMode?: SessionOperatingMode;
  solo?: SoloSessionState;
  features: RuntimeFeatures;
  handDisplay: HandDisplaySettings;
  cameraRegistration?: CameraRegistration | null;
  captureConnected: boolean;
  monitorCount: number;
  recording: boolean;
  activeTaskIndex: number;
  run: RunProgress;
  configuration: CaptureConfiguration;
  configurationStatus: ConfigurationStatus;
  sequenceReadiness: SequenceReadiness;
  recordingReadiness: RecordingReadiness;
  currentEpisode: Episode | null;
  pendingEpisode: Episode | null;
  episodes: Episode[];
  attempts: Episode[];
  jobs: CaptureJob[];
  promptAudioStatus: PromptAudioStatus;
  promptDeliveries: PromptDelivery[];
  lastFrame: SensorFrame | null;
  lastTranscript: { text: string; timestampMs: number } | null;
  commandLog: Array<{ command: string; text: string; timestampMs: number }>;
  captureStatus: CaptureStatus;
}

export interface RecordingReadiness {
  ready: boolean;
  blockers: Array<{
    code: "sequence-not-started" | "capture-disconnected" | "configuration-not-applied" | "no-task" | "task-not-recordable" | "recorder-not-armed" | "recorder-failed" | "recording-active" | "run-not-ready" | "audio-not-ready" | "camera-not-ready" | "xr-not-active" | "storage-not-ready";
    message: string;
  }>;
}

export interface SequenceReadiness {
  ready: boolean;
  blockers: Array<{
    code: "no-task" | "sequence-active" | "capture-disconnected" | "configuration-not-applied" | "recorder-not-armed" | "recorder-failed" | "audio-not-ready" | "camera-not-ready" | "xr-not-active" | "storage-not-ready";
    message: string;
  }>;
}

export type RunStatus = "stopped" | "running" | "complete" | "error";
export type RunPhase = "active-task" | "post-task-pause" | "task-pause" | "cycle-pause";
export type RecordingState = "idle" | "arming" | "recording" | "paused" | "stopping";

export interface RunProgress {
  status: RunStatus;
  phase: RunPhase | null;
  recordingState: RecordingState;
  directorReady?: boolean;
  demonstratorReady?: boolean;
  syncLockStartedAtMs?: number | null;
  recordingLatched?: boolean;
  startedAtMs: number | null;
  endedAtMs: number | null;
  cycle: number;
  activeTaskIndex: number;
  repetition: number;
  take: number;
  takeStartedAtMs: number | null;
  takeElapsedMs: number;
  recordingStartedAtMs: number | null;
  recordingElapsedMs: number;
  reviewEpisodeId: string | null;
  resetDeadlineMs: number | null;
  error: string | null;
}

export interface DirectRunState {
  operatingMode?: SessionOperatingMode;
  solo?: SoloSessionState;
  features: RuntimeFeatures;
  run: RunProgress;
  recording: boolean;
  currentEpisode: Episode | null;
  pendingEpisode: Episode | null;
}

type NextRunControlState = Pick<SessionSnapshot, "run" | "currentEpisode" | "pendingEpisode">;

export type StateBoundRunControlAction = "finish" | "success" | "fail" | "retry" | "next-task";

export function isStateBoundRunControlAction(action: unknown): action is StateBoundRunControlAction {
  return action === "finish"
    || action === "success"
    || action === "fail"
    || action === "retry"
    || action === "next-task";
}

export function nextRunControlCursor(
  state: NextRunControlState,
  action: StateBoundRunControlAction = "next-task",
) {
  const episode = state.currentEpisode ?? state.pendingEpisode;
  const segment = episode?.segments?.at(-1);
  const annotation = action === "success" || action === "fail" ? segment?.annotations.at(-1) : undefined;
  return JSON.stringify([
    state.run.startedAtMs,
    state.run.status,
    state.run.phase,
    state.run.recordingState,
    state.run.cycle,
    state.run.activeTaskIndex,
    state.run.repetition,
    state.run.take,
    state.run.reviewEpisodeId,
    state.run.resetDeadlineMs,
    episode?.id ?? null,
    segment?.id ?? null,
    segment?.outcome ?? null,
    episode?.runFinalisation ?? null,
    annotation?.id ?? null,
    annotation?.action ?? null,
  ]);
}

export interface ConfigurationStatus {
  state: "sent" | "applied" | "error";
  revision: number;
  checksum: string;
  appliedRevision: number | null;
  error: string | null;
}

export type AsrStatusState = "ready" | "unavailable" | "error";

export type ClientMessage =
  | { type: "register"; role: "capture"; sessionId: string; pairingId: string; telemetryMode: SessionTelemetryMode }
  | { type: "register"; role: "recorder"; sessionId: string; pairingId: string }
  | { type: "register"; role: "monitor" | "monitor-control"; sessionId: string }
  | { type: "capture-intent" }
  | { type: "capture-xr-active" }
  | { type: "set-telemetry-mode"; telemetryMode: SessionTelemetryMode }
  | { type: "set-configuration"; configuration: CaptureConfiguration }
  | { type: "set-hand-display"; settings: HandDisplaySettings }
  | { type: "set-camera-registration"; registration: CameraRegistration | null }
  | { type: "configuration-applied"; revision: number; checksum: string }
  | { type: "recording-accepted"; episodeId: string }
  | { type: "recording-finalised"; episodeId: string; error?: string }
  | { type: "episode-upload-commit"; requestId: string; episodeIds: string[]; receipt: string }
  | { type: "delete-episode"; episodeId: string }
  | { type: "prompt-audio-status"; status: PromptAudioStatus }
  | { type: "prompt-ack"; deliveryId: string; state: "queued" | "started" | "completed" | "failed"; error?: string }
  | { type: "capture-status"; status: CaptureStatus }
  | { type: "control"; action: "start-sequence" | "start" | "pause" | "stop" | "resume" | "show-instructions" }
  | { type: "control"; action: StateBoundRunControlAction; nextCursor: string }
  | { type: "sensor-frame"; frame: SensorFrame }
  | { type: "media-chunk"; mimeType: string; sequence: number; dataBase64: string }
  | { type: "audio-chunk"; mimeType: string; sequence: number; dataBase64: string }
  | { type: "transcript"; text: string; timestampMs: number }
  | { type: "beam"; text: string; speak: boolean; visual: boolean }
  | { type: "monitor-load"; stage: number }
  | { type: "restart-session"; resetId: string }
  | { type: "webrtc-request-offer" }
  | { type: "webrtc-signal"; peerId?: string; signal: WebRtcSignal };

export type ServerMessage =
  | { type: "session-registered"; sessionId: string; role: ClientRole; exportCapability?: string }
  | { type: "capture-intent-granted" }
  | { type: "capture-intent-suspended" }
  | { type: "capture-authority-granted" }
  | { type: "pairing-rejected"; code: CapturePairingRejectionCode; message: string }
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "configuration"; configuration: CaptureConfiguration; revision: number; checksum: string }
  | { type: "hand-display"; settings: HandDisplaySettings }
  | { type: "camera-registration"; registration: CameraRegistration | null }
  | { type: "capture-status"; status: CaptureStatus }
  | { type: "prompt"; delivery: PromptDelivery; useTextToSpeech: boolean }
  | { type: "sensor-frame"; frame: SensorFrame }
  | { type: "transcript"; text: string; timestampMs: number }
  | { type: "voice-command"; command: string; text: string; timestampMs: number }
  | { type: "beam"; text: string; speak: boolean; visual: boolean }
  | { type: "monitor-load"; stage: number }
  | { type: "session-restarted"; resetId: string }
  | { type: "control"; action: string; episode?: Episode; instructions?: string; task?: TaskDefinition }
  | { type: "webrtc-request-offer"; peerId: string }
  | { type: "webrtc-signal"; peerId: string; signal: WebRtcSignal }
  | { type: "asr-status"; state: AsrStatusState }
  | { type: "recorder-ready"; sessionId: string; nextSequence: number }
  | {
    type: "episode-upload-ack";
    requestId: string;
    episodeIds: string[];
    status: "durable" | "duplicate";
  }
  | {
    type: "episode-upload-error";
    requestId: string;
    message: string;
  }
  | {
    type: "recorder-ack";
    sessionId: string;
    episodeId: string;
    sequence: number;
    recorderFrameIndex: number;
    status: "durable" | "duplicate";
  }
  | {
    type: "recorder-error";
    fatal: true;
    code: RecorderErrorCode;
    message: string;
    sessionId?: string;
    episodeId?: string;
    sequence?: number;
    expectedSequence?: number;
  }
  | { type: "error"; message: string };

export type RecorderAck = Extract<ServerMessage, { type: "recorder-ack" }>;
export type RecorderError = Extract<ServerMessage, { type: "recorder-error" }>;

export const defaultConfiguration: CaptureConfiguration = {
  schemaVersion: CAPTURE_CONFIGURATION_SCHEMA_VERSION,
  runTitle: "Open capture",
  runDescription: "Perform the task until the capture director finishes it.",
  totalCycles: 1,
  tasks: [{
    id: "task-001",
    label: "Open task",
    instructions: "--",
    type: "open",
    repeatCount: 1,
    resetTimeS: MINIMUM_TASK_RESET_SECONDS,
  }],
  recorderRateHz: 30,
  recordAudio: false,
  studyMetadata: {
    headsetId: "",
    demonstratorId: "",
    projectId: "",
    consentDate: "",
    consentDocumentId: "",
  },
  sttProvider: "gateway",
  uploadAfterEpisode: false,
  hfRepository: "",
  hfPrivate: true,
  promptAudio: {
    enabled: false,
    required: false,
    useTextToSpeech: false,
    ttsProvider: "browser",
    taskStartAssetUrl: "",
    resetAssetUrl: "",
    completionAssetUrl: "",
  },
};

type LegacyTaskDefinition = Partial<RepetitionPlan & TaskIdentity & {
  durationS: number;
  type: TaskDefinition["type"];
}> & {
  repeatMode?: unknown;
  setCount?: unknown;
  holdAfterEach?: unknown;
};

type LegacyCaptureConfiguration = Partial<Omit<CaptureConfiguration, "tasks">> & {
  taskDescription?: unknown;
  tasks?: unknown;
};

export type TaskIdAllocator = (usedIds: ReadonlySet<string>) => string;

export function createTaskId(usedIds: ReadonlySet<string> = new Set()): string {
  let id = "";
  do id = `task-${crypto.randomUUID()}`;
  while (usedIds.has(id));
  return id;
}

export function taskDurationS(task: TaskDefinition): number | null {
  return task.type === "open" ? null : task.durationS;
}

export function isRepetitionTask(task: TaskDefinition): task is TimedTaskDefinition | OpenTaskDefinition {
  return task.type !== "pause";
}

export function normaliseTasks(value: unknown, allocateId: TaskIdAllocator = createTaskId): TaskDefinition[] {
  const source = Array.isArray(value) ? value : defaultConfiguration.tasks;
  const usedIds = new Set<string>();
  return source.map((entry, index) => {
    const raw = entry && typeof entry === "object" ? entry as LegacyTaskDefinition : {};
    let id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || usedIds.has(id)) id = allocateUniqueTaskId(usedIds, allocateId);
    usedIds.add(id);
    const identity: TaskIdentity = {
      id,
      label: normaliseText(raw.label, `Task ${String(index + 1).padStart(2, "0")}`),
      instructions: normaliseText(raw.instructions, "--"),
    };
    const type = raw.type === "open" || raw.type === "pause" ? raw.type : "timed";
    if (type === "pause") return {
      ...identity,
      type,
      durationS: normaliseNonNegative(raw.durationS, 15),
    };
    const repetition: RepetitionPlan = {
      repeatCount: normalisePositiveInteger(raw.repeatCount, 1) * normalisePositiveInteger(raw.setCount, 1),
      resetTimeS: Math.max(MINIMUM_TASK_RESET_SECONDS, normaliseNonNegative(raw.resetTimeS, MINIMUM_TASK_RESET_SECONDS)),
    };
    if (type === "open") return { ...identity, ...repetition, type };
    return {
      ...identity,
      ...repetition,
      type,
      durationS: normaliseNonNegative(raw.durationS, 60),
    };
  });
}

export function normaliseCaptureConfiguration(value: unknown, allocateId: TaskIdAllocator = createTaskId): CaptureConfiguration {
  const raw = value && typeof value === "object" ? value as LegacyCaptureConfiguration : {};
  const legacyDescription = typeof raw.taskDescription === "string" ? raw.taskDescription.trim() : "";
  const promptAudio = raw.promptAudio && typeof raw.promptAudio === "object" ? raw.promptAudio : defaultConfiguration.promptAudio;
  const studyMetadata = raw.studyMetadata && typeof raw.studyMetadata === "object"
    ? raw.studyMetadata
    : defaultConfiguration.studyMetadata;
  return {
    schemaVersion: CAPTURE_CONFIGURATION_SCHEMA_VERSION,
    runTitle: normaliseText(raw.runTitle, defaultConfiguration.runTitle),
    runDescription: typeof raw.runDescription === "string" ? raw.runDescription.trim() : legacyDescription,
    totalCycles: normalisePositiveInteger(raw.totalCycles, defaultConfiguration.totalCycles),
    tasks: normaliseTasks(raw.tasks, allocateId),
    recorderRateHz: normalisePositive(raw.recorderRateHz, defaultConfiguration.recorderRateHz),
    // Field-less persisted configurations predate the opt-in default and retain legacy audio capture.
    recordAudio: raw.recordAudio !== false,
    studyMetadata: {
      headsetId: normaliseMetadataText(studyMetadata.headsetId, 128),
      demonstratorId: normaliseMetadataText(studyMetadata.demonstratorId, 128),
      projectId: normaliseMetadataText(studyMetadata.projectId, 128),
      consentDate: normaliseConsentDate(studyMetadata.consentDate),
      consentDocumentId: normaliseMetadataText(studyMetadata.consentDocumentId, 256),
    },
    sttProvider: raw.sttProvider === "gateway" ? raw.sttProvider : defaultConfiguration.sttProvider,
    uploadAfterEpisode: raw.uploadAfterEpisode === true,
    hfRepository: typeof raw.hfRepository === "string" ? raw.hfRepository.trim() : "",
    hfPrivate: raw.hfPrivate !== false,
    promptAudio: {
      enabled: promptAudio.enabled === true,
      required: promptAudio.required === true,
      useTextToSpeech: promptAudio.useTextToSpeech === true,
      ttsProvider: promptAudio.ttsProvider === "browser" ? promptAudio.ttsProvider : defaultConfiguration.promptAudio.ttsProvider,
      taskStartAssetUrl: typeof promptAudio.taskStartAssetUrl === "string" ? promptAudio.taskStartAssetUrl.trim() : "",
      resetAssetUrl: typeof promptAudio.resetAssetUrl === "string" ? promptAudio.resetAssetUrl.trim() : "",
      completionAssetUrl: typeof promptAudio.completionAssetUrl === "string" ? promptAudio.completionAssetUrl.trim() : "",
    },
  };
}

function allocateUniqueTaskId(usedIds: ReadonlySet<string>, allocateId: TaskIdAllocator) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = allocateId(usedIds).trim();
    if (id && !usedIds.has(id)) return id;
  }
  throw new Error("Unable to allocate a unique task identifier");
}

function normaliseText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normaliseMetadataText(value: unknown, maximumLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function normaliseConsentDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? "" : value;
}

function normaliseNonNegative(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalisePositive(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normaliseNonNegativeInteger(value: unknown, fallback: number) {
  return Math.trunc(normaliseNonNegative(value, fallback));
}

function normalisePositiveInteger(value: unknown, fallback: number) {
  return Math.max(1, Math.trunc(normalisePositive(value, fallback)));
}

export const defaultCaptureStatus: CaptureStatus = {
  headsetModel: null,
  sensorSource: "none",
  questBrowser: false,
  xrFrameCount: 0,
  viewerPoseFrameCount: 0,
  leftHandJointPoseCount: 0,
  rightHandJointPoseCount: 0,
  camera: "idle",
  xr: "idle",
  transport: "idle",
  selectedCameraDeviceId: null,
  selectedCameraLabel: null,
  selectedCameraWidth: null,
  selectedCameraHeight: null,
  selectedCameraFrame: null,
  selectedCameraFrameRate: null,
  selectedCameraSide: "unknown",
  handTracking: "waiting",
  leftHandTracked: false,
  rightHandTracked: false,
  recorder: "idle",
  recorderRateHz: 30,
  recorderFrameIndex: -1,
  recorderGaps: 0,
  recorderPendingBlocks: 0,
  recorderQueuedBlocks: 0,
  recorderDurableAckSequence: -1,
  recorderFinaliseStartAckSequence: null,
  recorderFinaliseTargetSequence: null,
  sensorRateHz: 0,
  lastFrameAt: null,
  lastError: null,
};
