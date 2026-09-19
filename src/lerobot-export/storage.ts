import {
  CERES_EPISODE_EXPORT_METADATA_SCHEMA,
  CERES_EPISODE_EXPORT_METADATA_VERSION,
  episodeShardPath,
  type CeresEpisodeExportMetadataV3,
} from "../../shared/lerobot-export.js";
import type { CaptureMetadata } from "../../shared/capture-metadata.js";
import type { EpisodeSegment } from "../../shared/protocol.js";
import type { CeresTaskSpecification } from "../../shared/task-specification.js";
import type { LeRobotExportBundle } from "../../wasm/lerobot-exporter/ts/loader.js";
import type { StoredExportArtifact } from "./types.js";
import {
  archivePreviousExport, exportDirectory, exportFile, fileSha256, isMissingExport,
  readExportReceipt, safeRelativePath, storedExportRoot, validStorageIdentifier, withStoredExportLock,
} from "./stored-export-files.js";

export interface BrowserExportStorage {
  opfsRoot: FileSystemDirectoryHandle;
  writeBundle(
    episodeIndex: number,
    episodeId: string,
    bundle: LeRobotExportBundle,
    provenance: {
      capture?: { runTitle: string; cycle: number; taskLabel: string };
      captureMetadata?: CaptureMetadata;
      segments: EpisodeSegment[] | null;
      task?: {
        version: number;
        hash: string;
        specification: CeresTaskSpecification;
      };
    },
    directoryHandle: FileSystemDirectoryHandle | undefined,
    signal: AbortSignal,
    onProgress: (completed: number, total: number, path: string) => void,
  ): Promise<StoredExportArtifact[]>;
}

export async function openBrowserExportStorage(sessionId: string): Promise<BrowserExportStorage> {
  if (!navigator.storage?.getDirectory) throw new Error("Origin private file system storage is unavailable");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error("Session identifier is invalid");
  const storagePrefix = `ceres-lerobot-v3/sessions/${sessionId}`;
  const storageRoot = await navigator.storage.getDirectory();
  const opfsRoot = await getDirectoryAt(storageRoot, storagePrefix, true);
  return {
    opfsRoot,
    async writeBundle(episodeIndex, episodeId, bundle, provenance, directoryHandle, signal, onProgress) {
      return withStoredExportLock(sessionId, episodeIndex, async () => {
        await archivePreviousExport(storageRoot, opfsRoot, sessionId, episodeIndex, signal);
        const prefix = episodeShardPath(episodeIndex);
        const artifacts: StoredExportArtifact[] = [];
        const bundleArtifactCount = bundle.artifactCount();
        const total = bundleArtifactCount + (provenance.task ? 2 : 1);
        for (let index = 0; index < bundleArtifactCount; index += 1) {
          signal.throwIfAborted();
          const artifactPath = normaliseRelativePath(bundle.artifactPath(index));
          await writeArtifact(artifactPath, bundle.artifactBytes(index), index + 1);
        }
        if (provenance.task) {
          const specificationPath = `ceres/task-specifications/${provenance.task.hash}.json`;
          const specificationBytes = new TextEncoder().encode(JSON.stringify(provenance.task.specification));
          if (await fileSha256(specificationBytes) !== provenance.task.hash) {
            throw new Error("Episode task specification hash does not match its canonical specification");
          }
          await writeArtifact(specificationPath, specificationBytes, bundleArtifactCount + 1);
        }
        const metadataPath = "ceres/episode-metadata.json";
        const metadata: CeresEpisodeExportMetadataV3 = {
          schema: CERES_EPISODE_EXPORT_METADATA_SCHEMA,
          version: CERES_EPISODE_EXPORT_METADATA_VERSION,
          episodeId,
          episodeIndex,
          captureMetadata: provenance.captureMetadata ?? null,
          segments: provenance.segments,
          ...(provenance.task
            ? {
                taskSpecVersion: provenance.task.version,
                taskSpecHash: provenance.task.hash,
                taskSpecificationPath: `ceres/task-specifications/${provenance.task.hash}.json`,
              }
            : {}),
        };
        const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
        await writeArtifact(metadataPath, metadataBytes, total);

        async function writeArtifact(artifactPath: string, bytes: Uint8Array, completed: number) {
          const path = `${prefix}/${artifactPath}`;
          const opfsHandle = await writeFileAt(opfsRoot, path, bytes);
          const file = await opfsHandle.getFile();
          artifacts.push({
            path,
            sha256: await fileSha256(bytes),
            byteLength: file.size,
            mediaType: exportMediaType(path),
            file,
          });
          onProgress(completed, total, path);
        }
        const receipt = new TextEncoder().encode(JSON.stringify({
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          ...(provenance.capture ? { capture: provenance.capture } : {}),
          episodeId,
          episodeIndex,
          artifactCount: artifacts.length,
          artifacts: artifacts.map(({ path, sha256, byteLength, mediaType }) => ({
            path,
            sha256,
            byteLength,
            mediaType,
          })),
        }, null, 2));
        const receiptPath = `${prefix}/ceres/browser-export-receipt.json`;
        const receiptHandle = await writeFileAt(opfsRoot, receiptPath, receipt);
        if (directoryHandle) {
          try {
            const selectedRoot = await getDirectoryAt(directoryHandle, storagePrefix, true);
            await archivePreviousExport(directoryHandle, selectedRoot, sessionId, episodeIndex, signal);
            for (const artifact of artifacts) {
              signal.throwIfAborted();
              await writeFileAt(selectedRoot, artifact.path, artifact.file);
            }
            await writeFileAt(selectedRoot, receiptPath, await receiptHandle.getFile());
          } catch (error) {
            if (isInvalidStateError(error)) {
              throw new Error(
                "The selected folder changed while exporting. The complete export remains safe in browser storage. Select the folder again and retry.",
              );
            }
            throw error;
          }
        }
        return artifacts;
      });
    },
  };
}

async function getDirectoryAt(root: FileSystemDirectoryHandle, relativePath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const segment of normaliseRelativePath(relativePath).split("/")) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

export async function readJsonFile<T>(root: FileSystemDirectoryHandle, path: string): Promise<T | null> {
  try {
    const handle = await getFileHandleAt(root, path, false);
    return JSON.parse(await (await handle.getFile()).text()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

export async function writeJsonFile(root: FileSystemDirectoryHandle, path: string, value: unknown): Promise<void> {
  await writeFileAt(root, path, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

async function writeFileAt(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  contents: Uint8Array | Blob,
): Promise<FileSystemFileHandle> {
  const handle = await getFileHandleAt(root, relativePath, true);
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(contents instanceof Blob ? contents : Uint8Array.from(contents));
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  return handle;
}

function isInvalidStateError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError";
}

async function getFileHandleAt(root: FileSystemDirectoryHandle, relativePath: string, create: boolean): Promise<FileSystemFileHandle> {
  const segments = normaliseRelativePath(relativePath).split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error("Export file path is empty");
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create });
  return directory.getFileHandle(fileName, { create });
}

export function normaliseRelativePath(value: string): string {
  const path = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = path.split("/");
  if (!path || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Export artefact path is invalid");
  return segments.join("/");
}

export async function readBrowserExportArtifact(sessionId: string, path: string): Promise<File> {
  if (!navigator.storage?.getDirectory) throw new Error("Origin private file system storage is unavailable");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error("Session identifier is invalid");
  const root = await getDirectoryAt(
    await navigator.storage.getDirectory(),
    `ceres-lerobot-v3/sessions/${sessionId}`,
    false,
  );
  return (await getFileHandleAt(root, normaliseRelativePath(path), false)).getFile();
}

/** Consume the exact manifest bytes even if a later export reused their shard. */
export async function withBrowserExportArtifact<T>(
  sessionId: string,
  expected: Pick<StoredExportArtifact, "path" | "sha256" | "byteLength">,
  consume: (file: File) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!navigator.storage?.getDirectory) throw new Error("Origin private file system storage is unavailable");
  const shard = /^shards\/episode-(\d{6,})\//.exec(expected.path);
  const episodeIndex = shard ? Number(shard[1]) : -1;
  if (!validStorageIdentifier(sessionId) || !safeRelativePath(expected.path)
    || !/^[a-f0-9]{64}$/.test(expected.sha256)
    || !Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0
    || (shard && (!Number.isSafeInteger(episodeIndex) || episodeShardPath(episodeIndex) !== `shards/episode-${shard[1]}`))) {
    throw new Error("The upload artefact reference is invalid");
  }
  const root = await navigator.storage.getDirectory();
  return withStoredExportLock(sessionId, episodeIndex, async () => {
    signal?.throwIfAborted();
    const canonical = await matchingFile(`${storedExportRoot}/sessions/${sessionId}`);
    if (canonical) return consume(canonical);
    if (shard) {
      let archives: FileSystemDirectoryHandle | null = null;
      try { archives = await exportDirectory(root, `${storedExportRoot}/archive/${sessionId}`); }
      catch (error) { if (!isMissingExport(error)) throw error; }
      if (archives) for await (const entry of archives.values()) {
        signal?.throwIfAborted();
        if (entry.kind !== "directory" || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const directory = entry as FileSystemDirectoryHandle;
        let archived;
        try { archived = await readExportReceipt(directory, episodeIndex); }
        catch (error) { signal?.throwIfAborted(); continue; }
        if (archived.sha256 !== entry.name || !archived.receipt.artifacts.some((artifact) => (
          artifact.path === expected.path && artifact.sha256 === expected.sha256 && artifact.byteLength === expected.byteLength
        ))) continue;
        const file = await matchingFile(`${storedExportRoot}/archive/${sessionId}/${entry.name}`);
        if (file) return consume(file);
      }
    }
    throw new Error(`Export artefact ${expected.path} no longer matches its upload manifest`);
  }, signal);

  async function matchingFile(location: string): Promise<File | null> {
    signal?.throwIfAborted();
    let file;
    try { file = await exportFile(await exportDirectory(root, location), expected.path); }
    catch (error) { if (isMissingExport(error)) return null; throw error; }
    if (file.size !== expected.byteLength || await fileSha256(file) !== expected.sha256) return null;
    signal?.throwIfAborted();
    return file;
  }
}

export function exportMediaType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".parquet")) return "application/vnd.apache.parquet";
  if (lower.endsWith(".jsonl")) return "application/x-ndjson";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
