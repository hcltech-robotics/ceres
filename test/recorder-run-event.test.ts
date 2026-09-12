import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRecorderMediaPayload,
  decodeRecorderRunEvent,
  encodeRecorderMediaPayload,
  encodeRecorderRunEvent,
} from "../shared/protocol.js";

test("recorder run events round trip segment boundaries and annotations", () => {
  const start = {
    type: "segment-start",
    segmentId: "segment-0001",
    taskId: "task-a",
    taskLabel: "Pick sample",
  } as const;
  const annotation = {
    type: "annotation",
    segmentId: "segment-0001",
    annotationId: "annotation-0001",
    action: "pass",
    actor: "demonstrator",
  } as const;

  assert.deepEqual(decodeRecorderRunEvent(encodeRecorderRunEvent(start)), start);
  assert.deepEqual(decodeRecorderRunEvent(encodeRecorderRunEvent(annotation)), annotation);
});

test("recorder run events reject malformed segment identities", () => {
  assert.throws(
    () => decodeRecorderRunEvent(new TextEncoder().encode(JSON.stringify({
      type: "segment-start",
      segmentId: "bad",
      taskId: "task-a",
      taskLabel: "Pick sample",
    }))),
    /segment identity/i,
  );
});

test("recorder media payloads preserve MIME type and bytes", () => {
  const payload = encodeRecorderMediaPayload("video/webm", Uint8Array.of(1, 2, 3));
  const decoded = decodeRecorderMediaPayload(payload);
  assert.equal(decoded.mimeType, "video/webm");
  assert.deepEqual([...decoded.data], [1, 2, 3]);
});
