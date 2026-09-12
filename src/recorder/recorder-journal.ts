import { decodeRecorderBlock } from "../../shared/protocol.js";

export const RECORDER_JOURNAL_FILE_PATTERN = /^(\d{20})\.crb$/;
export const RECORDER_JOURNAL_TEMP_FILE_PATTERN = /^(\d{20})\.crb\.tmp$/;
export const recorderJournalCommitFileName = "commit.json";

export interface RecorderJournalCommit {
  version: 1;
  sessionId: string;
  firstSequence: number | null;
  committedThrough: number | null;
  tailChecksum: number | null;
}

export interface RecorderJournalCandidate {
  name: string;
  data?: Uint8Array | null;
  metadata?: RecorderJournalCandidateMetadata;
  error?: string;
}

export interface RecorderJournalCandidateMetadata {
  sessionId: string;
  sequence: number;
  checksum: number;
}

export interface RecorderJournalRecoveryPlan {
  pendingSequences: number[];
  nextSequence: number;
  removeNames: string[];
  promotions: Array<{ from: string; to: string }>;
  recoveredTailSequence: number | null;
}

export interface CommittedRecorderJournalRecoveryPlan extends RecorderJournalRecoveryPlan {
  commit: RecorderJournalCommit;
  commitNeedsWrite: boolean;
}

export function recorderSequenceFileName(sequence: number) {
  return `${String(sequence).padStart(20, "0")}.crb`;
}

export function recorderSequenceTempFileName(sequence: number) {
  return `${recorderSequenceFileName(sequence)}.tmp`;
}

export function recorderJournalCandidateFromDecodedBlock(
  name: string,
  block: RecorderJournalCandidateMetadata,
): RecorderJournalCandidate {
  return {
    name,
    metadata: {
      sessionId: block.sessionId,
      sequence: block.sequence,
      checksum: block.checksum,
    },
  };
}

export function validateRecorderJournalPromotion(
  data: Uint8Array,
  expected: RecorderJournalCandidateMetadata,
) {
  const block = decodeRecorderBlock(data);
  if (block.sessionId !== expected.sessionId
    || block.sequence !== expected.sequence
    || block.checksum !== expected.checksum) {
    throw new Error("Recorder journal promotion no longer matches the validated candidate");
  }
  return block;
}

export function emptyRecorderJournalCommit(sessionId: string): RecorderJournalCommit {
  return {
    version: 1,
    sessionId,
    firstSequence: null,
    committedThrough: null,
    tailChecksum: null,
  };
}

export function recorderJournalCommitAfterBlock(
  current: RecorderJournalCommit,
  sequence: number,
  checksum: number,
): RecorderJournalCommit {
  const nextSequence = current.committedThrough === null ? 0 : current.committedThrough + 1;
  if (sequence !== nextSequence) {
    throw new Error(`Recorder journal cannot commit block ${sequence}; expected ${nextSequence}`);
  }
  if (!Number.isSafeInteger(checksum) || checksum < 0 || checksum > 0xffff_ffff) {
    throw new Error("Recorder journal block checksum is invalid");
  }
  return {
    version: 1,
    sessionId: current.sessionId,
    firstSequence: current.firstSequence ?? sequence,
    committedThrough: sequence,
    tailChecksum: checksum,
  };
}

export function encodeRecorderJournalCommit(commit: RecorderJournalCommit) {
  validateRecorderJournalCommit(commit.sessionId, commit);
  return new TextEncoder().encode(JSON.stringify(commit));
}

export function decodeRecorderJournalCommit(sessionId: string, data: Uint8Array): RecorderJournalCommit {
  if (data.byteLength === 0 || data.byteLength > 4_096) throw new Error("Recorder journal commit record size is invalid");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Error("Recorder journal commit record is invalid");
  }
  validateRecorderJournalCommit(sessionId, value);
  return value;
}

export function planCommittedRecorderJournalRecovery(
  sessionId: string,
  candidates: RecorderJournalCandidate[],
  storedCommit: RecorderJournalCommit | null,
): CommittedRecorderJournalRecoveryPlan {
  if (storedCommit) validateRecorderJournalCommit(sessionId, storedCommit);
  const firstUncommittedSequence = (storedCommit?.committedThrough ?? -1) + 1;
  const journal = planRecorderJournalRecovery(
    sessionId,
    candidates,
    undefined,
    firstUncommittedSequence,
  );
  if (storedCommit?.committedThrough !== null && storedCommit?.committedThrough !== undefined) {
    const firstSequence = storedCommit.firstSequence!;
    const committedCount = storedCommit.committedThrough - firstSequence + 1;
    for (let index = 0; index < Math.min(committedCount, journal.pendingSequences.length); index += 1) {
      const expectedSequence = firstSequence + index;
      if (journal.pendingSequences[index] !== expectedSequence) {
        throw new Error(`Recorder journal is missing committed block ${expectedSequence}`);
      }
    }
    if (journal.pendingSequences.length < committedCount) {
      throw new Error(`Recorder journal is missing committed block ${firstSequence + journal.pendingSequences.length}`);
    }
    const committedTail = decodedCandidate(sessionId, storedCommit.committedThrough, candidates);
    if (!committedTail || committedTail.checksum !== storedCommit.tailChecksum) {
      throw new Error(`Recorder journal committed block ${storedCommit.committedThrough} does not match its commit record`);
    }
  }

  const firstSequence = journal.pendingSequences.at(0) ?? null;
  const committedThrough = journal.pendingSequences.at(-1) ?? null;
  const tail = committedThrough === null ? null : decodedCandidate(sessionId, committedThrough, candidates);
  if (committedThrough !== null && !tail) {
    throw new Error(`Recorder journal block ${committedThrough} cannot be committed during recovery`);
  }
  if (storedCommit?.firstSequence !== null && storedCommit?.firstSequence !== undefined
    && firstSequence !== storedCommit.firstSequence) {
    throw new Error(`Recorder journal is missing committed block ${storedCommit.firstSequence}`);
  }
  const commit: RecorderJournalCommit = {
    version: 1,
    sessionId,
    firstSequence,
    committedThrough,
    tailChecksum: tail?.checksum ?? null,
  };
  return {
    ...journal,
    commit,
    commitNeedsWrite: !storedCommit || !sameCommit(storedCommit, commit),
  };
}

export function planRecorderJournalRecovery(
  sessionId: string,
  candidates: RecorderJournalCandidate[],
  expectedFirstSequence?: number,
  discardInvalidFinalTailFromSequence?: number,
): RecorderJournalRecoveryPlan {
  if (expectedFirstSequence !== undefined
    && (!Number.isSafeInteger(expectedFirstSequence) || expectedFirstSequence < 0)) {
    throw new Error("Recorder journal expected first sequence is invalid");
  }
  if (discardInvalidFinalTailFromSequence !== undefined
    && (!Number.isSafeInteger(discardInvalidFinalTailFromSequence)
      || discardInvalidFinalTailFromSequence < 0)) {
    throw new Error("Recorder journal invalid final tail boundary is invalid");
  }
  const entries = new Map<number, { final?: RecorderJournalCandidate; temporary?: RecorderJournalCandidate }>();
  for (const candidate of candidates) {
    const finalMatch = RECORDER_JOURNAL_FILE_PATTERN.exec(candidate.name);
    const temporaryMatch = RECORDER_JOURNAL_TEMP_FILE_PATTERN.exec(candidate.name);
    const match = finalMatch ?? temporaryMatch;
    if (!match) continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence)) throw new Error(`Recorder journal filename ${candidate.name} has an invalid sequence`);
    const entry = entries.get(sequence) ?? {};
    if (finalMatch) entry.final = candidate;
    else entry.temporary = candidate;
    entries.set(sequence, entry);
  }

  const sequences = [...entries.keys()].sort((left, right) => left - right);
  if (expectedFirstSequence !== undefined
    && sequences.length > 0
    && sequences[0] !== expectedFirstSequence) {
    throw new Error(`Recorder journal is missing block ${expectedFirstSequence} before ${sequences[0]}`);
  }
  for (let index = 1; index < sequences.length; index += 1) {
    const previous = sequences[index - 1]!;
    const current = sequences[index]!;
    if (current !== previous + 1) {
      throw new Error(`Recorder journal is missing block ${previous + 1} between ${previous} and ${current}`);
    }
  }
  const tailSequence = sequences.at(-1) ?? null;
  const pendingSequences: number[] = [];
  const removeNames: string[] = [];
  const promotions: Array<{ from: string; to: string }> = [];
  let recoveredTailSequence: number | null = null;

  for (const sequence of sequences) {
    const entry = entries.get(sequence)!;
    const finalError = entry.final ? journalCandidateError(sessionId, sequence, entry.final) : null;
    const temporaryError = entry.temporary ? journalCandidateError(sessionId, sequence, entry.temporary) : null;
    if (entry.final && !finalError) {
      pendingSequences.push(sequence);
      if (entry.temporary) removeNames.push(entry.temporary.name);
      continue;
    }
    if (entry.temporary && !temporaryError) {
      if (entry.final) removeNames.push(entry.final.name);
      promotions.push({ from: entry.temporary.name, to: recorderSequenceFileName(sequence) });
      pendingSequences.push(sequence);
      continue;
    }
    const nextRecoverableSequence = (pendingSequences.at(-1)
      ?? (discardInvalidFinalTailFromSequence ?? 0) - 1) + 1;
    if (sequence === tailSequence
      && entry.final
      && discardInvalidFinalTailFromSequence !== undefined
      && sequence >= discardInvalidFinalTailFromSequence
      && sequence === nextRecoverableSequence) {
      removeNames.push(entry.final.name);
      if (entry.temporary) removeNames.push(entry.temporary.name);
      recoveredTailSequence = sequence;
      continue;
    }
    if (sequence !== tailSequence || entry.final) {
      const reason = finalError ?? temporaryError ?? "journal data is unavailable";
      const position = sequence === tailSequence ? "in an acknowledged final file" : "before the tail";
      throw new Error(`Recorder journal block ${sequence} is corrupt ${position}: ${reason}`);
    }
    if (entry.temporary) removeNames.push(entry.temporary.name);
    recoveredTailSequence = sequence;
  }

  return {
    pendingSequences,
    nextSequence: recoveredTailSequence ?? (pendingSequences.at(-1) ?? -1) + 1,
    removeNames,
    promotions,
    recoveredTailSequence,
  };
}

function journalCandidateError(sessionId: string, sequence: number, candidate: RecorderJournalCandidate) {
  try {
    const block = recorderJournalCandidateMetadata(candidate);
    if (!block) return candidate.error || "journal data could not be read";
    if (block.sessionId !== sessionId || block.sequence !== sequence) return "journal identity does not match its filename";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "journal block is invalid";
  }
}

function decodedCandidate(sessionId: string, sequence: number, candidates: RecorderJournalCandidate[]) {
  for (const name of [recorderSequenceFileName(sequence), recorderSequenceTempFileName(sequence)]) {
    const candidate = candidates.find((entry) => entry.name === name);
    if (!candidate) continue;
    try {
      const block = recorderJournalCandidateMetadata(candidate);
      if (block?.sessionId === sessionId && block.sequence === sequence) return block;
    } catch {
      // The recovery planner reports invalid candidates with the relevant journal position.
    }
  }
  return null;
}

function recorderJournalCandidateMetadata(candidate: RecorderJournalCandidate) {
  if (candidate.metadata) return candidate.metadata;
  if (candidate.data) {
    const block = decodeRecorderBlock(candidate.data);
    return {
      sessionId: block.sessionId,
      sequence: block.sequence,
      checksum: block.checksum,
    };
  }
  return null;
}

function validateRecorderJournalCommit(sessionId: string, value: unknown): asserts value is RecorderJournalCommit {
  if (!value || typeof value !== "object") throw new Error("Recorder journal commit record is invalid");
  const commit = value as Partial<RecorderJournalCommit>;
  if (commit.version !== 1 || commit.sessionId !== sessionId) throw new Error("Recorder journal commit record identity is invalid");
  const empty = commit.firstSequence === null && commit.committedThrough === null && commit.tailChecksum === null;
  const populated = Number.isSafeInteger(commit.firstSequence)
    && (commit.firstSequence as number) >= 0
    && Number.isSafeInteger(commit.committedThrough)
    && (commit.committedThrough as number) >= (commit.firstSequence as number)
    && Number.isSafeInteger((commit.committedThrough as number) - (commit.firstSequence as number) + 1)
    && Number.isSafeInteger(commit.tailChecksum)
    && (commit.tailChecksum as number) >= 0
    && (commit.tailChecksum as number) <= 0xffff_ffff;
  if (!empty && !populated) throw new Error("Recorder journal commit record range is invalid");
}

function sameCommit(left: RecorderJournalCommit, right: RecorderJournalCommit) {
  return left.version === right.version
    && left.sessionId === right.sessionId
    && left.firstSequence === right.firstSequence
    && left.committedThrough === right.committedThrough
    && left.tailChecksum === right.tailChecksum;
}
