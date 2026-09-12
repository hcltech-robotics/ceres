import {
  CERES_EXPORT_CAPABILITY_HEADER,
  LEROBOT_EXPORT_MANIFEST_VERSION,
  episodeExportFrameContribution,
  episodeExportTimeline,
  episodeTaskTexts,
  isExportableEpisode,
  type EpisodeExportManifest,
} from "../../shared/lerobot-export.js";
import {
  RecorderBlockFlags,
  decodeRecorderBlock,
  decodeRecorderMediaPayload,
  type Episode,
  type RecorderBlock,
  type SensorFrame,
} from "../../shared/protocol.js";
import { RECORDER_JOURNAL_FILE_PATTERN } from "../recorder/recorder-journal.js";

const maximumSensorLineBytes = 2 * 1024 * 1024;
const maximumConcurrentRecorderReads = 4;
const monitorOpfsScheme = "monitor-opfs:";
const browserOpfsScheme = "browser-opfs:";
export const MONITOR_RECORDING_STORAGE_ROOT = "ceres-monitor-recordings";
export const SOLO_RECORDING_STORAGE_ROOT = "ceres-solo-recordings";
export type BrowserRecordingStorageRoot =
  | typeof MONITOR_RECORDING_STORAGE_ROOT
  | typeof SOLO_RECORDING_STORAGE_ROOT;

export interface MonitorOpfsEpisodeSourceOptions {
  sessionId: string;
  episodes: Episode[];
  recorderRateHz: number;
  storageRoot?: BrowserRecordingStorageRoot;
}

export interface BrowserEpisodeSensorSample {
  timestampMs: number;
  frame: SensorFrame | null;
}

/** Reads durable sensor rows for post-acquisition analysis without touching the recorder path. */
export async function loadMonitorOpfsEpisodeSensorSamples(
  options: MonitorOpfsEpisodeSourceOptions,
  episodeId: string,
  signal: AbortSignal,
): Promise<readonly BrowserEpisodeSensorSample[]> {
  const { blocks } = await loadMonitorOpfsEpisodeBlocks(options, episodeId, signal);
  const samples: BrowserEpisodeSensorSample[] = [];
  for (const block of blocks) {
    signal.throwIfAborted();
    const line = monitorSensorLine(block);
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as { timestampMs?: unknown; gap?: unknown };
    if (typeof record.timestampMs !== "number" || !Number.isFinite(record.timestampMs)) continue;
    samples.push({
      timestampMs: record.timestampMs,
      frame: record.gap === true || !isSensorFrameRow(line) ? null : row as SensorFrame,
    });
  }
  return samples;
}

export async function fetchEpisodeExportManifest(
  sessionId: string,
  episodeId: string,
  signal: AbortSignal,
  exportCapability?: string,
): Promise<EpisodeExportManifest> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/episodes/${encodeURIComponent(episodeId)}/export-manifest`;
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: exportHeaders(exportCapability),
  });
  if (!response.ok) throw new Error(await responseError(response, "Episode export manifest could not be read"));
  const manifest = await response.json() as EpisodeExportManifest;
  if (manifest.schemaVersion !== LEROBOT_EXPORT_MANIFEST_VERSION || manifest.sessionId !== sessionId || manifest.episode.id !== episodeId) {
    throw new Error("Episode export manifest is incompatible");
  }
  if (manifest.taskSpecVersion !== manifest.episode.taskSpecVersion
    || manifest.taskSpecHash !== manifest.episode.taskSpecHash
    || (manifest.taskSpecification === undefined) !== (manifest.episode.taskSpecification === undefined)) {
    throw new Error("Episode export manifest task provenance is inconsistent");
  }
  if (!isExportableEpisode(manifest.episode)) throw new Error("Only episodes with at least one durable sensor frame may be exported");
  if (!manifest.blobs.some((blob) => blob.id === "sensors")) throw new Error("Episode export manifest has no sensor rows");
  return manifest;
}

export async function* streamSensorRows(
  manifest: EpisodeExportManifest,
  signal: AbortSignal,
  onProgress: (bytesRead: number, totalBytes: number) => void,
  exportCapability?: string,
): AsyncGenerator<string> {
  const descriptor = manifest.blobs.find((blob) => blob.id === "sensors");
  if (!descriptor) throw new Error("Episode export manifest has no sensor rows");
  if (isBrowserOpfsUrl(descriptor.url)) {
    yield* streamBrowserSensorRows(manifest, signal, onProgress);
    return;
  }
  const response = await fetch(new URL(descriptor.url, location.origin), {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: exportHeaders(exportCapability),
  });
  if (!response.ok || !response.body) throw new Error(await responseError(response, "Episode sensor rows could not be read"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let bytesRead = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      buffered += decoder.decode(result.value, { stream: true });
      if (buffered.length > maximumSensorLineBytes && !buffered.includes("\n")) throw new Error("Episode sensor row exceeds the bounded line buffer");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
        newline = buffered.indexOf("\n");
      }
      onProgress(bytesRead, descriptor.byteLength);
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield buffered.trim();
    onProgress(bytesRead, descriptor.byteLength);
  } finally {
    reader.releaseLock();
  }
}

export function exportHeaders(exportCapability?: string): HeadersInit {
  return exportCapability ? { [CERES_EXPORT_CAPABILITY_HEADER]: exportCapability } : {};
}

export async function loadMonitorOpfsEpisodeExportManifest(
  options: MonitorOpfsEpisodeSourceOptions,
  episodeId: string,
  signal: AbortSignal,
): Promise<EpisodeExportManifest> {
  const {
    episode,
    episodeIndex,
    exportable,
    storageRoot,
    summary,
    task,
    tasks,
  } = await loadMonitorOpfsEpisodeBlocks(options, episodeId, signal);
  const baseUrl = browserOpfsUrl(storageRoot, options.sessionId, episodeId);
  const blobs: EpisodeExportManifest["blobs"] = [{
    id: "sensors",
    path: "recorder/*.crb",
    url: `${baseUrl}/sensors`,
    mediaType: "application/x-ndjson",
    byteLength: summary.sensorByteLength,
  }];
  if (summary.mediaByteLength > 0 && summary.mediaType) {
    blobs.push({
      id: "video",
      path: "recorder/*.crb",
      url: `${baseUrl}/video`,
      mediaType: summary.mediaType,
      byteLength: summary.mediaByteLength,
    });
  }
  return {
    schemaVersion: LEROBOT_EXPORT_MANIFEST_VERSION,
    sessionId: options.sessionId,
    episode,
    episodeIndex,
    globalFrameIndex: exportable.slice(0, episodeIndex).reduce(
      (total, entry) => total + episodeExportFrameContribution(entry),
      0,
    ),
    fps: options.recorderRateHz,
    task,
    tasks,
    ...(episode.taskSpecification
      ? {
          taskSpecVersion: episode.taskSpecVersion,
          taskSpecHash: episode.taskSpecHash,
          taskSpecification: episode.taskSpecification,
        }
      : {}),
    blobs,
  };
}

async function loadMonitorOpfsEpisodeBlocks(
  options: MonitorOpfsEpisodeSourceOptions,
  episodeId: string,
  signal: AbortSignal,
) {
  assertMonitorSourceOptions(options);
  const exportable = options.episodes.filter(isExportableEpisode).sort(compareEpisodes);
  const episodeIndex = exportable.findIndex((episode) => episode.id === episodeId);
  if (episodeIndex < 0) throw new Error("Only episodes with at least one durable sensor frame may be exported");
  signal.throwIfAborted();
  const episode = exportable[episodeIndex];
  const storageRoot = options.storageRoot ?? MONITOR_RECORDING_STORAGE_ROOT;
  const blocks = await readBrowserEpisodeBlocks(
    storageRoot,
    options.sessionId,
    episodeId,
    signal,
    episodeRecorderSequenceBounds(episode),
  );
  const summary = monitorBlockSummary(blocks);
  if (summary.frameCount !== episode.frameCount) {
    throw new Error(`Monitor recorder cache has ${summary.frameCount} sensor frames for episode ${episodeId}, expected ${episode.frameCount}`);
  }
  episodeExportTimeline(episode);
  const tasks = taskCatalogue(exportable.slice(0, episodeIndex + 1));
  const task = tasks.find((entry) => entry.text === episodeTaskTexts(episode)[0]);
  if (!task) throw new Error("Episode task metadata is incomplete");
  return {
    blocks,
    episode,
    episodeIndex,
    exportable,
    storageRoot,
    summary,
    task,
    tasks,
  };
}

export async function readMonitorOpfsEpisodeVideo(manifest: EpisodeExportManifest, signal: AbortSignal): Promise<Blob | null> {
  const descriptor = manifest.blobs.find((blob) => blob.id === "video");
  if (!descriptor || !isBrowserOpfsUrl(descriptor.url)) return null;
  const blocks = await readBrowserEpisodeBlocks(
    browserOpfsStorageRoot(descriptor.url),
    manifest.sessionId,
    manifest.episode.id,
    signal,
    episodeRecorderSequenceBounds(manifest.episode),
  );
  const media = blocks.filter((block) => (block.flags & RecorderBlockFlags.MediaChunk) !== 0).map((block) => decodeRecorderMediaPayload(block.payload));
  if (media.length === 0) return null;
  const mimeType = media[0].mimeType;
  if (media.some((chunk) => chunk.mimeType !== mimeType)) throw new Error("Monitor recorder media MIME type changed within an episode");
  return new Blob(media.map((chunk) => Uint8Array.from(chunk.data)), { type: mimeType });
}

export async function readEpisodeVideo(
  manifest: EpisodeExportManifest,
  signal: AbortSignal,
  exportCapability?: string,
): Promise<Blob | null> {
  const descriptor = manifest.blobs.find((blob) => blob.id === "video");
  if (!descriptor) return null;
  if (isBrowserOpfsUrl(descriptor.url)) return readMonitorOpfsEpisodeVideo(manifest, signal);
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const response = await fetch(new URL(descriptor.url, origin), {
    signal,
    cache: "no-store",
    credentials: "same-origin",
    headers: exportHeaders(exportCapability),
  });
  if (!response.ok) throw new Error(await responseError(response, "Episode video could not be read"));
  const video = await response.blob();
  if (video.size === 0) throw new Error("Episode video is empty");
  return video.type === descriptor.mediaType
    ? video
    : new Blob([video], { type: descriptor.mediaType });
}

export function isSensorFrameRow(line: string): boolean {
  const record = JSON.parse(line) as { gap?: unknown; frameIndex?: unknown; leftHand?: unknown; rightHand?: unknown };
  return record.gap !== true
    && Number.isSafeInteger(record.frameIndex)
    && typeof record.leftHand === "object"
    && typeof record.rightHand === "object";
}

async function* streamBrowserSensorRows(
  manifest: EpisodeExportManifest,
  signal: AbortSignal,
  onProgress: (bytesRead: number, totalBytes: number) => void,
): AsyncGenerator<string> {
  const descriptor = manifest.blobs.find((blob) => blob.id === "sensors");
  if (!descriptor || !isBrowserOpfsUrl(descriptor.url)) throw new Error("Browser recorder sensor source is invalid");
  const blocks = await readBrowserEpisodeBlocks(
    browserOpfsStorageRoot(descriptor.url),
    manifest.sessionId,
    manifest.episode.id,
    signal,
    episodeRecorderSequenceBounds(manifest.episode),
  );
  let bytesRead = 0;
  for (const block of blocks) {
    signal.throwIfAborted();
    const line = monitorSensorLine(block);
    if (!line) continue;
    bytesRead += textByteLength(line) + 1;
    onProgress(bytesRead, descriptor.byteLength);
    yield line;
  }
  onProgress(bytesRead, descriptor.byteLength);
}

interface EpisodeRecorderSequenceBounds {
  firstSequence: number;
  lastSequence: number;
}

async function readBrowserEpisodeBlocks(
  storageRoot: BrowserRecordingStorageRoot,
  sessionId: string,
  episodeId: string,
  signal: AbortSignal,
  bounds?: EpisodeRecorderSequenceBounds,
): Promise<RecorderBlock[]> {
  const storage = navigator.storage as StorageManager & { getDirectory(): Promise<FileSystemDirectoryHandle> };
  const root = await storage.getDirectory();
  const ceres = await root.getDirectoryHandle(storageRoot);
  const session = await ceres.getDirectoryHandle(sessionId);
  const directory = await session.getDirectoryHandle("recorder");
  const entries: Array<{ sequence: number; handle: FileSystemFileHandle }> = [];
  for await (const [name, handle] of directory.entries()) {
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(name);
    if (!match || handle.kind !== "file") continue;
    const sequence = Number(match[1]);
    if (bounds && Number.isSafeInteger(sequence)
      && (sequence < bounds.firstSequence || sequence > bounds.lastSequence)) continue;
    entries.push({ sequence, handle: handle as FileSystemFileHandle });
  }
  entries.sort((left, right) => left.sequence - right.sequence);
  const blocks: RecorderBlock[] = [];
  for (let start = 0; start < entries.length; start += maximumConcurrentRecorderReads) {
    signal.throwIfAborted();
    const batch = await Promise.all(entries
      .slice(start, start + maximumConcurrentRecorderReads)
      .map(async (entry) => {
        signal.throwIfAborted();
        const file = await entry.handle.getFile();
        signal.throwIfAborted();
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        const block = decodeRecorderBlock(new Uint8Array(bytes));
        if (block.sessionId !== sessionId || block.sequence !== entry.sequence) {
          throw new Error(`Monitor recorder journal block ${entry.sequence} is invalid`);
        }
        return block;
      }));
    for (const block of batch) {
      if (block.episodeId === episodeId) blocks.push(block);
    }
  }
  return blocks;
}

function episodeRecorderSequenceBounds(episode: Episode): EpisodeRecorderSequenceBounds | undefined {
  const firstSequence = episode.firstRecorderSequence;
  const lastSequence = episode.lastRecorderSequence;
  return typeof firstSequence === "number"
    && typeof lastSequence === "number"
    && Number.isSafeInteger(firstSequence)
    && Number.isSafeInteger(lastSequence)
    && firstSequence <= lastSequence
    ? { firstSequence, lastSequence }
    : undefined;
}

function monitorBlockSummary(blocks: RecorderBlock[]) {
  let frameCount = 0;
  let sensorByteLength = 0;
  let mediaByteLength = 0;
  let mediaType: string | null = null;
  for (const block of blocks) {
    if ((block.flags & RecorderBlockFlags.SensorFrameJson) !== 0) {
      frameCount += 1;
      sensorByteLength += textByteLength(canonicalMonitorSensorRecord(block)) + 1;
      continue;
    }
    if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
      sensorByteLength += textByteLength(monitorGapRecord(block)) + 1;
      continue;
    }
    if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
      const chunk = decodeRecorderMediaPayload(block.payload);
      mediaType ??= chunk.mimeType;
      if (chunk.mimeType !== mediaType) throw new Error("Monitor recorder media MIME type changed within an episode");
      mediaByteLength += chunk.data.byteLength;
    }
  }
  return {
    frameCount,
    sensorByteLength,
    mediaByteLength,
    mediaType,
  };
}

function monitorSensorLine(block: RecorderBlock): string | null {
  if ((block.flags & RecorderBlockFlags.SensorFrameJson) !== 0) return canonicalMonitorSensorRecord(block);
  if ((block.flags & RecorderBlockFlags.Gap) !== 0) return monitorGapRecord(block);
  return null;
}

function canonicalMonitorSensorRecord(block: RecorderBlock): string {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(block.payload)) as Record<string, unknown>;
  } catch {
    throw new Error("Monitor recorder sensor payload is not valid UTF-8 JSON");
  }
  if (!frame || typeof frame !== "object" || !frame.leftHand || !frame.rightHand || !frame.sceneStatus) {
    throw new Error("Monitor recorder sensor payload is missing required telemetry fields");
  }
  return JSON.stringify({
    ...frame,
    timestampMs: block.sourceTimestampUs / 1_000,
    frameIndex: block.recorderFrameIndex,
    recorder: recorderMetadata(block),
  });
}

function monitorGapRecord(block: RecorderBlock): string {
  let reason = "missing-source-sample";
  if (block.payload.byteLength > 0) {
    try {
      reason = new TextDecoder("utf-8", { fatal: true }).decode(block.payload);
    } catch {
      throw new Error("Monitor recorder gap payload is not valid UTF-8");
    }
  }
  return JSON.stringify({
    timestampMs: block.sourceTimestampUs / 1_000,
    frameIndex: block.recorderFrameIndex,
    gap: true,
    reason,
    recorder: recorderMetadata(block),
  });
}

function recorderMetadata(block: RecorderBlock) {
  return {
    sessionId: block.sessionId,
    episodeId: block.episodeId,
    sequence: block.sequence,
    recorderFrameIndex: block.recorderFrameIndex,
    sourceTimestampUs: block.sourceTimestampUs,
    flags: block.flags,
    checksum: block.checksum,
  };
}

function browserOpfsUrl(storageRoot: BrowserRecordingStorageRoot, sessionId: string, episodeId: string) {
  return `${browserOpfsScheme}//${storageRoot}/${encodeURIComponent(sessionId)}/${encodeURIComponent(episodeId)}`;
}

export function isMonitorOpfsUrl(url: string) {
  return isBrowserOpfsUrl(url);
}

export function isBrowserOpfsUrl(url: string) {
  return url.startsWith(monitorOpfsScheme) || url.startsWith(browserOpfsScheme);
}

function browserOpfsStorageRoot(url: string): BrowserRecordingStorageRoot {
  if (url.startsWith(monitorOpfsScheme)) return MONITOR_RECORDING_STORAGE_ROOT;
  const root = new URL(url).hostname;
  if (root === MONITOR_RECORDING_STORAGE_ROOT || root === SOLO_RECORDING_STORAGE_ROOT) return root;
  throw new Error("Browser recorder storage root is invalid");
}

function assertMonitorSourceOptions(options: MonitorOpfsEpisodeSourceOptions) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.sessionId)) throw new Error("Monitor recorder session identifier is invalid");
  if (!Number.isSafeInteger(options.recorderRateHz) || options.recorderRateHz <= 0 || options.recorderRateHz > 1_000) throw new Error("Monitor recorder rate is invalid");
}

function compareEpisodes(left: Episode, right: Episode) {
  const byStart = left.startedAt.localeCompare(right.startedAt);
  return byStart !== 0 ? byStart : left.id.localeCompare(right.id);
}

function taskCatalogue(episodes: Episode[]) {
  const tasks: Array<{ index: number; text: string }> = [];
  for (const episode of episodes) {
    for (const label of episodeTaskTexts(episode)) {
      if (tasks.some((task) => task.text === label)) continue;
      tasks.push({ index: tasks.length, text: label });
    }
  }
  return tasks;
}

function textByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const value = await response.json() as { error?: unknown };
    return typeof value.error === "string" ? value.error : `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
