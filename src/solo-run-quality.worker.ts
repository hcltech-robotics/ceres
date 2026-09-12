import { RECORDER_JOURNAL_FILE_PATTERN } from "./recorder/recorder-journal.js";
import {
  SoloRunQualityAccumulator,
  readSoloRunQualityRecorderBlock,
} from "./solo-run-quality-analysis.js";
import {
  assertSoloRunQualityWorkerRequest,
  SOLO_RUN_QUALITY_READ_BATCH_SIZE,
  type SoloRunQualityEpisode,
  type SoloRunQualityWorkerMessage,
  type SoloRunQualityWorkerRequest,
  type SoloRunQualityWorkerResponse,
} from "./solo-run-quality.js";
import { processOrderedBatches } from "./solo-run-quality-batch.js";

const scope = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<SoloRunQualityWorkerMessage>) => void): void;
  postMessage(message: SoloRunQualityWorkerResponse): void;
};

interface RecorderEntry {
  sequence: number;
  handle: FileSystemFileHandle;
}

interface SequenceRange {
  first: number;
  last: number;
}

class AnalysisCancelledError extends Error {}

let activeRequestId: string | null = null;
const cancelledRequests = new Set<string>();

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledRequests.add(message.requestId);
    return;
  }
  if (activeRequestId) cancelledRequests.add(activeRequestId);
  activeRequestId = message.requestId;
  void runAnalysis(message);
});

async function runAnalysis(request: SoloRunQualityWorkerRequest) {
  try {
    assertSoloRunQualityWorkerRequest(request);
    const accumulator = new SoloRunQualityAccumulator(request);
    const directory = await recorderDirectory(request);
    throwIfCancelled(request.requestId);
    const entries = await enumerateRecorderEntries(directory, request.episodes, request.requestId);
    await processOrderedBatches({
      values: entries,
      batchSize: SOLO_RUN_QUALITY_READ_BATCH_SIZE,
      read: async (entry) => {
        const file = await entry.handle.getFile();
        throwIfCancelled(request.requestId);
        return await readSoloRunQualityRecorderBlock(file, entry.sequence);
      },
      consume: (data) => {
        if (data) accumulator.recordEncodedBlock(data);
      },
      checkpoint: () => throwIfCancelled(request.requestId),
      yieldBetweenBatches: yieldToWorkerMessages,
    });
    post({
      type: "complete",
      requestId: request.requestId,
      result: accumulator.finish(),
    });
  } catch (error) {
    if (error instanceof AnalysisCancelledError) {
      post({ type: "cancelled", requestId: request.requestId });
    } else {
      post({
        type: "error",
        requestId: request.requestId,
        error: error instanceof Error ? error.message : "Solo run quality analysis failed",
      });
    }
  } finally {
    cancelledRequests.delete(request.requestId);
    if (activeRequestId === request.requestId) activeRequestId = null;
  }
}

async function recorderDirectory(request: SoloRunQualityWorkerRequest) {
  const storage = navigator.storage as StorageManager & { getDirectory(): Promise<FileSystemDirectoryHandle> };
  const root = await storage.getDirectory();
  const ceres = await root.getDirectoryHandle(request.storageRoot);
  const session = await ceres.getDirectoryHandle(request.sessionId);
  return await session.getDirectoryHandle("recorder");
}

async function enumerateRecorderEntries(
  directory: FileSystemDirectoryHandle,
  episodes: readonly SoloRunQualityEpisode[],
  requestId: string,
) {
  const ranges = episodeSequenceRanges(episodes);
  const entries: RecorderEntry[] = [];
  for await (const [name, handle] of directory.entries()) {
    throwIfCancelled(requestId);
    const match = RECORDER_JOURNAL_FILE_PATTERN.exec(name);
    if (!match || handle.kind !== "file") continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || ranges && !inSequenceRanges(sequence, ranges)) continue;
    entries.push({ sequence, handle: handle as FileSystemFileHandle });
  }
  entries.sort((left, right) => left.sequence - right.sequence);
  return entries;
}

function episodeSequenceRanges(episodes: readonly SoloRunQualityEpisode[]): SequenceRange[] | null {
  if (episodes.some((episode) => episode.firstRecorderSequence === undefined
    || episode.lastRecorderSequence === undefined)) return null;
  const ranges = episodes.map((episode) => ({
    first: episode.firstRecorderSequence!,
    last: episode.lastRecorderSequence!,
  })).sort((left, right) => left.first - right.first);
  const merged: SequenceRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.first > previous.last + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.last = Math.max(previous.last, range.last);
  }
  return merged;
}

function inSequenceRanges(sequence: number, ranges: readonly SequenceRange[]) {
  for (const range of ranges) {
    if (sequence < range.first) return false;
    if (sequence <= range.last) return true;
  }
  return false;
}

function throwIfCancelled(requestId: string) {
  if (cancelledRequests.has(requestId) || activeRequestId !== requestId) {
    throw new AnalysisCancelledError("Solo run quality analysis was cancelled");
  }
}

function post(message: SoloRunQualityWorkerResponse) {
  scope.postMessage(message);
}

function yieldToWorkerMessages() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
