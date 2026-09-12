import {
  RecorderBlockFlags,
  decodeRecorderBlock,
  encodeRecorderRunEvent,
  encodeRecorderMediaPayload,
  encodeRecorderBlock,
  type RecorderAck,
  type RecorderError,
  type RecorderRunEvent,
} from "../../shared/protocol.js";
import { FixedRateRecorderClock } from "./fixed-rate-clock.js";
import {
  decodeRecorderJournalCommit,
  planRecorderJournalRecovery,
  RECORDER_JOURNAL_FILE_PATTERN,
  RECORDER_JOURNAL_TEMP_FILE_PATTERN,
  recorderJournalCommitFileName,
  recorderJournalCandidateFromDecodedBlock,
  recorderSequenceFileName,
  recorderSequenceTempFileName,
  validateRecorderJournalPromotion,
  type RecorderJournalCandidate,
  type RecorderJournalCandidateMetadata,
} from "./recorder-journal.js";
import { isTerminalRecorderPairingClose, shouldReconnectRecorderTransport } from "./recorder-transport-policy.js";
import { RecorderWorkerLifecycle } from "./recorder-worker-lifecycle.js";
import {
  canAcceptSoloPeerBlock,
  SOLO_PEER_WINDOW_MAX_BYTES,
  SOLO_PEER_WINDOW_SIZE,
} from "./recorder-delivery-policy.js";
import { TELEMETRY_VALUE_COUNT, decodeTelemetryFrame } from "./telemetry-buffer.js";
import { loadRecorderKernels, type RecorderKernels } from "../../wasm/recorder-kernels/ts/loader.js";

const MINIMUM_STORAGE_HEADROOM_BYTES = 128 * 1024 * 1024;
const STORAGE_PROBE_INTERVAL_BLOCKS = 300;
const RING_WRITE_INDEX = 0;
const RING_READ_INDEX = 1;
const RING_OVERRUN_COUNT = 2;
const SOLO_PEER_FRESH_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const SOLO_PEER_MESSAGE_BATCH_SIZE = 16;
const SOLO_PEER_MESSAGE_BATCH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_RECORDER_BLOCK_BYTES = 64 * 1024 * 1024;
const SAFE_PAIRING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPTURE_RECORDER_STORAGE_ROOTS = new Set([
  "ceres-recorder",
  "ceres-solo-recordings",
]);
const LEGACY_SOLO_CAPTURE_STORAGE_ROOT = "ceres-solo-recorder";
const textEncoder = new TextEncoder();
const monotonicNowUs = () => Math.round((performance.timeOrigin + performance.now()) * 1_000);

type MovableFileHandle = FileSystemFileHandle & {
  move?: (name: string) => Promise<void>;
};

type SyncAccessHandle = {
  close(): void;
  flush(): void;
  getSize(): number;
  truncate(size: number): void;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
};

type WritableFileStreamLike = {
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
};

type CompatibleFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
  createWritable?: (options?: { keepExistingData?: boolean }) => Promise<WritableFileStreamLike>;
};

type RecorderState = "idle" | "arming" | "armed" | "recording" | "paused" | "failed";
type PeerReadyState = { sessionId: string; nextSequence: number };
type PeerDeliveredBlock = { sequence: number; byteLength: number };

let state: RecorderState = "idle";
let transportState: "offline" | "connecting" | "connected" = "offline";
let sessionId = "";
let pairingId = "";
let storageRootName = "ceres-recorder";
let episodeId = "";
let transportUrl = "";
let transportMode: "websocket" | "peer" = "websocket";
let peerReady = false;
let wallClockOffsetMs = 0;
let rateHz = 30;
let directory: FileSystemDirectoryHandle | null = null;
let legacyStorageDirectory: FileSystemDirectoryHandle | null = null;
let legacyDirectory: FileSystemDirectoryHandle | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let clock: FixedRateRecorderClock | null = null;
let nextSequence = 0;
let durableAckSequence = -1;
let finaliseStartAckSequence: number | null = null;
let finaliseTargetSequence: number | null = null;
let explicitGaps = 0;
let persistedBlockCount = 0;
let inFlightSequence: number | null = null;
let peerDeliveringSequence: number | null = null;
let peerDeliveringByteLength = 0;
let peerDeliveredBlocks: PeerDeliveredBlock[] = [];
let peerDeliveredBytes = 0;
let peerCapacityBlocked = false;
let soloPeerDeliveryInProgress = false;
let soloPeerDeliveringBlocks: PeerDeliveredBlock[] = [];
let soloPeerDeliveryGeneration = 0;
const freshPeerBlocks = new Map<number, Uint8Array>();
let freshPeerBlockBytes = 0;
let pendingSequences: number[] = [];
let writeTail = Promise.resolve();
let sharedControl: Int32Array | null = null;
let sharedValues: Float64Array | null = null;
let sharedCapacity = 0;
let closed = false;
let terminalPairingFailure = false;
let captureRegistered = false;
let journalReady = false;
let latchedPeerReady: PeerReadyState | null = null;
const pendingTemporarySequences = new Set<number>();
const migratedLegacyNames = new Map<number, string[]>();
let kernels: RecorderKernels | null = null;
let lastBlockSourceTimestampUs = 0;
let lastRecorderFrameIndex = 0;
let failureReason: string | null = null;
let shutdownStarted = false;
const sharedScratch = new Float64Array(TELEMETRY_VALUE_COUNT);
let pendingSample: { frame: ReturnType<typeof decodeTelemetryFrame>; sourceTimestampUs: number; recorderFrameIndex: number; flags: number } | null = null;

const workerScope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  setInterval(handler: () => void, timeout: number): number;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const postStatus = (error: string | null = failureReason) => {
  workerScope.postMessage({
    type: "status",
    status: {
      state,
      transport: transportState,
      recorderFrameIndex: clock?.frameIndex ?? 0,
      durableAckSequence,
      pendingBlocks: pendingSequences.length,
      queuedBlocks: Math.max(0, nextSequence - durableAckSequence - 1),
      finaliseStartAckSequence,
      finaliseTargetSequence,
      explicitGaps,
      captureOverruns: sharedControl ? Atomics.load(sharedControl, RING_OVERRUN_COUNT) : 0,
      error,
    },
  });
};

const failClosed = (message: string) => {
  if (state === "failed") return;
  failureReason = message;
  state = "failed";
  clock = null;
  postStatus(message);
};

const lifecycle = new RecorderWorkerLifecycle((error) => {
  failClosed(error instanceof Error ? error.message : "Recorder lifecycle operation failed");
});

const checkStorageHeadroom = async () => {
  const estimate = await navigator.storage.estimate();
  if (!estimate.quota || estimate.usage === undefined) throw new Error("Storage headroom cannot be established");
  const headroom = estimate.quota - estimate.usage;
  const required = Math.max(MINIMUM_STORAGE_HEADROOM_BYTES, Math.floor(estimate.quota * 0.05));
  if (headroom < required) throw new Error(`Recorder storage headroom is unsafe (${headroom} bytes available, ${required} required)`);
};

const readFileBytes = async (fileHandle: FileSystemFileHandle, label: string) => {
  const file = await fileHandle.getFile();
  if (file.size > MAX_CAPTURE_RECORDER_BLOCK_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_CAPTURE_RECORDER_BLOCK_BYTES}-byte capture recorder limit`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error(`${label} was not read in full`);
  return bytes;
};

const readDirectoryFile = async (name: string) => {
  if (!directory) throw new Error("Recorder journal is not open");
  const file = await directory.getFileHandle(name);
  return readFileBytes(file, `Recorder journal file ${name}`);
};

const writeDirectoryFileDurably = async (name: string, bytes: Uint8Array) => {
  if (!directory) throw new Error("Recorder journal is not open");
  if (bytes.byteLength > MAX_CAPTURE_RECORDER_BLOCK_BYTES) {
    throw new Error(`Recorder journal file ${name} exceeds the ${MAX_CAPTURE_RECORDER_BLOCK_BYTES}-byte capture recorder limit`);
  }
  const file = await directory.getFileHandle(name, { create: true }) as CompatibleFileHandle;
  if (typeof file.createSyncAccessHandle !== "function") {
    if (typeof file.createWritable !== "function") {
      throw new Error("Durable OPFS writing is unavailable in this browser");
    }
    const writable = await file.createWritable({ keepExistingData: false });
    const writableBytes = bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
    let closed = false;
    try {
      await writable.write(writableBytes);
      await writable.close();
      closed = true;
    } catch (error) {
      if (!closed) await writable.abort(error).catch(() => undefined);
      throw error;
    }
    return;
  }
  const handle = await file.createSyncAccessHandle();
  let operationFailed = false;
  try {
    handle.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = handle.write(bytes.subarray(offset), { at: offset });
      const remaining = bytes.byteLength - offset;
      if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
        throw new Error(`Recorder journal file ${name} write did not make valid progress`);
      }
      offset += written;
    }
    handle.flush();
    const size = handle.getSize();
    if (size !== bytes.byteLength) {
      throw new Error(`Recorder journal file ${name} size mismatch (${size} bytes stored, ${bytes.byteLength} expected)`);
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      handle.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
};

const moveJournalFile = async (
  from: string,
  to: string,
  options: {
    fallbackBytes?: Uint8Array;
    expected?: RecorderJournalCandidateMetadata;
    retainTemporaryUntilRead?: boolean;
  } = {},
) => {
  if (!directory) throw new Error("Recorder journal is not open");
  const handle = await directory.getFileHandle(from) as MovableFileHandle;
  let fallbackBytes = options.fallbackBytes;
  if (options.expected) {
    fallbackBytes ??= await readFileBytes(handle, `Recorder journal file ${from}`);
    validateRecorderJournalPromotion(fallbackBytes, options.expected);
  }
  if (typeof handle.move === "function") {
    try {
      await handle.move(to);
      if (options.expected) {
        const persisted = await readDirectoryFile(to);
        validateRecorderJournalPromotion(persisted, options.expected);
      }
      return;
    } catch {
      // Older Quest Browser storage implementations retain the durable copy fallback.
    }
  }
  fallbackBytes ??= await readFileBytes(handle, `Recorder journal file ${from}`);
  if (options.expected) validateRecorderJournalPromotion(fallbackBytes, options.expected);
  await writeDirectoryFileDurably(to, fallbackBytes);
  if (options.expected) {
    const persisted = await readDirectoryFile(to);
    validateRecorderJournalPromotion(persisted, options.expected);
  }
  if (options.retainTemporaryUntilRead) return true;
  await directory.removeEntry(from).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  return false;
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const isCanonicalSoloJournal = () => storageRootName === "ceres-solo-recordings";

const flushProbe = async () => {
  if (!directory) throw new Error("Recorder journal is not open");
  const name = ".flush-probe";
  const expected = new Uint8Array([0x43, 0x52, 0x45, 0x53, 0x01, 0xa5, 0x5a, 0xff]);
  try {
    await writeDirectoryFileDurably(name, expected);
    const actual = await readDirectoryFile(name);
    if (actual.byteLength !== expected.byteLength) throw new Error("Recorder flush probe was not read in full");
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) throw new Error("Recorder flush probe did not round trip");
    }
  } finally {
    await directory.removeEntry(name).catch(() => undefined);
  }
};

const recorderCommitNextSequence = async () => {
  if (!isCanonicalSoloJournal()) return undefined;
  let data: Uint8Array;
  try {
    data = await readDirectoryFile(recorderJournalCommitFileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
  const commit = decodeRecorderJournalCommit(sessionId, data);
  return (commit.committedThrough ?? -1) + 1;
};

const recorderRecoveryBoundary = async () => {
  const peerNextSequence = transportMode === "peer" ? latchedPeerReady?.nextSequence : undefined;
  const commitNextSequence = await recorderCommitNextSequence();
  if (peerNextSequence === undefined) return commitNextSequence;
  if (commitNextSequence === undefined) return peerNextSequence;
  return Math.max(peerNextSequence, commitNextSequence);
};

const scanJournal = async () => {
  if (!directory) return;
  const candidates: RecorderJournalCandidate[] = [];
  const validatedCandidates = new Map<string, RecorderJournalCandidateMetadata>();
  const acknowledgedNames = new Set<string>();
  const recoveryBoundary = await recorderRecoveryBoundary();
  for await (const entry of (directory as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const name = entry[0];
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(name) ?? RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(name);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (Number.isSafeInteger(sequence) && recoveryBoundary !== undefined && sequence < recoveryBoundary) {
      acknowledgedNames.add(name);
      continue;
    }
    try {
      const data = await readFileBytes(entry[1] as FileSystemFileHandle, `Recorder journal file ${name}`);
      const block = decodeRecorderBlock(data);
      const candidate = recorderJournalCandidateFromDecodedBlock(name, block);
      candidates.push(candidate);
      if (candidate.metadata) validatedCandidates.set(name, candidate.metadata);
    } catch (error) {
      candidates.push({
        name,
        error: error instanceof Error ? error.message : "journal data could not be read",
      });
    }
  }
  const recoveryCandidates = recoveryBoundary === undefined
    ? candidates
    : candidates.filter((candidate) => {
      const match = RECORDER_JOURNAL_FILE_PATTERN.exec(candidate.name)
        ?? RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(candidate.name);
      const sequence = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(sequence) || sequence >= recoveryBoundary) return true;
      acknowledgedNames.add(candidate.name);
      validatedCandidates.delete(candidate.name);
      return false;
    });
  const recovery = planRecorderJournalRecovery(
    sessionId,
    recoveryCandidates,
    recoveryBoundary,
    isCanonicalSoloJournal() ? recoveryBoundary : undefined,
  );
  const removeNames = isCanonicalSoloJournal()
    ? recovery.removeNames
    : [...acknowledgedNames, ...recovery.removeNames];
  for (const name of new Set(removeNames)) await directory.removeEntry(name).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  for (const promotion of recovery.promotions) {
    const expected = validatedCandidates.get(promotion.from);
    if (!expected) throw new Error("Recorder journal promotion candidate is invalid");
    await moveJournalFile(promotion.from, promotion.to, { expected });
  }
  pendingSequences = recovery.pendingSequences;
  nextSequence = Math.max(recovery.nextSequence, recoveryBoundary ?? 0);
};

const removeLegacySessionIfEmpty = async () => {
  if (!legacyStorageDirectory || !legacyDirectory) return;
  for await (const _entry of (legacyDirectory as any).entries() as AsyncIterable<[string, FileSystemHandle]>) return;
  await legacyStorageDirectory.removeEntry(sessionId).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  legacyDirectory = null;
};

const removeLegacyNames = async (names: readonly string[]) => {
  if (!legacyDirectory) return;
  for (const name of names) await legacyDirectory.removeEntry(name).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  await removeLegacySessionIfEmpty();
};

const cleanupMigratedLegacyBlock = async (sequence: number) => {
  const names = migratedLegacyNames.get(sequence);
  if (!names) return;
  await removeLegacyNames(names);
  migratedLegacyNames.delete(sequence);
};

const readLegacyJournalFile = async (name: string) => {
  if (!legacyDirectory) throw new Error(`Legacy Solo recorder journal file ${name} is no longer available`);
  const handle = await legacyDirectory.getFileHandle(name);
  return readFileBytes(handle, `Legacy Solo recorder journal file ${name}`);
};

const migrateLegacySoloJournal = async (root: FileSystemDirectoryHandle) => {
  if (!isCanonicalSoloJournal() || !directory) return;
  try {
    legacyStorageDirectory = await root.getDirectoryHandle(LEGACY_SOLO_CAPTURE_STORAGE_ROOT);
    legacyDirectory = await legacyStorageDirectory.getDirectoryHandle(sessionId);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      legacyStorageDirectory = null;
      legacyDirectory = null;
      return;
    }
    throw error;
  }

  const candidates: RecorderJournalCandidate[] = [];
  const readableNames = new Set<string>();
  const namesBySequence = new Map<number, string[]>();
  for await (const [name, handle] of (legacyDirectory as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(name) ?? RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(name);
    if (!match || handle.kind !== "file") continue;
    const sequence = Number(match[1]);
    if (Number.isSafeInteger(sequence)) {
      const names = namesBySequence.get(sequence) ?? [];
      names.push(name);
      namesBySequence.set(sequence, names);
    }
    try {
      const bytes = await readFileBytes(handle as FileSystemFileHandle, `Legacy Solo recorder journal file ${name}`);
      const block = decodeRecorderBlock(bytes);
      candidates.push(recorderJournalCandidateFromDecodedBlock(name, block));
      readableNames.add(name);
    } catch (error) {
      candidates.push({
        name,
        error: error instanceof Error ? error.message : "legacy journal data could not be read",
      });
    }
  }
  if (candidates.length === 0) {
    await removeLegacySessionIfEmpty();
    return;
  }

  const recoveryBoundary = await recorderRecoveryBoundary();
  const acknowledgedSequences = new Set<number>();
  const recoveryCandidates = candidates.filter((candidate) => {
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(candidate.name)
      ?? RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(candidate.name);
    const sequence = match ? Number(match[1]) : Number.NaN;
    if (recoveryBoundary === undefined || !Number.isSafeInteger(sequence) || sequence >= recoveryBoundary) return true;
    acknowledgedSequences.add(sequence);
    return false;
  });
  for (const sequence of acknowledgedSequences) {
    let canonicalBytes: Uint8Array;
    try {
      canonicalBytes = await readDirectoryFile(recorderSequenceFileName(sequence));
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        throw new Error(`Canonical Solo recorder journal is missing committed block ${sequence}`);
      }
      throw error;
    }
    const canonicalBlock = decodeRecorderBlock(canonicalBytes);
    if (canonicalBlock.sessionId !== sessionId || canonicalBlock.sequence !== sequence) {
      throw new Error(`Canonical Solo recorder committed block ${sequence} identity is invalid`);
    }
    for (const name of namesBySequence.get(sequence) ?? []) {
      if (!readableNames.has(name)) continue;
      const legacyBytes = await readLegacyJournalFile(name);
      if (!sameBytes(canonicalBytes, legacyBytes)) {
        throw new Error(`Legacy Solo recorder block ${sequence} conflicts with the committed canonical journal`);
      }
    }
    await removeLegacyNames(namesBySequence.get(sequence) ?? []);
  }
  if (!legacyDirectory || recoveryCandidates.length === 0) return;

  const recovery = planRecorderJournalRecovery(
    sessionId,
    recoveryCandidates,
    undefined,
    recoveryBoundary,
  );
  const pendingSequenceSet = new Set(recovery.pendingSequences);
  const discardNames = recovery.removeNames.filter((name) => {
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(name) ?? RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(name);
    return !match || !pendingSequenceSet.has(Number(match[1]));
  });
  await removeLegacyNames(discardNames);
  if (!legacyDirectory) return;

  const promotedSourceByFinalName = new Map(recovery.promotions.map(({ from, to }) => [to, from]));
  for (const sequence of recovery.pendingSequences) {
    const finalName = recorderSequenceFileName(sequence);
    const sourceName = promotedSourceByFinalName.get(finalName) ?? finalName;
    if (!readableNames.has(sourceName)) throw new Error(`Legacy Solo recorder block ${sequence} cannot be migrated`);
    const sourceBytes = await readLegacyJournalFile(sourceName);
    const sourceBlock = decodeRecorderBlock(sourceBytes);
    if (sourceBlock.sessionId !== sessionId || sourceBlock.sequence !== sequence) {
      throw new Error(`Legacy Solo recorder block ${sequence} identity is invalid`);
    }

    let canonicalBytes: Uint8Array | null = null;
    try {
      canonicalBytes = await readDirectoryFile(finalName);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    }
    if (canonicalBytes) {
      if (!sameBytes(canonicalBytes, sourceBytes)) {
        throw new Error(`Legacy Solo recorder block ${sequence} conflicts with the canonical journal`);
      }
    } else {
      if (sequence !== nextSequence) {
        throw new Error(`Legacy Solo recorder journal is missing canonical block ${nextSequence} before ${sequence}`);
      }
      await writeDirectoryFileDurably(finalName, sourceBytes);
      const persisted = await readDirectoryFile(finalName);
      if (!sameBytes(persisted, sourceBytes)) {
        throw new Error(`Legacy Solo recorder block ${sequence} did not migrate durably`);
      }
    }
    if (sequence > nextSequence) {
      throw new Error(`Legacy Solo recorder journal is missing canonical block ${nextSequence} before ${sequence}`);
    }
    if (sequence === nextSequence) nextSequence += 1;
    if (!pendingSequences.includes(sequence)) pendingSequences.push(sequence);
    migratedLegacyNames.set(sequence, [...(namesBySequence.get(sequence) ?? [sourceName])]);
  }
  pendingSequences.sort((left, right) => left - right);
};

const openJournal = async () => {
  const storage = navigator.storage as StorageManager & { getDirectory(): Promise<FileSystemDirectoryHandle> };
  const root = await storage.getDirectory();
  const ceres = await root.getDirectoryHandle(storageRootName, { create: true });
  const session = await ceres.getDirectoryHandle(sessionId, { create: true });
  directory = isCanonicalSoloJournal()
    ? await session.getDirectoryHandle("recorder", { create: true })
    : session;
  await checkStorageHeadroom();
  await flushProbe();
  await scanJournal();
  await migrateLegacySoloJournal(root);
};

const readJournalBlock = async (sequence: number) => {
  const value = await readDirectoryFile(recorderSequenceFileName(sequence));
  const decoded = decodeRecorderBlock(value);
  if (decoded.sessionId !== sessionId || decoded.sequence !== sequence) throw new Error(`Recorder journal block ${sequence} identity is invalid`);
  if (pendingTemporarySequences.has(sequence) && directory) {
    await directory.removeEntry(recorderSequenceTempFileName(sequence)).catch((error) => {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    });
    pendingTemporarySequences.delete(sequence);
  }
  return value;
};

const cleanupJournalBlock = async (sequence: number) => {
  if (isCanonicalSoloJournal()) {
    await cleanupMigratedLegacyBlock(sequence).catch(() => undefined);
    return;
  }
  if (!directory) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await directory.removeEntry(recorderSequenceFileName(sequence));
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      if (attempt === 4) return;
      await new Promise<void>((resolve) => { workerScope.setTimeout(resolve, 25 * 2 ** attempt); });
    }
  }
};

const clearFreshPeerBlocks = () => {
  freshPeerBlocks.clear();
  freshPeerBlockBytes = 0;
};

const cacheFreshPeerBlock = (sequence: number, block: Uint8Array) => {
  if (!isCanonicalSoloJournal()
    || transportMode !== "peer"
    || block.byteLength > SOLO_PEER_FRESH_CACHE_MAX_BYTES - freshPeerBlockBytes) return;
  freshPeerBlocks.set(sequence, block);
  freshPeerBlockBytes += block.byteLength;
};

const releaseFreshPeerBlock = (sequence: number) => {
  const block = freshPeerBlocks.get(sequence);
  if (!block) return;
  freshPeerBlocks.delete(sequence);
  freshPeerBlockBytes -= block.byteLength;
};

const pumpSoloPeerTransport = async () => {
  if (soloPeerDeliveryInProgress
    || peerDeliveredBlocks.length >= SOLO_PEER_WINDOW_SIZE
    || peerDeliveredBytes >= SOLO_PEER_WINDOW_MAX_BYTES
    || peerCapacityBlocked
    || !peerReady
    || pendingSequences.length === 0
    || state === "failed") return;

  soloPeerDeliveryInProgress = true;
  const generation = ++soloPeerDeliveryGeneration;
  const deliveries: Array<{ sequence: number; block: Uint8Array; cached: boolean }> = [];
  let projectedBlockCount = peerDeliveredBlocks.length;
  let projectedBytes = peerDeliveredBytes;
  let messageBytes = 0;
  try {
    while (deliveries.length < SOLO_PEER_MESSAGE_BATCH_SIZE) {
      const sequence = pendingSequences[peerDeliveredBlocks.length + deliveries.length];
      if (sequence === undefined) break;
      const cachedBlock = freshPeerBlocks.get(sequence);
      const block = cachedBlock ?? await readJournalBlock(sequence);
      if (generation !== soloPeerDeliveryGeneration
        || !soloPeerDeliveryInProgress
        || !peerReady
        || failureReason !== null) return;
      const currentSequence = pendingSequences[peerDeliveredBlocks.length + deliveries.length];
      if (currentSequence !== sequence) {
        soloPeerDeliveryInProgress = false;
        void pumpTransport();
        return;
      }
      if (!canAcceptSoloPeerBlock(projectedBlockCount, projectedBytes, block.byteLength)) {
        if (deliveries.length === 0) peerCapacityBlocked = true;
        break;
      }
      if (deliveries.length > 0
        && messageBytes + block.byteLength > SOLO_PEER_MESSAGE_BATCH_MAX_BYTES) break;
      deliveries.push({ sequence, block, cached: Boolean(cachedBlock) });
      projectedBlockCount += 1;
      projectedBytes += block.byteLength;
      messageBytes += block.byteLength;
    }
    if (generation !== soloPeerDeliveryGeneration || !soloPeerDeliveryInProgress) return;
    if (deliveries.length === 0) {
      soloPeerDeliveryInProgress = false;
      return;
    }
    soloPeerDeliveringBlocks = deliveries.map(({ sequence, block }) => ({
      sequence,
      byteLength: block.byteLength,
    }));
    for (const delivery of deliveries) {
      if (delivery.cached) releaseFreshPeerBlock(delivery.sequence);
    }
    const blocks = deliveries.map(({ sequence, block }) => ({
      sequence,
      block: block.buffer,
    }));
    workerScope.postMessage(
      { type: "peer-blocks", generation, blocks },
      blocks.map(({ block }) => block),
    );
  } catch (error) {
    if (generation !== soloPeerDeliveryGeneration) return;
    soloPeerDeliveryInProgress = false;
    soloPeerDeliveringBlocks = [];
    failClosed(error instanceof Error ? error.message : "Recorder journal peer replay failed");
  }
};

const pumpTransport = async () => {
  if (transportMode === "peer") {
    if (isCanonicalSoloJournal()) {
      await pumpSoloPeerTransport();
      return;
    }
    if (peerDeliveringSequence !== null
      || peerDeliveredBlocks.length >= 1
      || !peerReady
      || pendingSequences.length === 0
      || state === "failed") return;
    const sequence = pendingSequences[peerDeliveredBlocks.length];
    if (sequence === undefined) return;
    peerDeliveringSequence = sequence;
    peerDeliveringByteLength = 0;
    try {
      const block = await readJournalBlock(sequence);
      if (peerDeliveringSequence !== sequence
        || pendingSequences[peerDeliveredBlocks.length] !== sequence
        || !peerReady
        || failureReason !== null) {
        if (peerDeliveringSequence === sequence) {
          peerDeliveringSequence = null;
          peerDeliveringByteLength = 0;
        }
        return;
      }
      peerDeliveringByteLength = block.byteLength;
      workerScope.postMessage({ type: "peer-block", sequence, block: block.buffer }, [block.buffer]);
    } catch (error) {
      if (peerDeliveringSequence === sequence) {
        peerDeliveringSequence = null;
        peerDeliveringByteLength = 0;
      }
      failClosed(error instanceof Error ? error.message : "Recorder journal peer replay failed");
    }
    return;
  }
  const activeSocket = socket;
  if (inFlightSequence !== null || activeSocket?.readyState !== WebSocket.OPEN || pendingSequences.length === 0 || state === "failed") return;
  const sequence = pendingSequences[0];
  inFlightSequence = sequence;
  try {
    const block = await readJournalBlock(sequence);
    if (socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN || inFlightSequence !== sequence || failureReason !== null) {
      if (inFlightSequence === sequence) inFlightSequence = null;
      return;
    }
    activeSocket.send(block);
  } catch (error) {
    if (inFlightSequence === sequence) inFlightSequence = null;
    failClosed(error instanceof Error ? error.message : "Recorder journal replay failed");
  }
};

const scheduleReconnect = () => {
  if (reconnectTimer !== null || !shouldReconnectRecorderTransport(
    closed,
    state === "failed",
    terminalPairingFailure,
    captureRegistered,
    journalReady,
  )) return;
  reconnectTimer = workerScope.setTimeout(() => {
    reconnectTimer = null;
    connectTransport();
  }, 1_000);
};

const handleAck = async (message: RecorderAck) => {
  const expectedInFlightSequence = transportMode === "peer"
    ? peerDeliveredBlocks[0]?.sequence
    : inFlightSequence;
  if (message.sessionId !== sessionId
    || message.sequence !== expectedInFlightSequence
    || pendingSequences[0] !== message.sequence) {
    failClosed("Recorder server acknowledged an unexpected sequence");
    return;
  }
  pendingSequences.shift();
  if (transportMode === "peer") {
    const acknowledgedBlock = peerDeliveredBlocks.shift();
    if (acknowledgedBlock) {
      peerDeliveredBytes -= acknowledgedBlock.byteLength;
    }
    peerCapacityBlocked = false;
  } else inFlightSequence = null;
  durableAckSequence = message.sequence;
  postStatus();
  void cleanupJournalBlock(message.sequence);
  void pumpTransport();
};

const applyPeerReady = (ready: PeerReadyState) => {
  if (!journalReady || state === "failed") return;
  const next = ready.nextSequence;
  const acknowledgedSequences = pendingSequences.filter((sequence) => sequence < next);
  pendingSequences = pendingSequences.filter((sequence) => sequence >= next);
  peerDeliveringSequence = null;
  peerDeliveringByteLength = 0;
  peerDeliveredBlocks = [];
  peerDeliveredBytes = 0;
  peerCapacityBlocked = false;
  soloPeerDeliveryInProgress = false;
  soloPeerDeliveringBlocks = [];
  soloPeerDeliveryGeneration += 1;
  clearFreshPeerBlocks();
  if (next > 0) durableAckSequence = Math.max(durableAckSequence, next - 1);
  for (const sequence of acknowledgedSequences) void cleanupJournalBlock(sequence);
  nextSequence = Math.max(nextSequence, next);
  peerReady = true;
  transportState = "connected";
  if (state === "arming") state = "armed";
  postStatus();
  void pumpTransport();
};

const handlePeerReady = (message: unknown) => {
  if (!message || typeof message !== "object") return failClosed("Monitor recorder returned an invalid ready state");
  const value = message as { type?: string; sessionId?: unknown; nextSequence?: unknown };
  const next = typeof value.nextSequence === "number" ? value.nextSequence : Number.NaN;
  if (value.type !== "recorder-ready" || value.sessionId !== sessionId || !Number.isSafeInteger(next) || next < 0) {
    return failClosed("Monitor recorder returned an invalid ready state");
  }
  const ready = { sessionId, nextSequence: next };
  if (!journalReady) {
    if (!latchedPeerReady || ready.nextSequence > latchedPeerReady.nextSequence) latchedPeerReady = ready;
    return;
  }
  applyPeerReady(ready);
};

const handlePeerControl = (message: unknown) => {
  if (!message || typeof message !== "object") return failClosed("Monitor recorder returned an invalid control message");
  const value = message as { type?: string; sessionId?: unknown; sequence?: unknown; status?: unknown; message?: unknown };
  if (value.type === "recorder-ready") return handlePeerReady(value);
  if (value.type === "recorder-ack") {
    const sequence = typeof value.sequence === "number" ? value.sequence : Number.NaN;
    if (value.sessionId !== sessionId || !Number.isSafeInteger(sequence)) return failClosed("Monitor recorder acknowledged an invalid sequence");
    return void handleAck({ type: "recorder-ack", sessionId, episodeId, sequence, recorderFrameIndex: 0, status: value.status === "duplicate" ? "duplicate" : "durable" });
  }
  if (value.type === "recorder-error") return failClosed(typeof value.message === "string" ? value.message : "Monitor recorder failed");
  failClosed("Monitor recorder returned an unsupported control message");
};

const handlePeerDelivery = (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as { sequence?: unknown; accepted?: unknown };
  if (!Number.isSafeInteger(value.sequence) || value.sequence !== peerDeliveringSequence) return;
  const sequence = value.sequence as number;
  const byteLength = peerDeliveringByteLength;
  peerDeliveringSequence = null;
  peerDeliveringByteLength = 0;
  peerCapacityBlocked = false;
  if (value.accepted === true) {
    peerDeliveredBlocks.push({ sequence, byteLength });
    peerDeliveredBytes += byteLength;
    void pumpTransport();
    return;
  }
  workerScope.setTimeout(() => void pumpTransport(), 100);
};

const handleSoloPeerDeliveries = (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as { generation?: unknown; deliveries?: unknown };
  if (!Number.isSafeInteger(value.generation) || value.generation !== soloPeerDeliveryGeneration) return;
  if (!soloPeerDeliveryInProgress || !Array.isArray(value.deliveries)) {
    failClosed("Solo recorder returned an invalid peer delivery batch");
    return;
  }
  const deliveries = value.deliveries as Array<{ sequence?: unknown; accepted?: unknown }>;
  if (deliveries.length !== soloPeerDeliveringBlocks.length) {
    failClosed("Solo recorder returned an incomplete peer delivery batch");
    return;
  }
  let rejected = false;
  for (let index = 0; index < deliveries.length; index += 1) {
    const delivery = deliveries[index];
    const expected = soloPeerDeliveringBlocks[index];
    if (!delivery
      || !expected
      || delivery.sequence !== expected.sequence
      || typeof delivery.accepted !== "boolean"
      || (rejected && delivery.accepted)) {
      failClosed("Solo recorder returned a conflicting peer delivery batch");
      return;
    }
    if (!delivery.accepted) {
      rejected = true;
      continue;
    }
    peerDeliveredBlocks.push(expected);
    peerDeliveredBytes += expected.byteLength;
  }
  soloPeerDeliveringBlocks = [];
  soloPeerDeliveryInProgress = false;
  peerCapacityBlocked = false;
  if (rejected) {
    workerScope.setTimeout(() => void pumpTransport(), 100);
  } else {
    void pumpTransport();
  }
};

const finishEpisode = async () => {
  await writeTail;
  while (pendingSequences.length > 0
    || inFlightSequence !== null
    || peerDeliveringSequence !== null
    || soloPeerDeliveryInProgress
    || soloPeerDeliveringBlocks.length > 0
    || peerDeliveredBlocks.length > 0) {
    if (state === "failed") return;
    await new Promise<void>((resolve) => workerScope.setTimeout(resolve, 10));
  }
  episodeId = "";
  workerScope.postMessage({ type: "finished" });
};

const connectTransport = () => {
  if (transportMode !== "websocket"
    || !transportUrl
    || !captureRegistered
    || !journalReady
    || closed
    || state === "failed"
    || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
  socket?.close();
  transportState = "connecting";
  postStatus();
  const candidate = new WebSocket(transportUrl);
  candidate.binaryType = "arraybuffer";
  socket = candidate;
  candidate.addEventListener("open", () => {
    if (socket !== candidate) return;
    transportState = "connected";
    candidate.send(JSON.stringify({ type: "register", role: "recorder", sessionId, pairingId }));
    postStatus();
  });
  candidate.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: RecorderAck | RecorderError | { type: string; code?: string; message?: string };
    try {
      message = JSON.parse(event.data);
    } catch {
      failClosed("Recorder server returned an unreadable acknowledgement");
      return;
    }
    if (message.type === "pairing-rejected") {
      terminalPairingFailure = true;
      failClosed(`${message.code ?? "recorder-pairing-rejected"}: ${message.message ?? "Recorder pairing was rejected"}`);
      candidate.close();
      return;
    }
    if (message.type === "recorder-ready") {
      const ready = message as { type: "recorder-ready"; sessionId: string; nextSequence: number };
      if (ready.sessionId !== sessionId || !Number.isSafeInteger(ready.nextSequence) || ready.nextSequence < 0) {
        failClosed("Recorder server returned an invalid ready state");
        return;
      }
      const acknowledgedSequences = pendingSequences.filter((sequence) => sequence < ready.nextSequence);
      pendingSequences = pendingSequences.filter((sequence) => sequence >= ready.nextSequence);
      if (ready.nextSequence > 0) durableAckSequence = Math.max(durableAckSequence, ready.nextSequence - 1);
      for (const sequence of acknowledgedSequences) void cleanupJournalBlock(sequence);
      nextSequence = Math.max(nextSequence, ready.nextSequence);
      if (state === "arming") state = "armed";
      postStatus();
      void pumpTransport();
    }
    if (message.type === "recorder-ack") void handleAck(message as RecorderAck);
    if (message.type === "recorder-error") {
      const error = message as RecorderError;
      failClosed(`${error.code}: ${error.message}`);
    }
  });
  candidate.addEventListener("close", (event) => {
    if (socket !== candidate) return;
    if (isTerminalRecorderPairingClose(event.code)) {
      terminalPairingFailure = true;
      failClosed(event.reason || "Recorder pairing was closed by the server");
    }
    socket = null;
    inFlightSequence = null;
    transportState = "offline";
    postStatus();
    scheduleReconnect();
  });
  candidate.addEventListener("error", () => candidate.close());
};

const persistBlock = async (block: Uint8Array, sequence: number) => {
  if (state === "failed") return;
  if (persistedBlockCount > 0 && persistedBlockCount % STORAGE_PROBE_INTERVAL_BLOCKS === 0) await checkStorageHeadroom();
  if (isCanonicalSoloJournal()) {
    await writeDirectoryFileDurably(recorderSequenceFileName(sequence), block);
  } else {
    const temporaryName = recorderSequenceTempFileName(sequence);
    await writeDirectoryFileDurably(temporaryName, block);
    const retainedTemporary = await moveJournalFile(temporaryName, recorderSequenceFileName(sequence), {
      fallbackBytes: block,
      retainTemporaryUntilRead: true,
    });
    if (retainedTemporary) pendingTemporarySequences.add(sequence);
  }
  persistedBlockCount += 1;
  pendingSequences.push(sequence);
  cacheFreshPeerBlock(sequence, block);
  postStatus();
  void pumpTransport();
};

const enqueueBlock = (recorderFrameIndex: number, sourceTimestampUs: number, flags: number, payload: Uint8Array) => {
  const sequence = nextSequence;
  nextSequence += 1;
  const input = { sessionId, episodeId, sequence, recorderFrameIndex, sourceTimestampUs, flags, payload };
  const block = kernels?.encodeRecord(input) ?? encodeRecorderBlock(input);
  lastBlockSourceTimestampUs = sourceTimestampUs;
  if ((flags & (RecorderBlockFlags.Gap | RecorderBlockFlags.SensorFrameJson)) !== 0) lastRecorderFrameIndex = recorderFrameIndex;
  writeTail = writeTail.then(() => persistBlock(block, sequence)).catch((error) => {
    failClosed(error instanceof Error ? error.message : "Recorder journal writing failed");
  });
};

const enqueueGap = (frameIndex: number, reason: string) => {
  if (!clock) return;
  explicitGaps += 1;
  enqueueBlock(frameIndex, clock.slotTimestampUs(frameIndex), RecorderBlockFlags.Gap, textEncoder.encode(reason));
};

const finalisePendingSample = () => {
  if (!pendingSample) return;
  enqueueBlock(
    pendingSample.recorderFrameIndex,
    pendingSample.sourceTimestampUs,
    pendingSample.flags,
    textEncoder.encode(JSON.stringify(pendingSample.frame)),
  );
  pendingSample = null;
};

const enqueueMediaBlock = (kind: "media" | "audio", mimeType: string, data: Uint8Array) => {
  if (!episodeId || state === "failed") return;
  finalisePendingSample();
  const sourceTimestampUs = lastBlockSourceTimestampUs || clock?.startTimestampUs || monotonicNowUs();
  enqueueBlock(
    lastRecorderFrameIndex,
    sourceTimestampUs,
    kind === "media" ? RecorderBlockFlags.MediaChunk : RecorderBlockFlags.AudioChunk,
    encodeRecorderMediaPayload(mimeType, data),
  );
};

const enqueueRunEvent = (event: RecorderRunEvent, sourceTimestampUs: number) => {
  if (!episodeId || state === "failed" || (state !== "recording" && state !== "paused")) return;
  if (state === "recording") drainSharedRing();
  finalisePendingSample();
  enqueueBlock(
    lastRecorderFrameIndex,
    Math.max(lastBlockSourceTimestampUs, sourceTimestampUs),
    RecorderBlockFlags.RunEvent,
    encodeRecorderRunEvent(event),
  );
};

const enqueueSample = (values: Float64Array) => {
  if (state !== "recording" || !clock) return;
  const sourceTimestampUs = values[0];
  const assignment = clock.assignSample(sourceTimestampUs);
  if (!assignment) return;
  finalisePendingSample();
  const firstGapFrame = assignment.frameIndex - assignment.gapCount;
  for (let gap = 0; gap < assignment.gapCount; gap += 1) enqueueGap(firstGapFrame + gap, "xr-callback-missed");
  if (values[1] !== 1) {
    enqueueGap(assignment.frameIndex, "viewer-pose-unavailable");
    return;
  }
  pendingSample = {
    frame: decodeTelemetryFrame(values, assignment.frameIndex, wallClockOffsetMs),
    sourceTimestampUs,
    recorderFrameIndex: assignment.frameIndex,
    flags: RecorderBlockFlags.SensorFrameJson,
  };
};

const drainSharedRing = () => {
  if (!sharedControl || !sharedValues || !sharedCapacity) return;
  let readIndex = Atomics.load(sharedControl, RING_READ_INDEX);
  const writeIndex = Atomics.load(sharedControl, RING_WRITE_INDEX);
  while (readIndex !== writeIndex) {
    const offset = readIndex * TELEMETRY_VALUE_COUNT;
    sharedScratch.set(sharedValues.subarray(offset, offset + TELEMETRY_VALUE_COUNT));
    enqueueSample(sharedScratch);
    readIndex = (readIndex + 1) % sharedCapacity;
    Atomics.store(sharedControl, RING_READ_INDEX, readIndex);
  }
};

const expireMissingSlots = () => {
  if (state !== "recording" || !clock) return;
  const firstFrame = clock.frameIndex;
  const count = clock.claimExpiredGaps(monotonicNowUs());
  if (count > 0) finalisePendingSample();
  for (let gap = 0; gap < count; gap += 1) enqueueGap(firstFrame + gap, "xr-callback-timeout");
};

const arm = async (message: any) => {
  captureRegistered = message.captureRegistered === true;
  journalReady = false;
  latchedPeerReady = null;
  const previousSocket = socket;
  socket = null;
  transportUrl = "";
  transportMode = message.transportMode === "peer" ? "peer" : "websocket";
  peerReady = false;
  previousSocket?.close(1000, "Recorder session changed");
  if (reconnectTimer !== null) workerScope.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  await writeTail;
  state = "arming";
  transportState = "offline";
  sessionId = message.sessionId;
  pairingId = message.pairingId;
  storageRootName = typeof message.storageRootName === "string"
    ? message.storageRootName
    : "ceres-recorder";
  rateHz = message.rateHz;
  transportUrl = message.transportUrl;
  wallClockOffsetMs = message.wallClockOffsetMs;
  episodeId = "";
  clock = null;
  pendingSample = null;
  explicitGaps = 0;
  durableAckSequence = -1;
  nextSequence = 0;
  finaliseStartAckSequence = null;
  finaliseTargetSequence = null;
  persistedBlockCount = 0;
  lastBlockSourceTimestampUs = 0;
  lastRecorderFrameIndex = 0;
  failureReason = null;
  terminalPairingFailure = false;
  inFlightSequence = null;
  peerDeliveringSequence = null;
  peerDeliveringByteLength = 0;
  peerDeliveredBlocks = [];
  peerDeliveredBytes = 0;
  peerCapacityBlocked = false;
  soloPeerDeliveryInProgress = false;
  soloPeerDeliveringBlocks = [];
  soloPeerDeliveryGeneration += 1;
  clearFreshPeerBlocks();
  pendingSequences = [];
  pendingTemporarySequences.clear();
  migratedLegacyNames.clear();
  directory = null;
  legacyStorageDirectory = null;
  legacyDirectory = null;
  if (message.sharedRing) {
    sharedControl = new Int32Array(message.sharedRing.control);
    sharedValues = new Float64Array(message.sharedRing.values);
    sharedCapacity = message.sharedRing.capacity;
  } else {
    sharedControl = null;
    sharedValues = null;
    sharedCapacity = 0;
  }
  if (typeof pairingId !== "string" || !SAFE_PAIRING_ID_PATTERN.test(pairingId)) {
    failClosed("Recorder pairing identity is invalid");
    return;
  }
  if (!CAPTURE_RECORDER_STORAGE_ROOTS.has(storageRootName)) {
    failClosed("Recorder storage namespace is invalid");
    return;
  }
  postStatus();
  try {
    kernels = await loadRecorderKernels();
    await openJournal();
    journalReady = true;
    if (transportMode === "peer") {
      const ready = latchedPeerReady;
      latchedPeerReady = null;
      if (ready) applyPeerReady(ready);
    } else {
      connectTransport();
    }
  } catch (error) {
    failClosed(error instanceof Error ? error.message : "The durable recorder journal could not be armed");
  }
};

const setCaptureRegistration = (registered: boolean) => {
  captureRegistered = registered;
  if (registered) {
    if (transportMode === "websocket") connectTransport();
    return;
  }
  if (reconnectTimer !== null) workerScope.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const previousSocket = socket;
  socket = null;
  inFlightSequence = null;
  transportState = "offline";
  previousSocket?.close(1000, "Capture registration lost");
  postStatus();
};

const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  closed = true;
  journalReady = false;
  latchedPeerReady = null;
  if (reconnectTimer !== null) workerScope.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    if (state === "recording") drainSharedRing();
    if (state === "recording" || state === "paused") finalisePendingSample();
    state = "idle";
    clock = null;
    await writeTail;
  } finally {
    socket?.close(1000, "Recorder closed");
    socket = null;
    workerScope.postMessage({ type: "closed" });
    workerScope.close();
  }
};

workerScope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "arm") {
    lifecycle.queueArm(() => arm(message));
    return;
  }
  if (message.type === "capture-registration") {
    setCaptureRegistration(message.registered === true);
    return;
  }
  if (message.type === "peer-control") {
    if (transportMode === "peer") handlePeerControl(message.message);
    return;
  }
  if (message.type === "peer-transport") {
    if (transportMode === "peer" && message.connected !== true) {
      peerReady = false;
      latchedPeerReady = null;
      peerDeliveringSequence = null;
      peerDeliveringByteLength = 0;
      peerDeliveredBlocks = [];
      peerDeliveredBytes = 0;
      peerCapacityBlocked = false;
      soloPeerDeliveryInProgress = false;
      soloPeerDeliveringBlocks = [];
      soloPeerDeliveryGeneration += 1;
      clearFreshPeerBlocks();
      transportState = "offline";
      postStatus();
    }
    return;
  }
  if (message.type === "peer-delivery") {
    if (transportMode === "peer") handlePeerDelivery(message);
    return;
  }
  if (message.type === "peer-deliveries") {
    if (transportMode === "peer" && isCanonicalSoloJournal()) handleSoloPeerDeliveries(message);
    return;
  }
  if (message.type === "sample" && message.buffer instanceof ArrayBuffer) {
    const values = new Float64Array(message.buffer);
    enqueueSample(values);
    workerScope.postMessage({ type: "recycle", buffer: message.buffer }, [message.buffer]);
    return;
  }
  if (message.type === "media" && message.buffer instanceof ArrayBuffer) {
    enqueueMediaBlock(message.kind, message.mimeType, new Uint8Array(message.buffer));
    return;
  }
  if (message.type === "run-event") {
    enqueueRunEvent(message.event, message.sourceTimestampUs);
    return;
  }
  if (message.type === "start") {
    if (state !== "armed") {
      failClosed("Recording was requested before the durable path was armed");
      return;
    }
    if (message.initialEvent?.type !== "segment-start") {
      failClosed("Recording was requested without an initial task segment boundary");
      return;
    }
    episodeId = message.episodeId;
    rateHz = message.rateHz;
    clock = new FixedRateRecorderClock(message.startTimestampUs, rateHz);
    pendingSample = null;
    lastRecorderFrameIndex = 0;
    lastBlockSourceTimestampUs = message.startTimestampUs;
    finaliseStartAckSequence = null;
    finaliseTargetSequence = null;
    let initialPayload: Uint8Array;
    try {
      initialPayload = encodeRecorderRunEvent(message.initialEvent);
    } catch (error) {
      failClosed(error instanceof Error ? error.message : "The initial task segment boundary is invalid");
      return;
    }
    const startedEpisodeId = episodeId;
    enqueueBlock(
      0,
      message.startTimestampUs,
      RecorderBlockFlags.RunEvent,
      initialPayload,
    );
    const initialWrite = writeTail;
    void initialWrite.then(() => {
      if (state === "failed" || episodeId !== startedEpisodeId) return;
      state = "recording";
      postStatus();
      workerScope.postMessage({ type: "episode-started", episodeId: startedEpisodeId });
    });
    return;
  }
  if (message.type === "cancel-start" && message.episodeId === episodeId
    && (state === "armed" || state === "recording")) {
    failClosed("Recorder initial durable write timed out");
    return;
  }
  if (message.type === "pause" && state === "recording" && clock) {
    drainSharedRing();
    finalisePendingSample();
    if (!clock.pause(message.pauseTimestampUs)) {
      failClosed("Recorder pause timestamp is invalid");
      return;
    }
    state = "paused";
    postStatus();
    return;
  }
  if (message.type === "resume" && state === "paused" && clock) {
    if (!clock.resume(message.resumeTimestampUs)) {
      failClosed("Recorder resume timestamp is invalid");
      return;
    }
    state = "recording";
    postStatus();
    return;
  }
  if (message.type === "stop" && (state === "recording" || state === "paused") && clock) {
    finaliseStartAckSequence ??= durableAckSequence;
    const wasRecording = state === "recording";
    drainSharedRing();
    finalisePendingSample();
    const firstFrame = clock.frameIndex;
    const count = wasRecording ? clock.claimThrough(message.stopTimestampUs) : 0;
    for (let gap = 0; gap < count; gap += 1) enqueueGap(firstFrame + gap, "recording-stopped-without-sample");
    clock = null;
    state = "armed";
    postStatus();
    return;
  }
  if (message.type === "finish") {
    finaliseStartAckSequence ??= durableAckSequence;
    finaliseTargetSequence ??= nextSequence - 1;
    postStatus();
    void finishEpisode();
    return;
  }
  if (message.type === "capture-overrun") return;
  if (message.type === "close") {
    closed = true;
    void lifecycle.queueClose(shutdown);
  }
};

workerScope.setInterval(() => {
  drainSharedRing();
  expireMissingSlots();
}, 4);
