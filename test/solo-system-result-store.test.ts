import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureSoloDirectoryReadWritePermission,
  SOLO_SYSTEM_FILE_RESULT_MAX_BYTES,
  SoloSystemResultStore,
  type SoloDirectoryHandle,
  type SoloSystemResult,
  type SoloSystemResultBackend,
} from "../src/solo-system-result-store.js";

class MemoryBackend implements SoloSystemResultBackend {
  readonly values = new Map<string, SoloSystemResult>();

  async get(transitionId: string) {
    return this.values.get(transitionId) ?? null;
  }

  async put(result: SoloSystemResult) {
    this.values.set(result.transitionId, result);
  }

  async delete(transitionId: string) {
    this.values.delete(transitionId);
  }
}

test("persists bounded file results under the exact transition identity until explicitly consumed", async () => {
  const backend = new MemoryBackend();
  const store = new SoloSystemResultStore(backend);

  await store.putFile("transition:file-001", "tasks.json", "{\"tasks\":[]}");
  assert.deepEqual(await store.get("transition:file-001"), {
    transitionId: "transition:file-001",
    kind: "file-import",
    fileName: "tasks.json",
    text: "{\"tasks\":[]}",
  });
  assert.equal(await store.get("transition:file-002"), null);

  await store.clear("transition:file-001");
  assert.equal(await store.get("transition:file-001"), null);
});

test("rejects an oversized file result before durable storage", async () => {
  const backend = new MemoryBackend();
  const store = new SoloSystemResultStore(backend);
  await assert.rejects(
    () => store.putFile(
      "transition:file-large",
      "tasks.json",
      "x".repeat(SOLO_SYSTEM_FILE_RESULT_MAX_BYTES + 1),
    ),
    /larger than 1 MB/,
  );
  assert.equal(backend.values.size, 0);
});

test("restores a directory handle and requests readwrite permission from the caller gesture", async () => {
  const backend = new MemoryBackend();
  const store = new SoloSystemResultStore(backend);
  const calls: string[] = [];
  const handle = {
    kind: "directory",
    name: "exports",
    queryPermission: async () => {
      calls.push("query");
      return "prompt" as PermissionState;
    },
    requestPermission: async () => {
      calls.push("request");
      return "granted" as PermissionState;
    },
  } as SoloDirectoryHandle;

  await store.putDirectory("transition:folder-001", handle);
  const restored = await store.get("transition:folder-001");
  assert.equal(restored?.kind, "folder-export");
  if (restored?.kind !== "folder-export") assert.fail("Folder result was not restored");
  await ensureSoloDirectoryReadWritePermission(restored.directoryHandle);
  assert.deepEqual(calls, ["query", "request"]);
  assert.equal(await store.get("transition:folder-001"), restored);
});

test("denied folder permission rejects without consuming the durable result", async () => {
  const backend = new MemoryBackend();
  const store = new SoloSystemResultStore(backend);
  const handle = {
    kind: "directory",
    name: "exports",
    queryPermission: async () => "prompt" as PermissionState,
    requestPermission: async () => "denied" as PermissionState,
  } as SoloDirectoryHandle;
  await store.putDirectory("transition:folder-denied", handle);

  await assert.rejects(
    () => ensureSoloDirectoryReadWritePermission(handle),
    /Read and write permission is required/,
  );
  assert.equal((await store.get("transition:folder-denied"))?.kind, "folder-export");
});
