import { RecorderBlockFlags, decodeRecorderBlock, decodeRecorderRunEvent } from "../../shared/protocol.js";
import { decodeRecorderJournalCommit, encodeRecorderJournalCommit, planCommittedRecorderJournalRecovery, RECORDER_JOURNAL_FILE_PATTERN, RECORDER_JOURNAL_TEMP_FILE_PATTERN, recorderJournalCandidateFromDecodedBlock, recorderJournalCommitAfterBlock, recorderJournalCommitFileName, recorderSequenceFileName, validateRecorderJournalPromotion, type RecorderJournalCommit, type RecorderJournalCandidate } from "./recorder-journal.js";
import { MonitorRecordingSummaryAccumulator, type MonitorRecordingSummary } from "./monitor-recording-summary.js";
import {
  encodeMonitorSnapshotCatalogue,
  monitorSnapshotFileName,
  monitorSnapshotTemporaryFileName,
  planMonitorSnapshotRecovery,
  type MonitorSnapshotCandidate,
  type MonitorSnapshotCandidateName,
} from "./monitor-snapshot-recovery.js";
import { SerialOperationQueue } from "./serial-operation-queue.js";
import { writeOpfsFileDurably } from "./durable-opfs-write.js";
import type { SessionSnapshot } from "../../shared/protocol.js";

type MonitorRecorderMessage =
  | {
    type: "open";
    sessionId: string;
    storageRootName: "ceres-monitor-recordings" | "ceres-solo-recordings";
  }
  | { type: "block"; block: ArrayBuffer }
  | { type: "blocks"; blocks: ArrayBuffer[] }
  | { type: "save-snapshot"; snapshotRequestId: number; snapshot: SessionSnapshot }
  | { type: "summarise"; episodeId: string }
  | { type: "close" };

const scope = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<MonitorRecorderMessage>) => void): void;
  postMessage(message: unknown): void;
  close(): void;
};

let sessionId = "";
let directory: FileSystemDirectoryHandle | null = null;
let sessionDirectory: FileSystemDirectoryHandle | null = null;
let snapshotGeneration = 0;
let journalCommit: RecorderJournalCommit | null = null;
let recorderFailed = false;
let recorderStorageRootName: "ceres-monitor-recordings" | "ceres-solo-recordings" | null = null;
const summaries = new Map<string, MonitorRecordingSummaryAccumulator>();
const MAX_RECORDER_BATCH_SIZE = 64;
const SOLO_PARALLEL_COMPARE_MAX_BLOCK_BYTES = 1024 * 1024;
const SOLO_PARALLEL_COMPARE_CONCURRENCY = 8;

interface RecoverySummaryCandidate {
  sessionId: string;
  episodeId: string;
  sequence: number;
  checksum: number;
  sourceTimestampUs: number;
  flags: number;
  runEvent: ReturnType<typeof decodeRecorderRunEvent> | null;
}

interface RecorderSummaryBlock {
  episodeId: string;
  sequence: number;
  sourceTimestampUs: number;
  flags: number;
}

type MovableFileHandle = FileSystemFileHandle & {
  move?: (name: string) => Promise<void>;
};

const postError = (message: string, sequence?: number, snapshotRequestId?: number) => scope.postMessage({
  type: "error",
  message,
  sequence,
  snapshotRequestId,
});
const operations = new SerialOperationQueue((error, fallback) => {
  recorderFailed = true;
  postError(error instanceof Error ? error.message : fallback);
});

const durabilityProbeFileName = ".durability-probe";
const durabilityProbeBytes = new Uint8Array([0x43, 0x45, 0x52, 0x45, 0x53, 0x01, 0xa5, 0x5a]);

const writeDirectoryFileDurably = async (target: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) => {
  const file = await target.getFileHandle(name, { create: true });
  await writeOpfsFileDurably(file, bytes);
};

const promoteTemporaryFile = async (
  target: FileSystemDirectoryHandle,
  temporaryName: string,
  finalName: string,
  options: {
    fallbackBytes?: Uint8Array;
    validateFallback?: (bytes: Uint8Array) => void;
  } = {},
) => {
  const temporary = await target.getFileHandle(temporaryName) as MovableFileHandle;
  let validatedBytes: Uint8Array | undefined;
  if (options.validateFallback) {
    validatedBytes = new Uint8Array(await (await temporary.getFile()).arrayBuffer());
    options.validateFallback(validatedBytes);
  }
  if (typeof temporary.move === "function") {
    try {
      await temporary.move(finalName);
      return;
    } catch {
      // Writable-stream implementations and older browsers retain the copy fallback.
    }
  }
  const bytes = options.fallbackBytes
    ?? validatedBytes
    ?? new Uint8Array(await (await temporary.getFile()).arrayBuffer());
  await writeDirectoryFileDurably(target, finalName, bytes);
  await target.removeEntry(temporaryName).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
};

const probeDurableStorage = async (target: FileSystemDirectoryHandle) => {
  try {
    await writeDirectoryFileDurably(target, durabilityProbeFileName, durabilityProbeBytes);
  } catch (error) {
    await target.removeEntry(durabilityProbeFileName).catch(() => undefined);
    throw error;
  }
  await target.removeEntry(durabilityProbeFileName);
};

const open = async (
  nextSessionId: string,
  storageRootName: "ceres-monitor-recordings" | "ceres-solo-recordings",
) => {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nextSessionId)) throw new Error("Monitor recorder session identifier is invalid");
  if (storageRootName !== "ceres-monitor-recordings" && storageRootName !== "ceres-solo-recordings") {
    throw new Error("Monitor recorder storage root is invalid");
  }
  const storage = navigator.storage as StorageManager & { getDirectory(): Promise<FileSystemDirectoryHandle> };
  const root = await storage.getDirectory();
  const ceres = await root.getDirectoryHandle(storageRootName, { create: true });
  const session = await ceres.getDirectoryHandle(nextSessionId, { create: true });
  sessionDirectory = session;
  directory = await session.getDirectoryHandle("recorder", { create: true });
  recorderStorageRootName = storageRootName;
  sessionId = nextSessionId;
  snapshotGeneration = 0;
  journalCommit = null;
  recorderFailed = false;
  summaries.clear();
  await probeDurableStorage(directory);
  const candidates: RecorderJournalCandidate[] = [];
  const summaryCandidates = new Map<string, RecoverySummaryCandidate>();
  const summaryCandidateErrors = new Map<string, string>();
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file"
      || (!RECORDER_JOURNAL_FILE_PATTERN.test(name) && !RECORDER_JOURNAL_TEMP_FILE_PATTERN.test(name))) continue;
    try {
      const data = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
      const block = decodeRecorderBlock(data);
      candidates.push(recorderJournalCandidateFromDecodedBlock(name, block));
      try {
        summaryCandidates.set(name, {
          sessionId: block.sessionId,
          episodeId: block.episodeId,
          sequence: block.sequence,
          checksum: block.checksum,
          sourceTimestampUs: block.sourceTimestampUs,
          flags: block.flags,
          runEvent: (block.flags & RecorderBlockFlags.RunEvent) !== 0
            ? decodeRecorderRunEvent(block.payload)
            : null,
        });
      } catch (error) {
        summaryCandidateErrors.set(
          name,
          error instanceof Error ? error.message : "journal summary data could not be read",
        );
      }
    } catch (error) {
      candidates.push({
        name,
        error: error instanceof Error ? error.message : "journal data could not be read",
      });
    }
  }
  const storedCommit = await readJournalCommit(directory, sessionId);
  const recovery = planCommittedRecorderJournalRecovery(sessionId, candidates, storedCommit);
  for (const name of recovery.removeNames) await directory.removeEntry(name).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  for (const promotion of recovery.promotions) {
    const candidate = summaryCandidates.get(promotion.from);
    if (!candidate) throw new Error("Monitor recorder journal promotion candidate is invalid");
    await promoteTemporaryFile(directory, promotion.from, promotion.to, {
      validateFallback: (bytes) => {
        validateRecorderJournalPromotion(bytes, candidate);
      },
    });
  }
  if (recovery.commitNeedsWrite) await writeJournalCommit(directory, recovery.commit);
  journalCommit = recovery.commit;
  rebuildCommittedSummaries(
    recovery.pendingSequences,
    recovery.promotions,
    summaryCandidates,
    summaryCandidateErrors,
  );
  const snapshotRecovery = await recoverSnapshot();
  snapshotGeneration = snapshotRecovery.generation;
  if (snapshotRecovery.snapshot) scope.postMessage({ type: "snapshot", sessionId, snapshot: snapshotRecovery.snapshot });
  scope.postMessage({ type: "ready", sessionId, nextSequence: recovery.nextSequence });
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

const recordCommittedBlock = (
  block: RecorderSummaryBlock,
  runEvent: ReturnType<typeof decodeRecorderRunEvent> | null,
) => {
  let accumulator = summaries.get(block.episodeId);
  if (!accumulator) {
    accumulator = new MonitorRecordingSummaryAccumulator();
    summaries.set(block.episodeId, accumulator);
  }
  accumulator.recordSequence(block.sequence);
  if ((block.flags & RecorderBlockFlags.SensorFrameJson) !== 0) {
    accumulator.recordSensorFrame();
  } else if ((block.flags & RecorderBlockFlags.Gap) !== 0) {
    accumulator.recordGap();
  } else if ((block.flags & RecorderBlockFlags.MediaChunk) !== 0) {
    accumulator.recordMediaChunk();
  } else if ((block.flags & RecorderBlockFlags.RunEvent) !== 0 && runEvent) {
    accumulator.recordRunEvent(block.sequence, block.sourceTimestampUs, runEvent);
  }
};

const rebuildCommittedSummaries = (
  pendingSequences: readonly number[],
  promotions: readonly { from: string; to: string }[],
  candidates: ReadonlyMap<string, RecoverySummaryCandidate>,
  candidateErrors: ReadonlyMap<string, string>,
) => {
  summaries.clear();
  const promotedSources = new Map(promotions.map(({ from, to }) => [to, from]));
  for (const sequence of pendingSequences) {
    const finalName = recorderSequenceFileName(sequence);
    const sourceName = promotedSources.get(finalName) ?? finalName;
    const candidateError = candidateErrors.get(sourceName);
    if (candidateError) {
      throw new Error(`Monitor recorder journal block ${sequence} is invalid: ${candidateError}`);
    }
    const candidate = candidates.get(sourceName);
    if (!candidate || candidate.sessionId !== sessionId || candidate.sequence !== sequence) {
      throw new Error(`Monitor recorder journal block ${sequence} is invalid`);
    }
    recordCommittedBlock(candidate, candidate.runEvent);
  }
};

interface PreparedRecorderBlock {
  block: Uint8Array;
  decoded: ReturnType<typeof decodeRecorderBlock>;
  runEvent: ReturnType<typeof decodeRecorderRunEvent> | null;
  sequence: number;
  needsWrite: boolean;
  status: "stored" | "duplicate";
}

const readExistingRecorderBlock = async (name: string) => {
  if (!directory) throw new Error("Monitor recorder is not open");
  try {
    return new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
};

const persistBatch = async (values: ArrayBuffer[]) => {
  if (!directory || !sessionId || !journalCommit) throw new Error("Monitor recorder is not open");
  if (recorderFailed) throw new Error("Monitor recorder has failed closed");
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_RECORDER_BATCH_SIZE) {
    throw new Error("Monitor recorder block batch size is invalid");
  }
  const decodedBlocks = values.map((value) => {
    if (!(value instanceof ArrayBuffer)) throw new Error("Monitor recorder block batch is invalid");
    const block = new Uint8Array(value);
    const decoded = decodeRecorderBlock(block);
    if (decoded.sessionId !== sessionId) throw new Error("Recorder block session does not match the monitor journal");
    return {
      block,
      decoded,
      runEvent: (decoded.flags & RecorderBlockFlags.RunEvent) !== 0
        ? decodeRecorderRunEvent(decoded.payload)
        : null,
      sequence: decoded.sequence,
    };
  });
  for (let index = 1; index < decodedBlocks.length; index += 1) {
    if (decodedBlocks[index]!.sequence <= decodedBlocks[index - 1]!.sequence) {
      throw new Error("Monitor recorder block batch is not strictly ordered");
    }
  }

  const previousCommit = journalCommit;
  const previouslyCommittedThrough = previousCommit.committedThrough;
  const soloExistingBlocks = new Map<number, Uint8Array | null>();
  if (recorderStorageRootName === "ceres-solo-recordings") {
    const smallBlocks = decodedBlocks.filter(({ block }) => (
      block.byteLength <= SOLO_PARALLEL_COMPARE_MAX_BLOCK_BYTES
    ));
    for (let offset = 0; offset < smallBlocks.length; offset += SOLO_PARALLEL_COMPARE_CONCURRENCY) {
      await Promise.all(
        smallBlocks.slice(offset, offset + SOLO_PARALLEL_COMPARE_CONCURRENCY).map(async ({ sequence }) => {
          soloExistingBlocks.set(
            sequence,
            await readExistingRecorderBlock(recorderSequenceFileName(sequence)),
          );
        }),
      );
    }
    for (const { block, sequence } of decodedBlocks) {
      if (block.byteLength <= SOLO_PARALLEL_COMPARE_MAX_BLOCK_BYTES) continue;
      soloExistingBlocks.set(
        sequence,
        await readExistingRecorderBlock(recorderSequenceFileName(sequence)),
      );
    }
  }

  let nextCommit = previousCommit;
  const prepared: PreparedRecorderBlock[] = [];
  for (const decodedBlock of decodedBlocks) {
    const { block, decoded, runEvent, sequence } = decodedBlock;
    if (previouslyCommittedThrough !== null && sequence <= previouslyCommittedThrough) {
      const existing = recorderStorageRootName === "ceres-solo-recordings"
        ? soloExistingBlocks.get(sequence) ?? null
        : await readExistingRecorderBlock(recorderSequenceFileName(sequence));
      if (!existing) throw new Error(`Recorder journal is missing committed block ${sequence}`);
      if (!sameBytes(existing, block)) {
        throw new Error("Recorder block conflicts with the durable monitor journal");
      }
      prepared.push({
        block,
        decoded,
        runEvent,
        sequence,
        needsWrite: false,
        status: "duplicate",
      });
      continue;
    }
    const expectedSequence = nextCommit.committedThrough === null ? 0 : nextCommit.committedThrough + 1;
    if (sequence !== expectedSequence) {
      throw new Error(`Recorder journal received block ${sequence}; expected ${expectedSequence}`);
    }
    let needsWrite = true;
    if (recorderStorageRootName === "ceres-solo-recordings") {
      const existing = soloExistingBlocks.get(sequence);
      if (existing !== undefined) {
        if (!existing) {
          throw new Error(`Solo recorder journal is missing capture block ${sequence}`);
        }
        if (!sameBytes(existing, block)) {
          throw new Error("Recorder block conflicts with the durable Solo capture journal");
        }
      }
      needsWrite = false;
    }
    nextCommit = recorderJournalCommitAfterBlock(nextCommit, sequence, decoded.checksum);
    prepared.push({
      block,
      decoded,
      runEvent,
      sequence,
      needsWrite,
      status: "stored",
    });
  }

  for (const entry of prepared) {
    if (!entry.needsWrite) continue;
    await writeDirectoryFileDurably(
      directory,
      recorderSequenceFileName(entry.sequence),
      entry.block,
    );
  }
  if (nextCommit !== previousCommit) await writeJournalCommit(directory, nextCommit);
  journalCommit = nextCommit;
  for (const entry of prepared) {
    if (entry.status === "stored") recordCommittedBlock(entry.decoded, entry.runEvent);
  }
  for (const entry of prepared) {
    scope.postMessage({
      type: "ack",
      sessionId,
      sequence: entry.sequence,
      status: entry.status,
    });
  }
};

const persist = (value: ArrayBuffer) => persistBatch([value]);

const saveSnapshot = async (snapshot: SessionSnapshot, snapshotRequestId: number) => {
  if (!sessionDirectory || !sessionId) throw new Error("Monitor recorder is not open");
  if (recorderFailed) throw new Error("Monitor recorder has failed closed");
  if (!Number.isSafeInteger(snapshotRequestId) || snapshotRequestId < 1) throw new Error("Monitor snapshot request identifier is invalid");
  if (snapshot.sessionId !== sessionId) throw new Error("Monitor snapshot session does not match the recorder journal");
  const generation = snapshotGeneration + 1;
  const data = encodeMonitorSnapshotCatalogue(snapshot, generation);
  await writeDirectoryFileDurably(sessionDirectory, monitorSnapshotTemporaryFileName, data);
  await writeDirectoryFileDurably(sessionDirectory, monitorSnapshotFileName, data);
  snapshotGeneration = generation;
  await sessionDirectory.removeEntry(monitorSnapshotTemporaryFileName).catch(() => undefined);
  scope.postMessage({
    type: "snapshot-saved",
    sessionId,
    snapshotRequestId,
    snapshotGeneration: generation,
  });
};

const readJournalCommit = async (target: FileSystemDirectoryHandle, expectedSessionId: string) => {
  try {
    const file = await (await target.getFileHandle(recorderJournalCommitFileName)).getFile();
    return decodeRecorderJournalCommit(expectedSessionId, new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
};

const writeJournalCommit = async (target: FileSystemDirectoryHandle, commit: RecorderJournalCommit) => {
  await writeDirectoryFileDurably(target, recorderJournalCommitFileName, encodeRecorderJournalCommit(commit));
};

const recoverSnapshot = async () => {
  if (!sessionDirectory || !sessionId) return {
    snapshot: null,
    selectedData: null,
    generation: 0,
    promoteTemporary: false,
    removeTemporary: false,
  };
  const candidates: MonitorSnapshotCandidate[] = [];
  for (const name of [monitorSnapshotFileName, monitorSnapshotTemporaryFileName] as const) {
    const candidate = await readSnapshotCandidate(sessionDirectory, name);
    if (candidate) candidates.push(candidate);
  }
  const recovery = planMonitorSnapshotRecovery(sessionId, candidates);
  if (recovery.promoteTemporary) {
    if (!recovery.selectedData) throw new Error("Monitor recorder temporary catalogue has no recoverable data");
    await writeDirectoryFileDurably(sessionDirectory, monitorSnapshotFileName, recovery.selectedData);
  }
  if (recovery.removeTemporary) await sessionDirectory.removeEntry(monitorSnapshotTemporaryFileName).catch((error) => {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  });
  return recovery;
};

const readSnapshotCandidate = async (
  target: FileSystemDirectoryHandle,
  name: MonitorSnapshotCandidateName,
): Promise<MonitorSnapshotCandidate | null> => {
  try {
    const file = await (await target.getFileHandle(name)).getFile();
    return {
      name,
      data: new Uint8Array(await file.arrayBuffer()),
      lastModified: file.lastModified,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    return {
      name,
      data: null,
      lastModified: null,
      error: error instanceof Error ? error.message : "file could not be read",
    };
  }
};

const summarise = async (episodeId: string) => {
  if (!directory || !sessionId) throw new Error("Monitor recorder is not open");
  if (recorderFailed) throw new Error("Monitor recorder has failed closed");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(episodeId)) throw new Error("Monitor recorder episode identifier is invalid");
  const summary = structuredClone(
    summaries.get(episodeId)?.summary
      ?? new MonitorRecordingSummaryAccumulator().summary,
  );
  scope.postMessage({ type: "summary", sessionId, episodeId, summary } satisfies { type: string; sessionId: string; episodeId: string; summary: MonitorRecordingSummary });
};

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "open") {
    operations.enqueue(
      () => open(message.sessionId, message.storageRootName),
      "Monitor recorder could not open",
    );
    return;
  }
  if (message.type === "block") {
    operations.enqueue(() => persist(message.block), "Monitor recorder could not persist a block");
    return;
  }
  if (message.type === "blocks") {
    operations.enqueue(() => persistBatch(message.blocks), "Monitor recorder could not persist a block batch");
    return;
  }
  if (message.type === "save-snapshot") {
    operations.enqueue(async () => {
      try {
        await saveSnapshot(message.snapshot, message.snapshotRequestId);
      } catch (error) {
        postError(
          error instanceof Error ? error.message : "Monitor recorder could not persist the session catalogue",
          undefined,
          message.snapshotRequestId,
        );
      }
    }, "Monitor recorder could not persist the session catalogue");
    return;
  }
  if (message.type === "summarise") {
    operations.enqueue(() => summarise(message.episodeId), "Monitor recorder could not summarise the episode");
    return;
  }
  operations.finish(() => {
    const closedSessionId = sessionId;
    directory = null;
    sessionDirectory = null;
    sessionId = "";
    snapshotGeneration = 0;
    journalCommit = null;
    recorderStorageRootName = null;
    summaries.clear();
    scope.postMessage({ type: "closed", sessionId: closedSessionId });
    scope.close();
  }, "Monitor recorder could not close");
});
