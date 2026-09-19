import { episodeShardPath } from "../../shared/lerobot-export.js";
import type { StoredExportArtifact } from "./types.js";

export const storedExportRoot = "ceres-lerobot-v3";
export const storedExportReceiptName = "ceres/browser-export-receipt.json";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function failStoredExport(reason: string): never {
  throw new Error(`The saved capture ${reason}`);
}

export interface StoredExportReference {
  sessionId: string;
  episodeIndex: number;
  episodeId: string;
  receiptSha256: string;
  archiveId?: string;
}

export interface StoredExportReceipt {
  schemaVersion: 1;
  episodeId: string;
  episodeIndex: number;
  artifactCount: number;
  artifacts: Array<Omit<StoredExportArtifact, "file">>;
  savedAt?: string;
  capture?: { runTitle: string; cycle: number; taskLabel: string } | null;
}

export function validStorageIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

export function validateStoredExportReference(value: StoredExportReference): void {
  if (!validStorageIdentifier(value.sessionId) || !validStorageIdentifier(value.episodeId)
    || !Number.isSafeInteger(value.episodeIndex) || value.episodeIndex < 0
    || !hashPattern.test(value.receiptSha256)
    || (value.archiveId !== undefined && (value.archiveId !== value.receiptSha256 || !hashPattern.test(value.archiveId)))) {
    failStoredExport("reference is invalid");
  }
}

export function validateStoredExportReceipt(value: unknown, episodeIndex: number): StoredExportReceipt {
  const receipt = value as StoredExportReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.schemaVersion !== 1 || receipt.episodeIndex !== episodeIndex || !validStorageIdentifier(receipt.episodeId)
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0 || receipt.artifacts.length > 2048
    || receipt.artifactCount !== receipt.artifacts.length) failStoredExport("receipt is invalid");
  const prefix = `${episodeShardPath(episodeIndex)}/`;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const artifact of receipt.artifacts) {
    if (!artifact || typeof artifact !== "object" || typeof artifact.path !== "string"
      || !artifact.path.startsWith(prefix) || !safeRelativePath(artifact.path)
      || artifact.path === `${prefix}${storedExportReceiptName}` || seen.has(artifact.path)
      || typeof artifact.sha256 !== "string" || !hashPattern.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0
      || typeof artifact.mediaType !== "string" || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(artifact.mediaType)) {
      failStoredExport("contains an invalid file reference");
    }
    totalBytes += artifact.byteLength;
    if (!Number.isSafeInteger(totalBytes)) failStoredExport("size is invalid");
    seen.add(artifact.path);
  }
  if (!seen.has(`${prefix}ceres/episode-metadata.json`)) failStoredExport("metadata is missing");
  return receipt;
}

export function safeRelativePath(path: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function exportDirectory(root: FileSystemDirectoryHandle, path: string, create = false): Promise<FileSystemDirectoryHandle> {
  if (!safeRelativePath(path)) failStoredExport("path is invalid");
  let directory = root;
  for (const part of path.split("/")) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

export async function exportFile(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  if (!safeRelativePath(path)) failStoredExport("file path is invalid");
  const parts = path.split("/");
  const name = parts.pop()!;
  const directory = parts.length ? await exportDirectory(root, parts.join("/")) : root;
  return (await directory.getFileHandle(name)).getFile();
}

export async function writeExportFile(root: FileSystemDirectoryHandle, path: string, file: Blob): Promise<void> {
  if (!safeRelativePath(path)) failStoredExport("file path is invalid");
  const parts = path.split("/");
  const name = parts.pop()!;
  const directory = parts.length ? await exportDirectory(root, parts.join("/"), true) : root;
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(file);
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

export async function fileSha256(contents: Blob | Uint8Array): Promise<string> {
  const bytes = contents instanceof Blob ? await contents.arrayBuffer() : Uint8Array.from(contents).buffer;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isMissingExport(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

export async function readExportReceipt(root: FileSystemDirectoryHandle, episodeIndex: number) {
  const file = await exportFile(root, `${episodeShardPath(episodeIndex)}/${storedExportReceiptName}`);
  if (file.size > 1024 * 1024) failStoredExport("receipt is too large");
  return { file, receipt: validateStoredExportReceipt(JSON.parse(await file.text()), episodeIndex), sha256: await fileSha256(file) };
}

export async function verifiedExportArtifacts(root: FileSystemDirectoryHandle, receipt: StoredExportReceipt, signal?: AbortSignal): Promise<StoredExportArtifact[]> {
  const artifacts: StoredExportArtifact[] = [];
  for (const entry of receipt.artifacts) {
    signal?.throwIfAborted();
    const file = await exportFile(root, entry.path);
    if (file.size !== entry.byteLength || await fileSha256(file) !== entry.sha256) failStoredExport("failed file verification");
    artifacts.push({ ...entry, file });
  }
  return artifacts;
}

export async function withStoredExportLock<T>(sessionId: string, episodeIndex: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (typeof navigator !== "undefined" && navigator.locks) {
    const name = `ceres-saved-export:${sessionId}:${episodeIndex}`;
    return navigator.locks.request(name, { signal }, operation);
  }
  return operation();
}

export async function archivePreviousExport(root: FileSystemDirectoryHandle, sessionRoot: FileSystemDirectoryHandle, sessionId: string, episodeIndex: number, signal: AbortSignal): Promise<void> {
  let previous: Awaited<ReturnType<typeof readExportReceipt>>;
  try { previous = await readExportReceipt(sessionRoot, episodeIndex); }
  catch (error) { if (isMissingExport(error)) return; throw error; }
  const archiveRoot = await exportDirectory(root, `${storedExportRoot}/archive/${sessionId}/${previous.sha256}`, true);
  try {
    const archived = await readExportReceipt(archiveRoot, episodeIndex);
    if (archived.sha256 !== previous.sha256) failStoredExport("archive has changed");
    await verifiedExportArtifacts(archiveRoot, archived.receipt, signal);
    await retireSourceFiles();
    return;
  } catch (error) { if (!isMissingExport(error)) throw error; }
  for (const artifact of await verifiedExportArtifacts(sessionRoot, previous.receipt, signal)) {
    signal.throwIfAborted();
    await writeExportFile(archiveRoot, artifact.path, artifact.file);
  }
  signal.throwIfAborted();
  await writeExportFile(archiveRoot, `${episodeShardPath(episodeIndex)}/${storedExportReceiptName}`, previous.file);
  await retireSourceFiles();

  async function retireSourceFiles() {
    const directory = await exportDirectory(sessionRoot, `${episodeShardPath(episodeIndex)}/ceres`);
    await directory.removeEntry("browser-export-receipt.json");
    for (const artifact of previous.receipt.artifacts) {
      signal.throwIfAborted();
      const parts = artifact.path.split("/");
      const name = parts.pop()!;
      try {
        await (await exportDirectory(sessionRoot, parts.join("/"))).removeEntry(name);
      } catch (error) { if (!isMissingExport(error)) throw error; }
    }
  }
}
