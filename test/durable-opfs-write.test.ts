import assert from "node:assert/strict";
import test from "node:test";

import { writeOpfsFileDurably } from "../src/recorder/durable-opfs-write.js";

function bytesFromView(view: ArrayBufferView) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

class MemorySyncAccessHandle {
  bytes = new Uint8Array();
  closeCalls = 0;
  flushCalls = 0;
  readCalls = 0;
  writeCalls = 0;

  constructor(
    private readonly maximumWriteBytes = Number.POSITIVE_INFINITY,
    private readonly maximumReadBytes = Number.POSITIVE_INFINITY,
    private readonly corruptReadBack = false,
  ) {}

  close() {
    this.closeCalls += 1;
  }

  flush() {
    this.flushCalls += 1;
  }

  getSize() {
    return this.bytes.byteLength;
  }

  read(buffer: ArrayBufferView, options: { at?: number } = {}) {
    this.readCalls += 1;
    const target = bytesFromView(buffer);
    const at = options.at ?? 0;
    const count = Math.min(target.byteLength, this.maximumReadBytes, Math.max(0, this.bytes.byteLength - at));
    target.set(this.bytes.subarray(at, at + count));
    if (this.corruptReadBack && at === 0 && count > 0) target[0] ^= 0xff;
    return count;
  }

  truncate(size: number) {
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, size));
    this.bytes = next;
  }

  write(buffer: ArrayBufferView, options: { at?: number } = {}) {
    this.writeCalls += 1;
    const source = bytesFromView(buffer);
    const at = options.at ?? 0;
    const count = Math.min(source.byteLength, this.maximumWriteBytes);
    const required = at + count;
    if (this.bytes.byteLength < required) {
      const expanded = new Uint8Array(required);
      expanded.set(this.bytes);
      this.bytes = expanded;
    }
    this.bytes.set(source.subarray(0, count), at);
    return count;
  }
}

function fileHandle(value: object) {
  return value as FileSystemFileHandle;
}

function readableFile(bytes: Uint8Array) {
  return {
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as File;
}

test("prefers a synchronous access handle and completes partial writes and reads", async () => {
  const sync = new MemorySyncAccessHandle(2, 3);
  let writableCalls = 0;
  const handle = fileHandle({
    createSyncAccessHandle: async () => sync,
    createWritable: async () => {
      writableCalls += 1;
      throw new Error("writable fallback must not be used");
    },
    getFile: async () => readableFile(sync.bytes),
  });
  const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  const writer = await writeOpfsFileDurably(handle, expected);

  assert.equal(writer, "sync-access-handle");
  assert.deepEqual(sync.bytes, expected);
  assert.ok(sync.writeCalls > 1);
  assert.ok(sync.readCalls > 1);
  assert.equal(sync.flushCalls, 1);
  assert.equal(sync.closeCalls, 1);
  assert.equal(writableCalls, 0);
});

test("falls back to a writable stream and verifies the committed file", async () => {
  let stored = new Uint8Array();
  let pending = new Uint8Array();
  let closeCalls = 0;
  let abortCalls = 0;
  const handle = fileHandle({
    createWritable: async () => ({
      abort: async () => { abortCalls += 1; },
      close: async () => {
        closeCalls += 1;
        stored = Uint8Array.from(pending);
      },
      write: async (value: Uint8Array) => { pending = Uint8Array.from(value); },
    }),
    getFile: async () => readableFile(stored),
  });
  const expected = new Uint8Array([0x43, 0x45, 0x52, 0x45, 0x53]);

  const writer = await writeOpfsFileDurably(handle, expected);

  assert.equal(writer, "writable-stream");
  assert.deepEqual(stored, expected);
  assert.equal(closeCalls, 1);
  assert.equal(abortCalls, 0);
});

test("fails closed when a synchronous write cannot make progress", async () => {
  const sync = new MemorySyncAccessHandle(0, 2);
  const handle = fileHandle({
    createSyncAccessHandle: async () => sync,
    getFile: async () => readableFile(sync.bytes),
  });

  await assert.rejects(
    writeOpfsFileDurably(handle, new Uint8Array([1, 2, 3])),
    /write did not make valid progress/i,
  );
  assert.equal(sync.flushCalls, 0);
  assert.equal(sync.closeCalls, 1);
});

test("fails closed when no durable writer capability is exposed", async () => {
  const handle = fileHandle({ getFile: async () => readableFile(new Uint8Array()) });

  await assert.rejects(
    writeOpfsFileDurably(handle, new Uint8Array([1])),
    /durable OPFS writing is unavailable/i,
  );
});

test("rejects a mismatched synchronous read-back after flushing", async () => {
  const sync = new MemorySyncAccessHandle(4, 4, true);
  const handle = fileHandle({
    createSyncAccessHandle: async () => sync,
    getFile: async () => readableFile(sync.bytes),
  });

  await assert.rejects(
    writeOpfsFileDurably(handle, new Uint8Array([1, 2, 3, 4])),
    /read-back did not match/i,
  );
  assert.equal(sync.flushCalls, 1);
  assert.equal(sync.closeCalls, 1);
});
