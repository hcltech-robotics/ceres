import { episodeShardPath, type CeresEpisodeExportMetadataV3 } from "../shared/lerobot-export.js";
import type { StoredExportArtifact } from "./lerobot-export/types.js";
import {
  exportDirectory, exportFile, isMissingExport, readExportReceipt,
  storedExportReceiptName, storedExportRoot, validStorageIdentifier,
  validateStoredExportReference, verifiedExportArtifacts, withStoredExportLock, writeExportFile,
  type StoredExportReference,
} from "./lerobot-export/stored-export-files.js";

export type { StoredExportReference } from "./lerobot-export/stored-export-files.js";

export interface StoredExportCapture extends StoredExportReference {
  key: string;
  title: string;
  taskLabel: string;
  cycle: number | null;
  savedAt: string;
  byteLength: number;
  artifactCount: number;
  frameCount: number | null;
  fps: number | null;
}

export interface StoredExportOptions {
  root?: FileSystemDirectoryHandle;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, detail: string) => void;
}

async function storageRoot(options: StoredExportOptions): Promise<FileSystemDirectoryHandle> {
  options.signal?.throwIfAborted();
  if (options.root) return options.root;
  if (!navigator.storage?.getDirectory) throw new Error("Browser storage is unavailable");
  return navigator.storage.getDirectory();
}

function referenceRoot(reference: StoredExportReference): string {
  return reference.archiveId
    ? `${storedExportRoot}/archive/${reference.sessionId}/${reference.archiveId}`
    : `${storedExportRoot}/sessions/${reference.sessionId}`;
}

async function directories(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle[]> {
  let directory;
  try { directory = await exportDirectory(root, path); }
  catch (error) { if (isMissingExport(error)) return []; throw error; }
  const result: FileSystemDirectoryHandle[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "directory") result.push(entry as FileSystemDirectoryHandle);
  }
  return result;
}

async function captureAt(root: FileSystemDirectoryHandle, sessionId: string, episodeIndex: number, archiveId?: string) {
  const location = referenceRoot({ sessionId, episodeIndex, episodeId: "pending", receiptSha256: archiveId ?? "", archiveId });
  const directory = await exportDirectory(root, location);
  const { receipt, file, sha256 } = await readExportReceipt(directory, episodeIndex);
  if (archiveId !== undefined && archiveId !== sha256) throw new Error("The saved capture archive is invalid");
  const prefix = `${episodeShardPath(episodeIndex)}/`;
  const metadataFile = await exportFile(directory, `${prefix}ceres/episode-metadata.json`);
  if (metadataFile.size > 8 * 1024 * 1024) throw new Error("The saved capture metadata is too large");
  const metadata = JSON.parse(await metadataFile.text()) as CeresEpisodeExportMetadataV3;
  if (metadata.schema !== "ceres-episode-export-metadata" || metadata.version !== 3
    || metadata.episodeId !== receipt.episodeId || metadata.episodeIndex !== episodeIndex
    || (metadata.segments !== null && !Array.isArray(metadata.segments))) throw new Error("The saved capture metadata is invalid");
  for (const artifact of receipt.artifacts) {
    if ((await exportFile(directory, artifact.path)).size !== artifact.byteLength) throw new Error("The saved capture is incomplete");
  }
  const infoArtifact = receipt.artifacts.find(({ path }) => path === `${prefix}meta/info.json`);
  const metricsArtifact = receipt.artifacts.find(({ path }) => path === `${prefix}ceres/metrics.json`);
  const info = infoArtifact ? await smallJson(await exportFile(directory, infoArtifact.path)) : {};
  const metrics = metricsArtifact ? await smallJson(await exportFile(directory, metricsArtifact.path)) : {};
  const taskLabels = [...new Set((metadata.segments ?? []).flatMap((segment) => (
    typeof segment.taskLabel === "string" ? [segment.taskLabel] : []
  )))];
  const capture = receipt.capture;
  const title = typeof capture?.runTitle === "string" && capture.runTitle.trim() ? capture.runTitle : `Capture ${episodeIndex + 1}`;
  const taskLabel = typeof capture?.taskLabel === "string" && capture.taskLabel.trim() ? capture.taskLabel : taskLabels.join(", ");
  const savedAt = typeof receipt.savedAt === "string" && Number.isFinite(Date.parse(receipt.savedAt))
    ? receipt.savedAt : new Date(file.lastModified).toISOString();
  const result: StoredExportCapture = {
    sessionId, episodeIndex, episodeId: receipt.episodeId, receiptSha256: sha256,
    ...(archiveId ? { archiveId } : {}),
    key: `${sessionId}:${episodeIndex}:${sha256}`,
    title, taskLabel,
    cycle: Number.isSafeInteger(capture?.cycle) && capture!.cycle > 0 ? capture!.cycle : null,
    savedAt,
    byteLength: receipt.artifacts.reduce((total, artifact) => total + artifact.byteLength, file.size),
    artifactCount: receipt.artifactCount,
    frameCount: Number.isSafeInteger(metrics.frames) && Number(metrics.frames) >= 0 ? Number(metrics.frames) : null,
    fps: typeof info.fps === "number" && Number.isFinite(info.fps) && info.fps > 0 ? info.fps : null,
  };
  return { capture: result, receipt, receiptFile: file, metadata, directory };
}

async function smallJson(file: File): Promise<Record<string, unknown>> {
  if (file.size > 8 * 1024 * 1024) throw new Error("The saved capture metadata is too large");
  const value: unknown = JSON.parse(await file.text());
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The saved capture metadata is invalid");
  return value as Record<string, unknown>;
}

export async function listStoredExports(options: StoredExportOptions = {}): Promise<StoredExportCapture[]> {
  const root = await storageRoot(options);
  const captures = new Map<string, StoredExportCapture>();
  async function collect(sessionId: string, path: string, archiveId?: string) {
    for (const shard of await directories(root, `${path}/shards`)) {
      options.signal?.throwIfAborted();
      const match = /^episode-(\d{6,})$/.exec(shard.name);
      if (!match) continue;
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || episodeShardPath(index) !== `shards/${shard.name}`) continue;
      try {
        const { capture } = await withStoredExportLock(sessionId, index, () => captureAt(root, sessionId, index, archiveId));
        if (!captures.has(capture.key)) captures.set(capture.key, capture);
      } catch (error) { options.signal?.throwIfAborted(); }
    }
  }
  for (const session of await directories(root, `${storedExportRoot}/sessions`)) {
    if (validStorageIdentifier(session.name)) await collect(session.name, `${storedExportRoot}/sessions/${session.name}`);
  }
  for (const session of await directories(root, `${storedExportRoot}/archive`)) {
    if (!validStorageIdentifier(session.name)) continue;
    for (const archive of await directories(root, `${storedExportRoot}/archive/${session.name}`)) {
      if (/^[a-f0-9]{64}$/.test(archive.name)) await collect(session.name, `${storedExportRoot}/archive/${session.name}/${archive.name}`, archive.name);
    }
  }
  return [...captures.values()].sort((left, right) => right.savedAt.localeCompare(left.savedAt) || left.key.localeCompare(right.key));
}

async function currentCapture(root: FileSystemDirectoryHandle, reference: StoredExportReference) {
  validateStoredExportReference(reference);
  const found = await captureAt(root, reference.sessionId, reference.episodeIndex, reference.archiveId);
  if (found.capture.episodeId !== reference.episodeId || found.capture.receiptSha256 !== reference.receiptSha256) {
    throw new Error("The saved capture changed. Refresh the capture list and select it again.");
  }
  return found;
}

export interface ReadStoredExport {
  capture: StoredExportCapture;
  artefacts: StoredExportArtifact[];
  metadata: CeresEpisodeExportMetadataV3;
  receipt: File;
}

/** Keeps source files stable until the consumer has finished reading them. */
export async function withStoredExport<T>(
  reference: StoredExportReference,
  consume: (saved: ReadStoredExport) => Promise<T>,
  options: StoredExportOptions & { allowArchivedFallback?: boolean } = {},
): Promise<T> {
  const root = await storageRoot(options);
  validateStoredExportReference(reference);
  return withStoredExportLock(reference.sessionId, reference.episodeIndex, async () => {
    let found;
    try { found = await currentCapture(root, reference); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!options.allowArchivedFallback || reference.archiveId) throw error;
      found = await currentCapture(root, { ...reference, archiveId: reference.receiptSha256 });
    }
    const artefacts = await verifiedExportArtifacts(found.directory, found.receipt, options.signal);
    return consume({ capture: found.capture, artefacts, metadata: found.metadata, receipt: found.receiptFile });
  });
}

export async function readStoredExport(reference: StoredExportReference, options: StoredExportOptions = {}): Promise<ReadStoredExport> {
  return withStoredExport(reference, async (saved) => saved, options);
}

function validateSelection(references: readonly StoredExportReference[]) {
  if (references.length === 0 || references.length > 1000) throw new Error("Select at least one saved capture");
  const seen = new Set<string>();
  for (const reference of references) {
    validateStoredExportReference(reference);
    const key = `${reference.sessionId}:${reference.episodeIndex}:${reference.receiptSha256}`;
    if (seen.has(key)) throw new Error("The saved capture selection contains duplicates");
    seen.add(key);
  }
}

export async function copyStoredExportsToFolder(references: readonly StoredExportReference[], destination: FileSystemDirectoryHandle, options: StoredExportOptions = {}): Promise<void> {
  validateSelection(references);
  const root = await storageRoot(options);
  for (const [index, reference] of references.entries()) {
    options.signal?.throwIfAborted();
    await withStoredExport(reference, async (saved) => {
      const target = await exportDirectory(destination, `${storedExportRoot}/archive/${reference.sessionId}/${reference.receiptSha256}`, true);
      try {
        const existing = await readExportReceipt(target, reference.episodeIndex);
        if (existing.sha256 !== reference.receiptSha256) throw new Error("The destination already contains a different capture");
        await verifiedExportArtifacts(target, existing.receipt, options.signal);
        options.onProgress?.(index + 1, references.length, `Copied ${saved.capture.title}`);
        return;
      } catch (error) { if (!isMissingExport(error)) throw error; }
      for (const artifact of saved.artefacts) {
        options.signal?.throwIfAborted();
        await writeExportFile(target, artifact.path, artifact.file);
      }
      await writeExportFile(target, `${episodeShardPath(reference.episodeIndex)}/${storedExportReceiptName}`, saved.receipt);
      options.onProgress?.(index + 1, references.length, `Copied ${saved.capture.title}`);
    }, { ...options, root });
  }
}

export async function deleteStoredExports(references: readonly StoredExportReference[], options: StoredExportOptions = {}): Promise<void> {
  validateSelection(references);
  const root = await storageRoot(options);
  for (const reference of references) await currentCapture(root, reference);
  for (const [index, reference] of references.entries()) {
    options.signal?.throwIfAborted();
    await withStoredExportLock(reference.sessionId, reference.episodeIndex, async () => {
      const found = await currentCapture(root, reference);
      const shards = await exportDirectory(found.directory, "shards");
      await shards.removeEntry(episodeShardPath(reference.episodeIndex).slice("shards/".length), { recursive: true });
      options.onProgress?.(index + 1, references.length, `Deleted ${found.capture.title}`);
    });
  }
}
