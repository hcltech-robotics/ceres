import assert from "node:assert/strict";
import test from "node:test";
import { captureMetadataFromStatus } from "../shared/capture-metadata.js";
import { defaultCaptureStatus, type EpisodeSegment } from "../shared/protocol.js";
import {
  openBrowserExportStorage,
  readBrowserExportArtifact,
  readJsonFile,
} from "../src/lerobot-export/storage.js";

class MemoryFileHandle {
  private bytes = new Uint8Array();

  constructor(private readonly name: string) {}

  async createWritable() {
    return {
      write: async (value: Uint8Array | Blob) => {
        this.bytes = value instanceof Blob
          ? new Uint8Array(await value.arrayBuffer())
          : Uint8Array.from(value);
      },
      close: async () => undefined,
      abort: async () => undefined,
    };
  }

  async getFile() {
    return new File([this.bytes], this.name);
  }
}

class MemoryDirectoryHandle {
  readonly directories = new Map<string, MemoryDirectoryHandle>();
  readonly files = new Map<string, MemoryFileHandle>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("Missing directory", "NotFoundError");
    const directory = new MemoryDirectoryHandle();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("Missing file", "NotFoundError");
    const file = new MemoryFileHandle(name);
    this.files.set(name, file);
    return file;
  }
}

test("completes the OPFS export before a stale selected folder can fail", async () => {
  const root = new MemoryDirectoryHandle();
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  try {
    const storage = await openBrowserExportStorage("solo-session");
    const staleDirectory = {
      async getDirectoryHandle() {
        throw new DOMException("The backing state changed", "InvalidStateError");
      },
    } as unknown as FileSystemDirectoryHandle;
    const bundle = {
      artifactCount: () => 1,
      artifactPath: () => "data/episode.json",
      artifactBytes: () => new TextEncoder().encode('{"episode":1}'),
    };
    const captureMetadata = captureMetadataFromStatus(defaultCaptureStatus, null);
    const segments = [{
      id: "episode-one-segment-1",
      taskId: "task-one",
      taskLabel: "Place sample",
      taskDescription: "Place the sample in the marked container",
      repetition: 1,
      take: 1,
      startedAt: "2026-07-31T12:00:00.000Z",
      endedAt: "2026-07-31T12:00:02.000Z",
      startSourceTimestampUs: 1_000_000,
      endSourceTimestampUs: 3_000_000,
      frameCount: 1,
      gapCount: 0,
      recorderSlotCount: 1,
      outcome: "completed",
      accepted: true,
      annotations: [{
        id: "segment-annotation-1",
        action: "pass",
        actor: "director",
        timestampMs: 2_000,
        sourceTimestampUs: 3_000_000,
      }],
    }] satisfies EpisodeSegment[];

    await assert.rejects(
      storage.writeBundle(
        0,
        "episode-one",
        bundle as never,
        { captureMetadata, segments },
        staleDirectory,
        new AbortController().signal,
        () => undefined,
      ),
      /complete export remains safe in browser storage/,
    );

    assert.equal(
      await (await readBrowserExportArtifact(
        "solo-session",
        "shards/episode-000000/data/episode.json",
      )).text(),
      '{"episode":1}',
    );
    const receipt = await readJsonFile<{ episodeId: string; artifactCount: number }>(
      storage.opfsRoot,
      "shards/episode-000000/ceres/browser-export-receipt.json",
    );
    assert.equal(receipt?.episodeId, "episode-one");
    assert.equal(receipt?.artifactCount, 2);
    const metadata = await readJsonFile<{
      version: number;
      captureMetadata: typeof captureMetadata;
      segments: EpisodeSegment[];
    }>(
      storage.opfsRoot,
      "shards/episode-000000/ceres/episode-metadata.json",
    );
    assert.deepEqual(metadata, {
      schema: "ceres-episode-export-metadata",
      version: 3,
      episodeId: "episode-one",
      episodeIndex: 0,
      captureMetadata,
      segments,
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
});

test("marks legacy episode exports without recorded segments explicitly", async () => {
  const root = new MemoryDirectoryHandle();
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  try {
    const storage = await openBrowserExportStorage("legacy-session");
    const bundle = {
      artifactCount: () => 1,
      artifactPath: () => "data/episode.json",
      artifactBytes: () => new TextEncoder().encode('{"episode":1}'),
    };
    await storage.writeBundle(
      0,
      "legacy-episode",
      bundle as never,
      { segments: null },
      undefined,
      new AbortController().signal,
      () => undefined,
    );

    const metadata = await readJsonFile<Record<string, unknown>>(
      storage.opfsRoot,
      "shards/episode-000000/ceres/episode-metadata.json",
    );
    assert.deepEqual(metadata, {
      schema: "ceres-episode-export-metadata",
      version: 3,
      episodeId: "legacy-episode",
      episodeIndex: 0,
      captureMetadata: null,
      segments: null,
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
});
