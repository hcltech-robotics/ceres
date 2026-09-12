import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION,
  normaliseSoloLocalExportDestination,
  requestSoloLocalExportPermission,
  soloLocalExportFolderIdentityMatches,
  soloLocalExportPermission,
  SoloLocalExportDestinationStore,
  type SoloLocalExportDestination,
  type SoloLocalExportDestinationBackend,
} from "../src/solo-local-export-destination.js";
import type { SoloDirectoryHandle } from "../src/solo-system-result-store.js";

class MemoryBackend implements SoloLocalExportDestinationBackend {
  value: unknown = undefined;
  readonly folderJobs = new Map<string, unknown>();

  async read() {
    return this.value;
  }

  async write(destination: SoloLocalExportDestination) {
    this.value = destination;
  }

  async readFolderJob(jobId: string) {
    return this.folderJobs.get(jobId);
  }

  async writeFolderJob(jobId: string, destination: SoloLocalExportDestination) {
    this.folderJobs.set(jobId, destination);
  }

  async deleteFolderJob(jobId: string) {
    this.folderJobs.delete(jobId);
  }
}

function folderHandle(
  permission: PermissionState = "granted",
  name = "CERES exports",
  identity = name,
): SoloDirectoryHandle {
  return {
    kind: "directory",
    name,
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    isSameEntry: async (other) => (
      (other as SoloDirectoryHandle & { identity?: string }).identity === identity
    ),
    identity,
  } as SoloDirectoryHandle;
}

test("defaults to private browser storage and persists a selected folder handle", async () => {
  const backend = new MemoryBackend();
  const store = new SoloLocalExportDestinationStore(backend);

  assert.deepEqual(await store.load(), DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
  const selected = await store.useFolder(folderHandle());
  assert.equal(selected.type, "folder");
  assert.equal(selected.type === "folder" ? selected.name : "", "CERES exports");
  assert.equal((await store.load()).type, "folder");

  assert.deepEqual(await store.useBrowserStorage(), DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
  assert.deepEqual(await store.load(), DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
});

test("fails closed to browser storage for malformed persisted values", () => {
  assert.deepEqual(normaliseSoloLocalExportDestination(null), DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
  assert.deepEqual(normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "lost",
    directoryHandle: { kind: "file" },
  }), DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
});

test("queries and renews folder permission only through the stored handle", async () => {
  let permission: PermissionState = "prompt";
  let requests = 0;
  const directoryHandle = {
    ...folderHandle("prompt"),
    queryPermission: async () => permission,
    requestPermission: async () => {
      requests += 1;
      permission = "granted";
      return permission;
    },
  } as SoloDirectoryHandle;
  const destination = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: directoryHandle.name,
    directoryHandle,
  });

  assert.equal(await soloLocalExportPermission(destination), "prompt");
  assert.equal(await requestSoloLocalExportPermission(destination), "granted");
  assert.equal(requests, 1);
  assert.equal(await soloLocalExportPermission(destination), "granted");
});

test("keeps each folder job bound to its original private directory handle", async () => {
  const backend = new MemoryBackend();
  const store = new SoloLocalExportDestinationStore(backend);
  const folderA = await store.useFolder(folderHandle("granted", "Folder A", "folder-a"));
  assert.equal(folderA.type, "folder");
  if (folderA.type !== "folder") throw new Error("Folder A was not selected");
  await store.bindFolderJob("folder-job-a", folderA);

  const folderB = await store.useFolder(folderHandle("granted", "Folder B", "folder-b"));
  const restored = await store.loadFolderJob("folder-job-a");
  assert.equal(restored?.name, "Folder A");
  assert.equal(await soloLocalExportFolderIdentityMatches(restored!, folderB), false);

  await store.clearFolderJob("folder-job-a");
  assert.equal(await store.loadFolderJob("folder-job-a"), null);
});

test("accepts a reloaded handle only when the browser confirms the same entry", async () => {
  const expected = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "Folder A",
    directoryHandle: folderHandle("granted", "Folder A", "folder-a"),
  });
  const reloaded = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "Folder A",
    directoryHandle: folderHandle("granted", "Folder A", "folder-a"),
  });
  assert.equal(expected.type, "folder");
  if (expected.type !== "folder") throw new Error("Expected folder destination");
  assert.equal(await soloLocalExportFolderIdentityMatches(expected, reloaded), true);
});

test("fails folder identity closed when comparison is unavailable or throws", async () => {
  const withoutComparison = (name: string) => ({
    kind: "directory",
    name,
    queryPermission: async () => "granted" as PermissionState,
  }) as SoloDirectoryHandle;
  const expected = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "Folder A",
    directoryHandle: withoutComparison("Folder A"),
  });
  const current = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "Folder A",
    directoryHandle: withoutComparison("Folder A"),
  });
  assert.equal(expected.type, "folder");
  if (expected.type !== "folder") throw new Error("Expected folder destination");
  assert.equal(await soloLocalExportFolderIdentityMatches(expected, current), false);

  const throwing = normaliseSoloLocalExportDestination({
    version: 1,
    type: "folder",
    name: "Folder A",
    directoryHandle: {
      ...withoutComparison("Folder A"),
      isSameEntry: async () => {
        throw new DOMException("Comparison failed", "NotAllowedError");
      },
    },
  });
  assert.equal(throwing.type, "folder");
  if (throwing.type !== "folder") throw new Error("Expected folder destination");
  assert.equal(await soloLocalExportFolderIdentityMatches(throwing, current), false);
});

test("checks permission on the job-bound folder before recovery", async () => {
  const backend = new MemoryBackend();
  const store = new SoloLocalExportDestinationStore(backend);
  const destination = await store.useFolder(folderHandle("prompt", "Folder A", "folder-a"));
  assert.equal(destination.type, "folder");
  if (destination.type !== "folder") throw new Error("Folder A was not selected");
  await store.bindFolderJob("folder-job-a", destination);

  const restored = await store.loadFolderJob("folder-job-a");
  assert.equal(await soloLocalExportPermission(restored!), "prompt");
});
