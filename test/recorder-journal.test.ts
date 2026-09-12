import assert from "node:assert/strict";
import test from "node:test";
import { decodeRecorderBlock, encodeRecorderBlock } from "../shared/protocol.js";
import {
  decodeRecorderJournalCommit,
  emptyRecorderJournalCommit,
  encodeRecorderJournalCommit,
  planCommittedRecorderJournalRecovery,
  planRecorderJournalRecovery,
  recorderJournalCandidateFromDecodedBlock,
  recorderJournalCommitAfterBlock,
  recorderSequenceFileName,
  recorderSequenceTempFileName,
  validateRecorderJournalPromotion,
} from "../src/recorder/recorder-journal.js";

const sessionId = "journal-recovery-session";

test("plans recovery from decoded metadata without retaining recorder payloads", () => {
  const block = encodedBlock(10);
  const candidate = recorderJournalCandidateFromDecodedBlock(
    recorderSequenceFileName(10),
    decodeRecorderBlock(block),
  );

  assert.equal(candidate.data, undefined);
  assert.deepEqual(planRecorderJournalRecovery(sessionId, [candidate]), {
    pendingSequences: [10],
    nextSequence: 11,
    removeNames: [],
    promotions: [],
    recoveredTailSequence: null,
  });
});

test("rejects a leading gap after the peer durable sequence", () => {
  const candidate = recorderJournalCandidateFromDecodedBlock(
    recorderSequenceFileName(3),
    decodeRecorderBlock(encodedBlock(3)),
  );

  assert.throws(
    () => planRecorderJournalRecovery(sessionId, [candidate], 2),
    /missing block 2 before 3/,
  );
});

test("rejects promotion bytes that changed after journal recovery planning", () => {
  const expected = decodeRecorderBlock(encodedBlock(10));
  assert.equal(
    validateRecorderJournalPromotion(encodedBlock(10), expected).checksum,
    expected.checksum,
  );
  assert.throws(
    () => validateRecorderJournalPromotion(encodedBlock(10, sessionId, "changed"), expected),
    /no longer matches the validated candidate/,
  );
  assert.throws(
    () => validateRecorderJournalPromotion(encodedBlock(11), expected),
    /no longer matches the validated candidate/,
  );
  assert.throws(
    () => validateRecorderJournalPromotion(encodedBlock(10, "another-journal-session"), expected),
    /no longer matches the validated candidate/,
  );
});

test("removes only an invalid uncommitted temporary tail and reuses its sequence", () => {
  const valid = encodedBlock(10);
  const invalidTail = new Uint8Array();
  assert.deepEqual(planRecorderJournalRecovery(sessionId, [
    { name: recorderSequenceFileName(10), data: valid },
    { name: recorderSequenceTempFileName(11), data: invalidTail },
  ]), {
    pendingSequences: [10],
    nextSequence: 11,
    removeNames: [recorderSequenceTempFileName(11)],
    promotions: [],
    recoveredTailSequence: 11,
  });
});

test("rejects invalid journal data before the tail", () => {
  assert.throws(
    () => planRecorderJournalRecovery(sessionId, [
      { name: recorderSequenceFileName(10), data: new Uint8Array() },
      { name: recorderSequenceFileName(11), data: encodedBlock(11) },
    ]),
    /block 10 is corrupt before the tail/,
  );
});

test("fails closed on a corrupt acknowledged final tail", () => {
  assert.throws(
    () => planRecorderJournalRecovery(sessionId, [
      { name: recorderSequenceFileName(10), data: encodedBlock(10) },
      { name: recorderSequenceFileName(11), data: new Uint8Array() },
    ]),
    /block 11 is corrupt in an acknowledged final file/,
  );
});

test("discards a corrupt uncommitted final tail after the durable commit", () => {
  const first = encodedBlock(0);
  const storedCommit = recorderJournalCommitAfterBlock(
    emptyRecorderJournalCommit(sessionId),
    0,
    decodeRecorderBlock(first).checksum,
  );
  const tailName = recorderSequenceFileName(1);
  const recovery = planCommittedRecorderJournalRecovery(sessionId, [
    { name: recorderSequenceFileName(0), data: first },
    { name: tailName, data: new Uint8Array() },
  ], storedCommit);

  assert.deepEqual(recovery.pendingSequences, [0]);
  assert.equal(recovery.nextSequence, 1);
  assert.deepEqual(recovery.removeNames, [tailName]);
  assert.equal(recovery.commit.committedThrough, 0);
  assert.equal(recovery.commitNeedsWrite, false);
});

test("does not discard a corrupt final file inside the durable commit", () => {
  const first = encodedBlock(0);
  const second = encodedBlock(1);
  const storedCommit = recorderJournalCommitAfterBlock(
    recorderJournalCommitAfterBlock(
      emptyRecorderJournalCommit(sessionId),
      0,
      decodeRecorderBlock(first).checksum,
    ),
    1,
    decodeRecorderBlock(second).checksum,
  );

  assert.throws(
    () => planCommittedRecorderJournalRecovery(sessionId, [
      { name: recorderSequenceFileName(0), data: first },
      { name: recorderSequenceFileName(1), data: new Uint8Array() },
    ], storedCommit),
    /block 1 is corrupt in an acknowledged final file/,
  );
});

test("rejects a missing block inside the retained journal", () => {
  assert.throws(
    () => planRecorderJournalRecovery(sessionId, [
      { name: recorderSequenceFileName(10), data: encodedBlock(10) },
      { name: recorderSequenceFileName(12), data: encodedBlock(12) },
    ]),
    /missing block 11 between 10 and 12/,
  );
});

test("promotes a valid flushed temporary block and discards an invalid final entry", () => {
  const finalName = recorderSequenceFileName(12);
  const temporaryName = recorderSequenceTempFileName(12);
  assert.deepEqual(planRecorderJournalRecovery(sessionId, [
    { name: finalName, data: null, error: "backing file is missing" },
    { name: temporaryName, data: encodedBlock(12) },
  ]), {
    pendingSequences: [12],
    nextSequence: 13,
    removeNames: [finalName],
    promotions: [{ from: temporaryName, to: finalName }],
    recoveredTailSequence: null,
  });
});

test("fails closed when the highest durably committed block is missing", () => {
  const first = encodedBlock(0);
  const second = encodedBlock(1);
  const firstDecoded = decodeRecorderBlock(first);
  const secondDecoded = decodeRecorderBlock(second);
  const committed = recorderJournalCommitAfterBlock(
    recorderJournalCommitAfterBlock(emptyRecorderJournalCommit(sessionId), 0, firstDecoded.checksum),
    1,
    secondDecoded.checksum,
  );

  assert.throws(
    () => planCommittedRecorderJournalRecovery(sessionId, [
      { name: recorderSequenceFileName(0), data: first },
    ], committed),
    /missing committed block 1/,
  );
});

test("commits a flushed contiguous tail before reporting its recovered next sequence", () => {
  const first = encodedBlock(0);
  const second = encodedBlock(1);
  const storedCommit = recorderJournalCommitAfterBlock(
    emptyRecorderJournalCommit(sessionId),
    0,
    decodeRecorderBlock(first).checksum,
  );
  const recovery = planCommittedRecorderJournalRecovery(sessionId, [
    { name: recorderSequenceFileName(0), data: first },
    { name: recorderSequenceFileName(1), data: second },
  ], storedCommit);

  assert.equal(recovery.nextSequence, 2);
  assert.equal(recovery.commit.committedThrough, 1);
  assert.equal(recovery.commit.tailChecksum, decodeRecorderBlock(second).checksum);
  assert.equal(recovery.commitNeedsWrite, true);
});

test("round trips a bounded recorder journal commit record", () => {
  const block = encodedBlock(0);
  const commit = recorderJournalCommitAfterBlock(
    emptyRecorderJournalCommit(sessionId),
    0,
    decodeRecorderBlock(block).checksum,
  );
  assert.deepEqual(decodeRecorderJournalCommit(sessionId, encodeRecorderJournalCommit(commit)), commit);
  assert.throws(
    () => decodeRecorderJournalCommit("another-session", encodeRecorderJournalCommit(commit)),
    /identity is invalid/,
  );
});

function encodedBlock(
  sequence: number,
  selectedSessionId = sessionId,
  payload = "gap",
) {
  return encodeRecorderBlock({
    sessionId: selectedSessionId,
    episodeId: "episode-one",
    sequence,
    recorderFrameIndex: sequence,
    sourceTimestampUs: 1_000_000 + sequence,
    flags: 1,
    payload: new TextEncoder().encode(payload),
  });
}
