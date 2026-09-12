import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createEpisodeExportRouter, EpisodeExportAccess } from "../server/episode-export.ts";
import { SessionStore } from "../server/session-store.ts";
import { CERES_EXPORT_CAPABILITY_HEADER, type EpisodeExportManifest } from "../shared/lerobot-export.ts";
import type { Episode } from "../shared/protocol.ts";
import {
  CERES_TASK_SPEC_SCHEMA,
  CERES_TASK_SPEC_VERSION,
  taskSpecificationSha256Hex,
  type CeresTaskSpecification,
} from "../shared/task-specification.ts";

test("serves authorised non-zero-frame episode manifests regardless of annotation outcome", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-export-routes-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "route-session";
  const specification: CeresTaskSpecification = {
    schema: CERES_TASK_SPEC_SCHEMA,
    version: CERES_TASK_SPEC_VERSION,
    runTitle: "Route run",
    cycleCount: 1,
    tasks: [{
      id: "task-pick",
      type: "open",
      label: "Pick",
      instructions: "Pick the sample",
      repeatCount: 1,
      resetTimeS: 5,
    }],
  };
  const firstEpisode = episode("episode-001", "Pick", "successful", 2, "2026-07-15T12:00:00.000Z");
  firstEpisode.taskSpecVersion = CERES_TASK_SPEC_VERSION;
  firstEpisode.taskSpecHash = await taskSpecificationSha256Hex(specification);
  firstEpisode.taskSpecification = specification;
  await writeEpisode(dataRoot, sessionId, firstEpisode, true);
  await writeEpisode(dataRoot, sessionId, episode("episode-002", "Discard", "failed", 2, "2026-07-15T12:01:00.000Z"));
  await writeEpisode(dataRoot, sessionId, episode("episode-003", "Empty", "successful", 0, "2026-07-15T12:02:00.000Z"));
  await writeEpisode(dataRoot, sessionId, episode("episode-004", "Place", "successful", 3, "2026-07-15T12:03:00.000Z"));
  await writeEpisode(dataRoot, sessionId, episode("episode-005", "Deleted", "successful", 1, "2026-07-15T12:04:00.000Z"));
  await writeFile(
    path.join(dataRoot, "sessions", sessionId, "episodes", "episode-005", "deleted.json"),
    JSON.stringify({ deletedAt: "2026-07-15T12:05:00.000Z" }),
  );

  const app = express();
  const capability = "test-export-capability";
  app.use(createEpisodeExportRouter(
    new EpisodeExportAccess({ dataRoot, recorderRateHz: () => 30 }),
    (candidateSessionId, candidateCapability) => candidateSessionId === sessionId && candidateCapability === capability,
  ));
  const server = createServer(app);
  await listen(server);
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const firstUrl = `${origin}/api/sessions/${sessionId}/episodes/episode-001/export-manifest`;
  const unauthorised = await fetch(firstUrl);
  assert.equal(unauthorised.status, 401);
  assert.match(unauthorised.headers.get("cache-control") ?? "", /no-store/);
  const firstResponse = await authorisedFetch(firstUrl, capability);
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get("cache-control") ?? "", /no-store/);
  const first = await firstResponse.json() as EpisodeExportManifest;
  assert.equal(first.episodeIndex, 0);
  assert.equal(first.globalFrameIndex, 0);
  assert.deepEqual(first.tasks, [{ index: 0, text: "Pick" }]);
  assert.equal(first.taskSpecVersion, CERES_TASK_SPEC_VERSION);
  assert.equal(first.taskSpecHash, firstEpisode.taskSpecHash);
  assert.deepEqual(first.taskSpecification, specification);
  assert.deepEqual(first.blobs.map((blob) => blob.id), ["sensors", "video"]);

  const later = await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-004/export-manifest`, capability)
    .then((response) => response.json()) as EpisodeExportManifest;
  assert.equal(later.episodeIndex, 2);
  assert.equal(later.globalFrameIndex, 4);
  assert.deepEqual(later.tasks, [{ index: 0, text: "Pick" }, { index: 1, text: "Discard" }, { index: 2, text: "Place" }]);
  assert.deepEqual(later.task, { index: 2, text: "Place" });
  assert.equal(later.taskSpecification, undefined);

  const sensors = await authorisedFetch(`${origin}${first.blobs.find((blob) => blob.id === "sensors")!.url}`, capability);
  assert.equal(sensors.status, 200);
  assert.match(sensors.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal((await sensors.text()).trim().split("\n").length, 2);
  const video = await authorisedFetch(`${origin}${first.blobs.find((blob) => blob.id === "video")!.url}`, capability);
  assert.deepEqual([...new Uint8Array(await video.arrayBuffer())], [1, 2, 3, 4]);

  assert.equal((await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-002/export-manifest`, capability)).status, 200);
  assert.equal((await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-003/export-manifest`, capability)).status, 409);
  assert.equal((await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-005/export-manifest`, capability)).status, 404);
  assert.equal((await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-002/export-blobs/sensors`, capability)).status, 200);
  assert.equal((await authorisedFetch(`${origin}/api/sessions/${sessionId}/episodes/episode-001/export-blobs/unknown`, capability)).status, 404);
  const writeAttempt = await fetch(`${origin}/api/sessions/${sessionId}/episodes/episode-001/export-manifest`, { method: "POST" });
  assert.equal(writeAttempt.status, 405);
  assert.equal(writeAttempt.headers.get("allow"), "GET, HEAD");
});

test("issues stable session-scoped export capabilities", () => {
  const sessions = new SessionStore({ dataRoot: path.join(tmpdir(), "ceres-export-capabilities") });
  const capability = sessions.exportCapability("session-one");
  assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sessions.exportCapability("session-one"), capability);
  assert.equal(sessions.authoriseEpisodeExport("session-one", capability), true);
  assert.equal(sessions.authoriseEpisodeExport("session-one", "x".repeat(capability.length)), false);
  assert.equal(sessions.authoriseEpisodeExport("session-two", capability), false);
  assert.equal(sessions.authoriseEpisodeExport("unknown-session", undefined), false);
});

function authorisedFetch(url: string, capability: string) {
  return fetch(url, { headers: { [CERES_EXPORT_CAPABILITY_HEADER]: capability } });
}

async function writeEpisode(dataRoot: string, sessionId: string, value: Episode, includeVideo = false) {
  const root = path.join(dataRoot, "sessions", sessionId, "episodes", value.id);
  await mkdir(path.join(root, "video"), { recursive: true });
  await writeFile(path.join(root, value.outcome === "failed" ? "attempt.json" : "episode.json"), JSON.stringify(value));
  const rows = Array.from({ length: value.frameCount }, (_, frameIndex) => JSON.stringify({
    timestampMs: 1_000 + frameIndex * 1000 / 30,
    frameIndex,
    head: null,
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  })).join("\n");
  await writeFile(path.join(root, "sensors.jsonl"), `${rows}${rows ? "\n" : ""}`);
  if (includeVideo) await writeFile(path.join(root, "video", "passthrough.webm"), Uint8Array.of(1, 2, 3, 4));
}

function episode(id: string, taskLabel: string, outcome: Episode["outcome"], frameCount: number, startedAt: string): Episode {
  return {
    id,
    taskId: `task-${taskLabel.toLowerCase()}`,
    taskLabel,
    taskDescription: taskLabel,
    startedAt,
    endedAt: startedAt,
    outcome,
    frameCount,
    mediaChunkCount: 0,
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
