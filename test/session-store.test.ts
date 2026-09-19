
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canSetHandDisplay, handDisplayAuthorityError } from "../server/session-authority.js";
import { RecorderStoreError, SessionStore, type SessionConnection } from "../server/session-store.js";
import { CAMERA_REGISTRATION_SCHEMA } from "../shared/camera-registration.js";
import { canonicalTaskSpecification } from "../shared/task-specification.js";
import { isExportableEpisode } from "../shared/lerobot-export.js";
import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  decodeRecorderBlock,
  defaultCaptureStatus,
  defaultConfiguration,
  encodeRecorderBlock,
  encodeRecorderMediaPayload,
  encodeRecorderRunEvent,
  nextRunControlCursor,
  RecorderBlockFlags,
  RecorderProtocolError,
  recorderBlockByteLength,
  type CaptureStatus,
  type Episode,
  type RecorderBlockInput,
  type RunProgress,
  type SensorFrame,
} from "../shared/protocol.js";

test("allows monitor and capture clients to change shared hand display settings", () => {
  assert.equal(canSetHandDisplay("monitor"), true);
  assert.equal(canSetHandDisplay("monitor-control"), true);
  assert.equal(canSetHandDisplay("capture"), true);
  assert.equal(canSetHandDisplay("recorder"), false);
  assert.equal(handDisplayAuthorityError, "Only the capture director or demonstrator can change hand display settings");
});

test("keeps demonstrator telemetry privacy authoritative across snapshots and reconnects", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0, syncLockMs: 0 });
  const sessionId = "capture-telemetry-privacy";
  const snapshots: Array<{
    telemetryMode?: unknown;
    telemetryModeAuthoritative?: unknown;
  }> = [];
  const monitor: SessionConnection = {
    id: "privacy-monitor",
    role: "monitor-control",
    send: (type, payload) => {
      if (type === "snapshot") snapshots.push((payload as { snapshot: {
        telemetryMode?: unknown;
        telemetryModeAuthoritative?: unknown;
      } }).snapshot);
    },
  };
  const firstCapture: SessionConnection = {
    id: "privacy-capture-one",
    role: "capture",
    pairingId: "privacy-pairing",
    telemetryMode: "disabled",
    send: () => undefined,
  };
  store.connect(sessionId, monitor);
  assert.equal(store.snapshot(sessionId).telemetryMode, "standard");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, false);
  const beforeCapture = snapshots.length;
  store.connect(sessionId, firstCapture);
  assert.equal(store.snapshot(sessionId).telemetryMode, "standard");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, false);
  store.requestCaptureIntent(sessionId, firstCapture);

  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);
  assert.deepEqual(snapshots.slice(beforeCapture).map((snapshot) => ({
    telemetryMode: snapshot.telemetryMode,
    telemetryModeAuthoritative: snapshot.telemetryModeAuthoritative,
  })), [
    { telemetryMode: "standard", telemetryModeAuthoritative: false },
    { telemetryMode: "disabled", telemetryModeAuthoritative: true },
  ]);
  assert.equal(snapshots.at(-1)?.telemetryMode, "disabled");
  assert.throws(
    () => store.setTelemetryMode(sessionId, monitor, "standard"),
    /selected capture client/,
  );

  await store.disconnect(sessionId, firstCapture);
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, false);
  const reconnectedCapture: SessionConnection = {
    id: "privacy-capture-two",
    role: "capture",
    pairingId: "privacy-pairing",
    telemetryMode: "disabled",
    send: () => undefined,
  };
  store.connect(sessionId, reconnectedCapture);
  store.requestCaptureIntent(sessionId, reconnectedCapture);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);

  store.setTelemetryMode(sessionId, reconnectedCapture, "unexpected");
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);
  store.setTelemetryMode(sessionId, reconnectedCapture, "standard");
  assert.equal(store.snapshot(sessionId).telemetryMode, "standard");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);
});

test("keeps duplicate capture privacy subordinate and restores it only on promotion", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0, syncLockMs: 0 });
  const sessionId = "capture-telemetry-duplicate";
  const selected: SessionConnection = {
    id: "privacy-selected",
    role: "capture",
    pairingId: "privacy-duplicate-pairing",
    telemetryMode: "disabled",
    connectedAtMs: 1,
    send: () => undefined,
  };
  const duplicate: SessionConnection = {
    id: "privacy-duplicate",
    role: "capture",
    pairingId: "privacy-duplicate-pairing",
    telemetryMode: "standard",
    connectedAtMs: 2,
    send: () => undefined,
  };

  assert.equal(store.connect(sessionId, selected).accepted, true);
  assert.equal(store.requestCaptureIntent(sessionId, selected).accepted, true);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);

  const duplicateRegistration = store.connect(sessionId, duplicate);
  assert.equal(duplicateRegistration.accepted, true);
  assert.equal(duplicateRegistration.accepted && duplicateRegistration.captureIntentGranted, false);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);

  await store.disconnect(sessionId, duplicate);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);

  const replacement: SessionConnection = {
    id: "privacy-replacement",
    role: "capture",
    pairingId: "privacy-duplicate-pairing",
    telemetryMode: "standard",
    connectedAtMs: 3,
    send: () => undefined,
  };
  assert.equal(store.connect(sessionId, replacement).accepted, true);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");

  await store.disconnect(sessionId, selected);
  assert.equal(store.snapshot(sessionId).telemetryMode, "standard");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, true);

  await store.disconnect(sessionId, replacement);
  assert.equal(store.snapshot(sessionId).telemetryMode, "disabled");
  assert.equal(store.snapshot(sessionId).telemetryModeAuthoritative, false);
});

test("supplies recorder finalisation defaults for a legacy capture status", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0, syncLockMs: 0 });
  const sessionId = "legacy-capture-status";
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: "legacy-capture",
    role: "capture",
    pairingId: "legacy-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  assert.equal(store.connect(sessionId, capture).accepted, true);
  assert.equal(store.requestCaptureIntent(sessionId, capture).accepted, true);
  const configuration = messages.find((message) => message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(
    sessionId,
    capture,
    configuration.revision,
    configuration.checksum,
  );
  assert.equal(store.activateCaptureAuthority(sessionId, capture).accepted, true);

  const legacyStatus = structuredClone(defaultCaptureStatus) as unknown as Record<string, unknown>;
  delete legacyStatus.recorderQueuedBlocks;
  delete legacyStatus.recorderFinaliseStartAckSequence;
  delete legacyStatus.recorderFinaliseTargetSequence;
  await store.setCaptureStatus(sessionId, capture, legacyStatus as unknown as CaptureStatus);

  const status = store.snapshot(sessionId).captureStatus;
  assert.equal(status.recorderQueuedBlocks, 0);
  assert.equal(status.recorderFinaliseStartAckSequence, null);
  assert.equal(status.recorderFinaliseTargetSequence, null);
});

test("keeps director controls and authoritative snapshots off the monitor data plane", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0, syncLockMs: 0 });
  const sessionId = "director-control-session";
  const messages: Array<{ recipient: string; type: string; payload: any }> = [];
  const monitor: SessionConnection = {
    id: "monitor",
    role: "monitor",
    send: (type, payload) => messages.push({ recipient: "monitor", type, payload }),
  };
  const control: SessionConnection = {
    id: "control",
    role: "monitor-control",
    send: (type, payload) => messages.push({ recipient: "control", type, payload }),
  };
  const capture: SessionConnection = {
    id: "capture",
    role: "capture",
    pairingId: "director-control-pairing",
    send: (type, payload) => messages.push({ recipient: "capture", type, payload }),
  };

  store.connect(sessionId, monitor);
  store.connect(sessionId, control);
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const configuration = messages.find((message) => message.recipient === "capture" && message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(sessionId, capture, configuration.revision, configuration.checksum);
  store.activateCaptureAuthority(sessionId, capture);
  await store.armRecorder(sessionId);
  assert.equal(store.snapshot(sessionId).monitorCount, 1);
  messages.length = 0;

  const frame: SensorFrame = {
    timestampMs: 1_000,
    frameIndex: 1,
    head: null,
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  };
  await store.recordFrame(sessionId, capture, frame);
  store.publishAsrStatus(sessionId, "ready");
  store.setHandDisplay(sessionId, {
    handMode: "mesh",
    handShading: "motion",
    handTrail: "cog",
  }, control);
  await store.control(sessionId, "start-sequence", control);
  await store.control(sessionId, "start-sequence", capture);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.snapshot(sessionId).run.status, "running");
  const controlMessages = messages.filter((message) => message.recipient === "control");
  assert.ok(controlMessages.length >= 1);
  assert.equal(controlMessages.every((message) => message.type === "snapshot"), true);
  assert.deepEqual(
    new Set(messages.filter((message) => message.recipient === "monitor").map((message) => message.type)),
    new Set(["sensor-frame", "asr-status", "hand-display", "control", "snapshot"]),
  );
});

test("uses an isolated default recorder rate for hosted browser sessions", () => {
  const store = new SessionStore({ minimumFreeBytes: 0, defaultRecorderRateHz: 1 });
  assert.equal(store.snapshot("hosted-browser-rate").configuration.recorderRateHz, 1);
  assert.equal(defaultConfiguration.recorderRateHz, 30);
  assert.throws(
    () => new SessionStore({ minimumFreeBytes: 0, defaultRecorderRateHz: 0 }),
    /default recorder rate must be a positive finite number/i,
  );
});

test("publishes ASR health to every session client", () => {
  const store = new SessionStore({ minimumFreeBytes: 0 });
  const received: string[] = [];
  store.connect("asr-session", { id: "monitor", role: "monitor", send: (type) => received.push(`monitor:${type}`) });
  const capture: SessionConnection = { id: "capture", role: "capture", pairingId: "asr-pairing", send: (type) => received.push(`capture:${type}`) };
  store.connect("asr-session", capture);
  store.requestCaptureIntent("asr-session", capture);
  received.length = 0;
  store.publishAsrStatus("asr-session", "ready");
  assert.deepEqual(received, ["monitor:asr-status", "capture:asr-status"]);
});

test("broadcasts live hand display settings without changing the run configuration", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0 });
  const sessionId = "hand-display-session";
  const messages: Array<{ recipient: string; type: string; payload: any }> = [];
  store.connect(sessionId, {
    id: "monitor",
    role: "monitor",
    send: (type, payload) => messages.push({ recipient: "monitor", type, payload }),
  });
  const capture: SessionConnection = {
    id: "capture",
    role: "capture",
    pairingId: "hand-display-pairing",
    send: (type, payload) => messages.push({ recipient: "capture", type, payload }),
  };
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const configuration = messages.find((message) => message.recipient === "capture" && message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(sessionId, capture, configuration.revision, configuration.checksum);
  store.activateCaptureAuthority(sessionId, capture);
  await store.armRecorder(sessionId);
  await store.control(sessionId, "start-sequence");
  const before = store.snapshot(sessionId);
  messages.length = 0;

  store.setHandDisplay(sessionId, {
    handMode: "mesh",
    handShading: "motion",
    handTrail: "cog",
  });

  const after = store.snapshot(sessionId);
  assert.deepEqual(after.handDisplay, {
    handMode: "mesh",
    handShading: "motion",
    handTrail: "cog",
  });
  assert.deepEqual(after.configurationStatus, before.configurationStatus);
  assert.deepEqual(after.run, before.run);
  assert.deepEqual(messages.filter((message) => message.type === "hand-display"), [
    { recipient: "monitor", type: "hand-display", payload: { settings: after.handDisplay } },
    { recipient: "capture", type: "hand-display", payload: { settings: after.handDisplay } },
  ]);

  const lateMessages: Array<{ type: string; payload: any }> = [];
  store.connect(sessionId, {
    id: "late-monitor",
    role: "monitor",
    send: (type, payload) => lateMessages.push({ type, payload }),
  });
  assert.deepEqual(lateMessages.find((message) => message.type === "snapshot")?.payload.snapshot.handDisplay, after.handDisplay);
});

test("validates and publishes outward-camera registration from the capture director", () => {
  const store = new SessionStore({ minimumFreeBytes: 0 });
  const sessionId = "camera-registration-session";
  const messages: Array<{ recipient: string; type: string; payload: any }> = [];
  const control: SessionConnection = {
    id: "control",
    role: "monitor-control",
    send: (type, payload) => messages.push({ recipient: "control", type, payload }),
  };
  const capture: SessionConnection = {
    id: "capture",
    role: "capture",
    pairingId: "camera-registration-pairing",
    send: (type, payload) => messages.push({ recipient: "capture", type, payload }),
  };
  const recorder: SessionConnection = { id: "recorder", role: "recorder", send: () => undefined };
  store.connect(sessionId, control);
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const registration = {
    schema: CAMERA_REGISTRATION_SCHEMA,
    cameraDeviceId: "quest-camera-device-0",
    cameraLabel: "camera2 0",
    side: "right",
    width: 1280,
    height: 960,
    fx: 760,
    fy: 762,
    cx: 638,
    cy: 481,
    distortion: [0, 0, 0, 0, 0],
    rms: .31,
    sampleCount: 18,
    reprojection: {
      centre: { near: .31, middle: .31, far: .31 },
      edges: { near: .31, middle: .31, far: .31 },
      maximumRms: .31,
    },
    calibratedAtMs: 4_000,
  };

  messages.length = 0;
  store.setCameraRegistration(sessionId, registration, control);
  assert.deepEqual(store.snapshot(sessionId).cameraRegistration, registration);
  assert.deepEqual(
    messages.find((message) => message.recipient === "capture" && message.type === "camera-registration")?.payload,
    { registration },
  );
  assert.throws(
    () => store.setCameraRegistration(sessionId, { ...registration, fx: 0 }, control),
    /invalid pinhole model/i,
  );
  assert.throws(
    () => store.setCameraRegistration(sessionId, registration, recorder),
    /only the capture director/i,
  );
});

test("disabling speech preserves raw audio while suppressing recognition and spoken output", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-speech-feature-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "speech-feature-session";
  const enabledStore = new SessionStore({ dataRoot, minimumFreeBytes: 0, features: { speech: true } });
  const requested = structuredClone(defaultConfiguration);
  requested.promptAudio.required = true;
  requested.promptAudio.useTextToSpeech = true;
  requested.recordAudio = true;
  await enabledStore.setConfiguration(sessionId, requested);

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0, features: { speech: false } });
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: "capture",
    role: "capture",
    pairingId: "speech-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const snapshot = store.snapshot(sessionId);
  const appliedConfiguration = messages.find((message) => message.type === "configuration")?.payload;
  assert.ok(appliedConfiguration);
  store.activateCaptureAuthority(sessionId, capture);
  assert.deepEqual(snapshot.features, { speech: false });
  assert.equal(snapshot.configuration.recordAudio, true);
  assert.equal(snapshot.configuration.promptAudio.useTextToSpeech, false);
  assert.equal(snapshot.configuration.promptAudio.required, false);

  messages.length = 0;
  store.beam(sessionId, "Continue", true, true);
  assert.deepEqual(messages.find((message) => message.type === "beam")?.payload, {
    text: "Continue",
    speak: false,
    visual: true,
  });
  await store.recordTranscript(sessionId, "start", Date.now());
  store.publishAsrStatus(sessionId, "ready");
  assert.equal(store.snapshot(sessionId).lastTranscript, null);
  assert.deepEqual(store.snapshot(sessionId).commandLog, []);
  assert.equal(messages.some((message) => message.type === "transcript" || message.type === "asr-status"), false);

  await store.setConfiguration(sessionId, {
    ...snapshot.configuration,
    runTitle: "Speech-disabled edit",
  });
  const persisted = JSON.parse(await readFile(path.join(dataRoot, "sessions", sessionId, "configuration.json"), "utf8"));
  assert.equal(persisted.configuration.promptAudio.useTextToSpeech, true);
  assert.equal(store.snapshot(sessionId).configuration.promptAudio.useTextToSpeech, false);

  const latestConfiguration = messages.filter((message) => message.type === "configuration").at(-1)?.payload;
  assert.ok(latestConfiguration);
  store.acknowledgeConfiguration(sessionId, capture, latestConfiguration.revision, latestConfiguration.checksum);
  await store.armRecorder(sessionId);
  await store.setCaptureStatus(sessionId, capture, {
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    transport: "connected",
    recorder: "armed",
    sensorRateHz: snapshot.configuration.recorderRateHz,
    lastFrameAt: Date.now(),
  });
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const pendingEpisode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(pendingEpisode);
  await store.acceptRecording(sessionId, capture, pendingEpisode.id);
  const audioBytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4);
  const audioBlock = encodedBlock({
    ...recorderInput(sessionId, pendingEpisode.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.AudioChunk,
    payload: encodeRecorderMediaPayload("audio/webm;codecs=opus", audioBytes),
  });
  assert.equal((await store.recordRecorderBlock(sessionId, audioBlock.decoded, audioBlock.encoded)).status, "durable");
  assert.deepEqual(
    [...await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", pendingEpisode.id, "audio", "0000000000.webm"))],
    [...audioBytes],
  );

});

test("freezes optional study metadata while rejecting raw audio that was not authorised for retention", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-study-metadata-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "study-metadata-session";
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const configuration = structuredClone(defaultConfiguration);
  configuration.recordAudio = false;
  configuration.studyMetadata = {
    headsetId: "quest-rig-9e",
    demonstratorId: "participant-024",
    projectId: "project-canterbury",
    consentDate: "2026-08-02",
    consentDocumentId: "consent-v4-042",
  };
  await store.setConfiguration(sessionId, configuration);

  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  assert.deepEqual(episode.captureMetadata?.study, {
    headsetId: "quest-rig-9e",
    demonstratorId: "participant-024",
    demonstratorIdOrigin: "entered",
    projectId: "project-canterbury",
    consentDate: "2026-08-02",
    consentDocumentId: "consent-v4-042",
  });
  assert.equal(episode.captureMetadata?.audio.rawMicrophoneAudioRetained, false);
  const journalPath = path.join(dataRoot, "sessions", sessionId, "recorder.blocks");
  const journalBeforeAudioRejection = await readFile(journalPath);

  const audioBlock = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.AudioChunk,
    payload: encodeRecorderMediaPayload("audio/webm;codecs=opus", Uint8Array.of(1, 2, 3)),
  });
  await assert.rejects(
    store.recordRecorderBlock(sessionId, audioBlock.decoded, audioBlock.encoded),
    /Raw microphone audio is disabled for this recording/,
  );
  assert.deepEqual(await readFile(journalPath), journalBeforeAudioRejection);
});

test("records explicit run metadata separately from task metadata", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-session-store-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const configuration = structuredClone(defaultConfiguration);
  configuration.runTitle = "Red block placement";
  configuration.runDescription = "Place the red block in the tray";
  await store.setConfiguration("test-session", configuration);

  await store.armRecorder("test-session");
  const capture = connectReadyCapture(store, "test-session");
  await store.control("test-session", "start-sequence");
  await store.control("test-session", "start");
  const pendingEpisode = store.snapshot("test-session").pendingEpisode;
  assert.ok(pendingEpisode);
  await store.acceptRecording("test-session", capture, pendingEpisode.id);
  const segment = pendingEpisode.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput("test-session", pendingEpisode.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock("test-session", segmentStart.decoded, segmentStart.encoded);
  const firstBlock = encodedBlock(recorderInput("test-session", pendingEpisode.id, 1, 0, 1_000_000));
  await store.recordRecorderBlock("test-session", firstBlock.decoded, firstBlock.encoded);

  const episode = store.snapshot("test-session").currentEpisode;
  assert.ok(episode);
  assert.equal(episode.runTitle, "Red block placement");
  assert.equal(episode.runDescription, "Place the red block in the tray");
  assert.equal(episode.taskLabel, "Open task");
  assert.equal(episode.taskDescription, "Place the red block in the tray");

  const savedEpisode = JSON.parse(await readFile(
    path.join(dataRoot, "sessions", "test-session", "episodes", episode.id, "episode.json"),
    "utf8",
  ));
  assert.equal(savedEpisode.runTitle, "Red block placement");
  assert.equal(savedEpisode.runDescription, "Place the red block in the tray");
  assert.equal(savedEpisode.taskDescription, "Place the red block in the tray");
  assert.equal(savedEpisode.taskSpecVersion, 1);
  assert.match(savedEpisode.taskSpecHash, /^[0-9a-f]{64}$/);
  assert.equal(savedEpisode.taskSpecification.runTitle, "Red block placement");
  const taskSpecPath = path.join(
    dataRoot,
    "sessions",
    "test-session",
    "episodes",
    episode.id,
    "task-specifications",
    `${savedEpisode.taskSpecHash}.json`,
  );
  assert.equal(await readFile(taskSpecPath, "utf8"), canonicalTaskSpecification(savedEpisode.taskSpecification));
  const commit = JSON.parse(await readFile(
    path.join(dataRoot, "sessions", "test-session", "episodes", episode.id, "episode.commit.json"),
    "utf8",
  ));
  assert.equal(commit.schema, "ceres-episode-commit-v2");
  assert.equal(commit.taskSpecVersion, savedEpisode.taskSpecVersion);
  assert.equal(commit.taskSpecHash, savedEpisode.taskSpecHash);
});

test("encodes the fixed recorder header and rejects checksum corruption", () => {
  const encoded = encodeRecorderBlock(recorderInput("codec-session", "episode-001", 0, 0, 1_000_000));
  assert.equal(encoded.byteLength, 48 + "codec-session".length + "episode-001".length + telemetryPayload(0).byteLength);
  const decoded = decodeRecorderBlock(encoded);
  assert.equal(decoded.sessionId, "codec-session");
  assert.equal(decoded.episodeId, "episode-001");
  assert.equal(decoded.sequence, 0);
  assert.equal(decoded.recorderFrameIndex, 0);
  assert.equal(decoded.sourceTimestampUs, 1_000_000);
  assert.equal(decoded.flags, RecorderBlockFlags.SensorFrameJson);
  assert.equal(RecorderBlockFlags.MediaChunk, 1 << 3);
  assert.equal(RecorderBlockFlags.AudioChunk, 1 << 4);
  assert.equal("Depth" in RecorderBlockFlags, false);

  const corrupted = encoded.slice();
  corrupted[corrupted.byteLength - 1] ^= 0xff;
  assert.throws(
    () => decodeRecorderBlock(corrupted),
    (error: unknown) => error instanceof RecorderProtocolError && error.code === "checksum-mismatch" && error.sequence === 0,
  );
});

test("writes ordered slots durably with explicit gaps and idempotent reconnect acknowledgements", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-continuity-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "continuity-session";
  const capture = connectReadyCapture(store, sessionId);
  const connection = recorderConnection("connection-one", capture.pairingId!);
  store.connect(sessionId, connection);
  await store.armRecorder(sessionId, connection);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);

  const segment = episode.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 2_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  const block0 = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 2_000_000));
  const gap1 = encodedBlock({
    ...recorderInput(sessionId, episode.id, 2, 1, 2_033_333),
    flags: RecorderBlockFlags.Gap,
    payload: new TextEncoder().encode("XR pose unavailable"),
  });
  const block2 = encodedBlock(recorderInput(sessionId, episode.id, 3, 2, 2_066_666));

  assert.equal((await store.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded)).status, "durable");
  assert.equal((await store.recordRecorderBlock(sessionId, block0.decoded, block0.encoded)).status, "durable");
  assert.equal(store.snapshot(sessionId).pendingEpisode, null);
  assert.equal(store.snapshot(sessionId).currentEpisode?.integrity, "valid");
  assert.equal(store.snapshot(sessionId).currentEpisode?.frameCount, 1);
  const completionOrder: number[] = [];
  const write1 = store.recordRecorderBlock(sessionId, gap1.decoded, gap1.encoded).then((result) => {
    completionOrder.push(result.block.sequence);
    return result;
  });
  const write2 = store.recordRecorderBlock(sessionId, block2.decoded, block2.encoded).then((result) => {
    completionOrder.push(result.block.sequence);
    return result;
  });
  assert.equal((await write1).status, "durable");
  assert.equal((await write2).status, "durable");
  assert.deepEqual(completionOrder, [2, 3]);

  const journalPath = path.join(dataRoot, "sessions", sessionId, "recorder.blocks");
  const beforeReconnect = await stat(journalPath);
  store.disconnect(sessionId, connection);
  const reconnectedRecorder = recorderConnection("connection-two", capture.pairingId!);
  store.connect(sessionId, reconnectedRecorder);
  await store.armRecorder(sessionId, reconnectedRecorder);
  const duplicate = await store.recordRecorderBlock(sessionId, block2.decoded, block2.encoded);
  assert.equal(duplicate.status, "duplicate");
  assert.equal((await stat(journalPath)).size, beforeReconnect.size);
  const conflicting = encodedBlock({
    ...recorderInput(sessionId, episode.id, 3, 2, 2_066_666),
    payload: new TextEncoder().encode(`${new TextDecoder().decode(telemetryPayload(2))} `),
  });
  await assert.rejects(
    store.recordRecorderBlock(sessionId, conflicting.decoded, conflicting.encoded),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "sequence-conflict",
  );

  const journal = await readFile(journalPath);
  const journalBlocks = [];
  for (let offset = 0; offset < journal.byteLength;) {
    const length = recorderBlockByteLength(journal, offset);
    journalBlocks.push(decodeRecorderBlock(journal.subarray(offset, offset + length)));
    offset += length;
  }
  assert.deepEqual(journalBlocks.map((block) => block.sequence), [0, 1, 2, 3]);
  assert.deepEqual(journalBlocks.map((block) => block.recorderFrameIndex), [0, 0, 1, 2]);

  const sensorRecords = (await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "sensors.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(sensorRecords.length, 3);
  assert.equal(sensorRecords[1].gap, true);
  assert.equal(sensorRecords[1].reason, "XR pose unavailable");
  assert.deepEqual(sensorRecords.map((record) => record.recorder.sequence), [1, 2, 3]);

  const snapshot = store.snapshot(sessionId);
  assert.equal(snapshot.currentEpisode?.frameCount, 2);
  assert.equal(snapshot.currentEpisode?.recorderSlotCount, 3);
  assert.equal(snapshot.currentEpisode?.gapCount, 1);
  assert.equal(snapshot.captureStatus.recorderDurableAckSequence, 3);
  assert.equal(snapshot.captureStatus.recorderFrameIndex, 2);
  assert.equal(snapshot.captureStatus.recorderGaps, 1);
});

test("rejects out-of-order recorder sequences before acknowledging them", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-order-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "ordered-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);
  const reservedFlag = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 3_000_000),
    flags: RecorderBlockFlags.SensorFrameJson | (1 << 5),
  });
  await assert.rejects(
    store.recordRecorderBlock(sessionId, reservedFlag.decoded, reservedFlag.encoded),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "invalid-block" && /unsupported flags/.test(error.message),
  );
  const sequenceOne = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 3_000_000));
  await assert.rejects(
    store.recordRecorderBlock(sessionId, sequenceOne.decoded, sequenceOne.encoded),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "out-of-order" && error.expectedSequence === 0,
  );
  const journalPath = path.join(dataRoot, "sessions", sessionId, "recorder.blocks");
  assert.equal((await stat(journalPath)).size, 0);
});

test("session restart disconnects the paired capture and clears its live state", async () => {
  const store = new SessionStore({ minimumFreeBytes: 0 });
  const sessionId = "restart-session";
  const captureMessages: Array<{ type: string; payload: any }> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const control: SessionConnection = {
    id: "control",
    role: "monitor-control",
    send: () => undefined,
  };
  const monitor: SessionConnection = {
    id: "monitor",
    role: "monitor",
    send: () => undefined,
  };
  const capture: SessionConnection = {
    id: "capture",
    role: "capture",
    pairingId: "restart-pairing",
    send: (type, payload) => captureMessages.push({ type, payload }),
    close: (code, reason) => closes.push({ code, reason }),
  };

  store.connect(sessionId, monitor);
  store.connect(sessionId, control);
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const configuration = captureMessages.find((message) => message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(sessionId, capture, configuration.revision, configuration.checksum);
  store.activateCaptureAuthority(sessionId, capture);
  assert.equal(store.snapshot(sessionId).captureConnected, true);
  captureMessages.length = 0;

  await assert.rejects(store.restartSession(sessionId, monitor), /only the connected capture director/i);
  assert.equal(store.snapshot(sessionId).captureConnected, true);

  await store.restartSession(sessionId, control);

  assert.equal(store.snapshot(sessionId).captureConnected, false);
  assert.deepEqual(captureMessages, [{
    type: "pairing-rejected",
    payload: {
      code: "capture-session-restarted",
      message: "The capture director restarted the session",
    },
  }]);
  assert.deepEqual(closes, [{
    code: CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
    reason: "The capture director restarted the session",
  }]);
});

test("recorder annotation events must match an authoritative segment annotation identity", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-annotation-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "annotation-event-session";
  const configuration = structuredClone(defaultConfiguration);
  const task = configuration.tasks[0];
  if (task?.type === "open" || task?.type === "timed") task.resetTimeS = 1;
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, 4_000_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "success");
  const segment = store.snapshot(sessionId).currentEpisode?.segments?.[0];
  const annotation = segment?.annotations.find(({ action }) => action === "pass");
  assert.ok(segment);
  assert.ok(annotation);
  const authoritativeSequence = store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1;

  const authoritative = encodedBlock({
    ...recorderInput(sessionId, episode.id, authoritativeSequence, 0, 4_100_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "annotation",
      segmentId: segment.id,
      annotationId: annotation.id,
      action: "pass",
      actor: "director",
    }),
  });
  await store.recordRecorderBlock(sessionId, authoritative.decoded, authoritative.encoded);
  assert.equal(
    store.snapshot(sessionId).currentEpisode?.segments?.[0]?.annotations.find(({ id }) => id === annotation.id)?.sourceTimestampUs,
    4_100_000,
  );

  const forged = encodedBlock({
    ...recorderInput(sessionId, episode.id, authoritativeSequence + 1, 0, 4_200_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "annotation",
      segmentId: segment.id,
      annotationId: "unknown-annotation-id",
      action: "pass",
      actor: "director",
    }),
  });
  const journalPath = path.join(dataRoot, "sessions", sessionId, "recorder.blocks");
  const journalBytesBeforeForgery = (await stat(journalPath)).size;
  await assert.rejects(
    store.recordRecorderBlock(sessionId, forged.decoded, forged.encoded),
    (error: unknown) => error instanceof RecorderStoreError
      && error.code === "invalid-block"
      && /unknown authoritative annotation/.test(error.message),
  );
  assert.equal((await stat(journalPath)).size, journalBytesBeforeForgery);
});

test("attributes timestamped durable recorder slots to their task segments", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-segment-timestamps-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "segment-timestamps-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
    { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const firstSegment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(firstSegment);
  await store.acceptRecording(sessionId, capture, episode.id);

  const writeRunEvent = async (
    sequence: number,
    recorderFrameIndex: number,
    sourceTimestampUs: number,
    event: Parameters<typeof encodeRecorderRunEvent>[0],
  ) => {
    const block = encodedBlock({
      ...recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent(event),
    });
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  };
  const writeSensor = async (sequence: number, recorderFrameIndex: number, sourceTimestampUs: number) => {
    const block = encodedBlock(recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs));
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  };

  await writeRunEvent(0, 0, 10_000_000, {
    type: "segment-start",
    segmentId: firstSegment.id,
    taskId: firstSegment.taskId,
    taskLabel: firstSegment.taskLabel,
  });
  await writeSensor(1, 0, 10_100_000);
  await store.control(sessionId, "next-task");
  await writeRunEvent(2, 0, 10_200_000, {
    type: "segment-end",
    segmentId: firstSegment.id,
    taskId: firstSegment.taskId,
    taskLabel: firstSegment.taskLabel,
  });
  await store.control(sessionId, "next-task");
  const secondSegment = store.snapshot(sessionId).currentEpisode?.segments?.[1];
  assert.ok(secondSegment);
  await writeRunEvent(3, 0, 10_300_000, {
    type: "segment-start",
    segmentId: secondSegment.id,
    taskId: secondSegment.taskId,
    taskLabel: secondSegment.taskLabel,
  });
  await writeSensor(4, 1, 10_400_000);
  await store.control(sessionId, "next-task");
  await writeRunEvent(5, 1, 10_500_000, {
    type: "segment-end",
    segmentId: secondSegment.id,
    taskId: secondSegment.taskId,
    taskLabel: secondSegment.taskLabel,
  });
  await store.control(sessionId, "next-task");
  await store.finaliseRecording(sessionId, capture, episode.id);

  const completed = store.snapshot(sessionId).episodes[0];
  assert.deepEqual(completed?.segments?.map((segment) => ({
    id: segment.id,
    startSourceTimestampUs: segment.startSourceTimestampUs,
    endSourceTimestampUs: segment.endSourceTimestampUs,
    frameCount: segment.frameCount,
    recorderSlotCount: segment.recorderSlotCount,
  })), [
    {
      id: firstSegment.id,
      startSourceTimestampUs: 10_000_000,
      endSourceTimestampUs: 10_200_000,
      frameCount: 1,
      recorderSlotCount: 1,
    },
    {
      id: secondSegment.id,
      startSourceTimestampUs: 10_300_000,
      endSourceTimestampUs: 10_500_000,
      frameCount: 1,
      recorderSlotCount: 1,
    },
  ]);
  const sidecarSegments = (await readFile(
    path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "sensors.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line).recorder.segmentId);
  assert.deepEqual(sidecarSegments, [firstSegment.id, secondSegment.id]);
});

test("keeps delayed task A frames out of task B before task B's durable start", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-delayed-segment-frame-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "delayed-segment-frame-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
    { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const firstSegment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(firstSegment);
  await store.acceptRecording(sessionId, capture, episode.id);

  const writeRunEvent = async (
    sequence: number,
    recorderFrameIndex: number,
    sourceTimestampUs: number,
    event: Parameters<typeof encodeRecorderRunEvent>[0],
  ) => {
    const block = encodedBlock({
      ...recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent(event),
    });
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  };
  const writeSensor = async (sequence: number, recorderFrameIndex: number, sourceTimestampUs: number) => {
    const block = encodedBlock(recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs));
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  };

  await writeRunEvent(0, 0, 10_000_000, {
    type: "segment-start",
    segmentId: firstSegment.id,
    taskId: firstSegment.taskId,
    taskLabel: firstSegment.taskLabel,
  });
  await writeSensor(1, 0, 10_100_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  const secondSegment = store.snapshot(sessionId).currentEpisode?.segments?.[1];
  assert.ok(secondSegment);
  assert.equal(secondSegment.taskId, "task-b");
  assert.equal(secondSegment.startSourceTimestampUs, undefined);

  await writeSensor(2, 1, 10_150_000);
  const backlogged = store.snapshot(sessionId).currentEpisode;
  assert.equal(backlogged?.segments?.[0]?.recorderSlotCount, 2);
  assert.equal(backlogged?.segments?.[0]?.frameCount, 2);
  assert.equal(backlogged?.segments?.[1]?.recorderSlotCount, 0);
  assert.equal(backlogged?.segments?.[1]?.frameCount, 0);

  await writeRunEvent(3, 1, 10_200_000, {
    type: "segment-end",
    segmentId: firstSegment.id,
    taskId: firstSegment.taskId,
    taskLabel: firstSegment.taskLabel,
  });
  await writeRunEvent(4, 1, 10_300_000, {
    type: "segment-start",
    segmentId: secondSegment.id,
    taskId: secondSegment.taskId,
    taskLabel: secondSegment.taskLabel,
  });
  assert.equal(store.snapshot(sessionId).currentEpisode?.segments?.[1]?.recorderSlotCount, 0);

  const sensorSegmentIds = (await readFile(
    path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "sensors.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line).recorder.segmentId);
  assert.deepEqual(sensorSegmentIds, [firstSegment.id, firstSegment.id]);

  await store.control(sessionId, "next-task");
  await writeRunEvent(5, 1, 10_400_000, {
    type: "segment-end",
    segmentId: secondSegment.id,
    taskId: secondSegment.taskId,
    taskLabel: secondSegment.taskLabel,
  });
  await store.control(sessionId, "next-task");
  await store.finaliseRecording(sessionId, capture, episode.id);
  const attempt = store.snapshot(sessionId).attempts[0];
  assert.equal(store.snapshot(sessionId).episodes.length, 0);
  assert.equal(attempt?.segments?.[0]?.recorderSlotCount, 2);
  assert.equal(attempt?.segments?.[1]?.recorderSlotCount, 0);
  assert.match(attempt?.integrityReason ?? "", /Task segment Task B has no durable recorder slots/);
});

test("serialises recorder accounting and task completion through one episode writer", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-run-serialisation-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "recorder-run-serialisation-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, 15_000_000);

  type PersistEpisode = (session: unknown, episode: Episode) => Promise<void>;
  const writableStore = store as unknown as { persistEpisode: PersistEpisode };
  const persistEpisode = writableStore.persistEpisode.bind(store);
  let signalCaptured: (() => void) | null = null;
  let releasePersist: (() => void) | null = null;
  const captured = new Promise<void>((resolve) => { signalCaptured = resolve; });
  const release = new Promise<void>((resolve) => { releasePersist = resolve; });
  let interceptRecorderPersist = true;
  writableStore.persistEpisode = async (session, candidate) => {
    if (interceptRecorderPersist && candidate.id === episode.id && candidate.frameCount === 2) {
      interceptRecorderPersist = false;
      const staleRecorderSnapshot = structuredClone(candidate);
      signalCaptured?.();
      await release;
      await persistEpisode(session, staleRecorderSnapshot);
      return;
    }
    await persistEpisode(session, candidate);
  };

  const sequence = store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1;
  const secondFrame = encodedBlock(recorderInput(sessionId, episode.id, sequence, 1, 15_100_000));
  const recorderWrite = store.recordRecorderBlock(sessionId, secondFrame.decoded, secondFrame.encoded);
  await captured;
  let controlSettled = false;
  const completeTask = store.control(sessionId, "next-task").then(() => { controlSettled = true; });
  await delay(20);
  const settledBeforeRecorderPersist = controlSettled;
  releasePersist?.();
  await Promise.all([recorderWrite, completeTask]);
  writableStore.persistEpisode = persistEpisode;

  assert.equal(settledBeforeRecorderPersist, false);
  const inMemory = store.snapshot(sessionId).currentEpisode;
  assert.equal(inMemory?.frameCount, 2);
  assert.equal(inMemory?.recorderSlotCount, 2);
  assert.equal(inMemory?.segments?.[0]?.outcome, "completed");
  assert.equal(inMemory?.segments?.[0]?.frameCount, 2);
  assert.equal(inMemory?.segments?.[0]?.recorderSlotCount, 2);
  const persisted = JSON.parse(await readFile(
    path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "episode.json"),
    "utf8",
  )) as Episode;
  assert.equal(persisted.frameCount, 2);
  assert.equal(persisted.recorderSlotCount, 2);
  assert.equal(persisted.segments?.[0]?.outcome, "completed");
  assert.equal(persisted.segments?.[0]?.frameCount, 2);
  assert.equal(persisted.segments?.[0]?.recorderSlotCount, 2);
});

test("does not open task B until the first durable slot activates task A", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-pending-segment-promotion-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "pending-segment-promotion-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
    { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);

  const awaitingFirstSlot = store.snapshot(sessionId);
  assert.equal(awaitingFirstSlot.run.phase, null);
  assert.equal(awaitingFirstSlot.run.activeTaskIndex, 0);
  assert.equal(awaitingFirstSlot.pendingEpisode?.id, episode.id);
  await assert.rejects(store.control(sessionId, "next-task"), /only available during a reset/i);

  const unattributedFirstSlot = encodedBlock(recorderInput(sessionId, episode.id, 0, 0, 20_000_000));
  await store.recordRecorderBlock(sessionId, unattributedFirstSlot.decoded, unattributedFirstSlot.encoded);
  const stillPending = store.snapshot(sessionId);
  assert.equal(stillPending.run.phase, null);
  assert.equal(stillPending.pendingEpisode?.id, episode.id);
  assert.equal(stillPending.pendingEpisode?.segments?.[0]?.recorderSlotCount, 0);

  const segment = stillPending.pendingEpisode?.segments?.[0];
  assert.ok(segment);
  const start = encodedBlock({
    ...recorderInput(sessionId, episode.id, 1, 1, 20_100_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, start.decoded, start.encoded);
  const attributedSlot = encodedBlock(recorderInput(sessionId, episode.id, 2, 1, 20_200_000));
  await store.recordRecorderBlock(sessionId, attributedSlot.decoded, attributedSlot.encoded);
  const promoted = store.snapshot(sessionId);
  assert.equal(promoted.pendingEpisode, null);
  assert.equal(promoted.currentEpisode?.id, episode.id);
  assert.equal(promoted.run.phase, "active-task");
  assert.equal(promoted.run.activeTaskIndex, 0);
  assert.equal(promoted.run.recordingState, "recording");
  assert.equal(promoted.currentEpisode?.segments?.length, 1);

  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).currentEpisode?.segments?.[0]?.outcome, "completed");
  await store.control(sessionId, "next-task");
  const taskB = store.snapshot(sessionId);
  assert.equal(taskB.run.phase, "active-task");
  assert.equal(taskB.run.activeTaskIndex, 1);
  assert.deepEqual(taskB.currentEpisode?.segments?.map(({ taskId, outcome }) => ({ taskId, outcome })), [
    { taskId: "task-a", outcome: "completed" },
    { taskId: "task-b", outcome: "recording" },
  ]);
});

test("promotion persistence failure leaves the task unpublished and the pending episode authoritative", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-promotion-persist-failure-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "promotion-persist-failure-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const controls: string[] = [];
  capture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const segment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(segment);
  await store.acceptRecording(sessionId, capture, episode.id);
  const start = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 21_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, start.decoded, start.encoded);

  type PersistEpisode = (session: unknown, candidate: Episode) => Promise<void>;
  const writableStore = store as unknown as { persistEpisode: PersistEpisode };
  const persistEpisode = writableStore.persistEpisode.bind(store);
  writableStore.persistEpisode = async (session, candidate) => {
    if (candidate.id === episode.id && candidate.integrity === "valid") {
      throw new RecorderStoreError("write-failed", "simulated promotion persistence failure");
    }
    await persistEpisode(session, candidate);
  };

  const firstSlot = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 21_100_000));
  await assert.rejects(
    store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded),
    /simulated promotion persistence failure/,
  );

  const failed = store.snapshot(sessionId);
  assert.equal(failed.pendingEpisode?.id, episode.id);
  assert.equal(failed.pendingEpisode?.integrity, "pending");
  assert.equal(failed.currentEpisode, null);
  assert.equal(failed.run.phase, null);
  assert.equal(failed.run.recordingState, "arming");
  assert.equal(failed.recording, false);
  assert.equal(failed.captureStatus.recorder, "failed");
  assert.equal(controls.includes("recording-started"), false);
  assert.equal(controls.includes("sequence-started"), false);
  const internal = (store as unknown as {
    sessions: Map<string, { pendingTaskPublication: string | null; timedTaskTimer: NodeJS.Timeout | null }>;
  }).sessions.get(sessionId);
  assert.equal(internal?.pendingTaskPublication, "sequence-started");
  assert.equal(internal?.timedTaskTimer, null);
});

test("finalisation rejects recorder rows outside durable task segments", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-segment-row-leakage-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "segment-row-leakage-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const segment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(segment);
  await store.acceptRecording(sessionId, capture, episode.id);

  const unassigned = encodedBlock(recorderInput(sessionId, episode.id, 0, 0, 22_000_000));
  await store.recordRecorderBlock(sessionId, unassigned.decoded, unassigned.encoded);
  const start = encodedBlock({
    ...recorderInput(sessionId, episode.id, 1, 1, 22_100_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, start.decoded, start.encoded);
  const assigned = encodedBlock(recorderInput(sessionId, episode.id, 2, 1, 22_200_000));
  await store.recordRecorderBlock(sessionId, assigned.decoded, assigned.encoded);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await finaliseRequestedStop(store, sessionId, capture);

  const failed = store.snapshot(sessionId);
  assert.equal(failed.episodes.length, 0);
  assert.equal(failed.attempts[0]?.frameCount, 2);
  assert.equal(failed.attempts[0]?.segments?.[0]?.frameCount, 1);
  assert.match(failed.attempts[0]?.integrityReason ?? "", /frames are not fully attributed/);
});

test("reconciles committed recorder blocks before the reload handshake advances nextSequence", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-reload-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "reload-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const capture = connectReadyCapture(firstStore, sessionId);
  await firstStore.control(sessionId, "start-sequence");
  await firstStore.control(sessionId, "start");
  const episode = firstStore.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await firstStore.acceptRecording(sessionId, capture, episode.id);
  const segment = episode.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 4_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await firstStore.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const block = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 4_000_000));
  assert.equal((await firstStore.recordRecorderBlock(sessionId, block.decoded, block.encoded)).status, "durable");
  const media = encodedBlock({
    ...recorderInput(sessionId, episode.id, 2, 0, 4_100_000),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(1, 2, 3)),
  });
  assert.equal((await firstStore.recordRecorderBlock(sessionId, media.decoded, media.encoded)).status, "durable");

  const episodePath = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "episode.json");
  const staleMetadata = JSON.parse(await readFile(episodePath, "utf8")) as Episode;
  staleMetadata.frameCount = 0;
  staleMetadata.recorderSlotCount = 0;
  staleMetadata.mediaChunkCount = 0;
  staleMetadata.qualitySummary.frameCount = 0;
  if (staleMetadata.segments?.[0]) {
    staleMetadata.segments[0].frameCount = 0;
    staleMetadata.segments[0].gapCount = 0;
    staleMetadata.segments[0].recorderSlotCount = 0;
  }
  await writeFile(episodePath, `${JSON.stringify(staleMetadata, null, 2)}\n`);
  const sensorPath = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "sensors.jsonl");
  await rm(sensorPath, { force: true });
  const mediaChunkPath = path.join(
    dataRoot,
    "sessions",
    sessionId,
    "episodes",
    episode.id,
    "video",
    "recorder-chunks",
    "0000000002.block",
  );
  const mediaChunkSize = (await stat(mediaChunkPath)).size;

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const recorder = recorderConnection("reload-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await reloadedStore.armRecorder(sessionId, recorder), { nextSequence: 3 });
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.id, episode.id);
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.frameCount, 1);
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.recorderSlotCount, 1);
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.mediaChunkCount, 1);
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.segments?.[0]?.frameCount, 1);
  assert.equal(reloadedStore.snapshot(sessionId).currentEpisode?.segments?.[0]?.recorderSlotCount, 1);
  const lines = (await readFile(sensorPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal((await stat(mediaChunkPath)).size, mediaChunkSize);
});

test("promotes an accepted pending episode after a crash left only its materialised first slot", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-pending-materialised-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "pending-materialised-recovery-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const capture = connectReadyCapture(firstStore, sessionId);
  await firstStore.control(sessionId, "start-sequence");
  const episode = firstStore.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await firstStore.acceptRecording(sessionId, capture, episode.id);
  const acceptedPending = structuredClone(firstStore.snapshot(sessionId).pendingEpisode);
  assert.ok(acceptedPending);
  assert.ok(acceptedPending.recorderAcceptedAt);

  const segment = episode.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 4_500_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await firstStore.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const block = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 4_500_000));
  assert.equal((await firstStore.recordRecorderBlock(sessionId, block.decoded, block.encoded)).status, "durable");
  const episodeRoot = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id);
  const attemptPath = path.join(episodeRoot, "attempt.json");
  const episodePath = path.join(episodeRoot, "episode.json");
  await writeFile(attemptPath, `${JSON.stringify(acceptedPending, null, 2)}\n`);
  await rm(episodePath, { force: true });

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const recorder = recorderConnection("pending-recovery-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await reloadedStore.armRecorder(sessionId, recorder), { nextSequence: 2 });
  const recovered = reloadedStore.snapshot(sessionId);
  assert.equal(recovered.pendingEpisode, null);
  assert.equal(recovered.currentEpisode?.id, episode.id);
  assert.equal(recovered.currentEpisode?.integrity, "valid");
  assert.equal(recovered.currentEpisode?.frameCount, 1);
  assert.equal(recovered.currentEpisode?.gapCount, 0);
  assert.equal(recovered.currentEpisode?.recorderSlotCount, 1);
  assert.equal(recovered.currentEpisode?.firstRecorderSequence, 0);
  assert.equal(recovered.currentEpisode?.lastRecorderSequence, 1);
  assert.equal(recovered.currentEpisode?.segments?.[0]?.frameCount, 1);
  assert.equal(recovered.currentEpisode?.segments?.[0]?.recorderSlotCount, 1);
  const lines = (await readFile(path.join(episodeRoot, "sensors.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
});

test("reconciles a durable run event when episode metadata was not persisted before reload", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-run-event-reload-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "run-event-reload-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const capture = connectReadyCapture(firstStore, sessionId);
  await firstStore.control(sessionId, "start-sequence");
  const episode = firstStore.snapshot(sessionId).pendingEpisode;
  const segment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(segment);
  await firstStore.acceptRecording(sessionId, capture, episode.id);
  const block = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 4_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  assert.equal((await firstStore.recordRecorderBlock(sessionId, block.decoded, block.encoded)).status, "durable");
  const sensorBlock = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 4_000_000));
  assert.equal((await firstStore.recordRecorderBlock(
    sessionId,
    sensorBlock.decoded,
    sensorBlock.encoded,
  )).status, "durable");

  const episodePath = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "episode.json");
  const interruptedMetadata = JSON.parse(await readFile(episodePath, "utf8")) as Episode;
  delete interruptedMetadata.segments?.[0]?.startSourceTimestampUs;
  interruptedMetadata.firstRecorderSequence = 1;
  interruptedMetadata.lastRecorderSequence = 1;
  await writeFile(episodePath, `${JSON.stringify(interruptedMetadata, null, 2)}\n`);

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const recorder = recorderConnection("run-event-recovery-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await reloadedStore.armRecorder(sessionId, recorder), { nextSequence: 2 });
  const recovered = reloadedStore.snapshot(sessionId).currentEpisode;
  assert.equal(recovered?.segments?.[0]?.startSourceTimestampUs, 4_000_000);
  assert.equal(recovered?.firstRecorderSequence, 0);
  assert.equal(recovered?.lastRecorderSequence, 1);
  const runEventLines = (await readFile(
    path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "run-events.jsonl"),
    "utf8",
  )).trim().split("\n");
  assert.equal(runEventLines.length, 1);
});

test("recovers a durable Finish request as terminal finalisation rather than a task pause", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-request-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "finish-request-recovery-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const firstCapture = connectReadyCapture(firstStore, sessionId);
  const episode = await recordValidTake(firstStore, sessionId, firstCapture, 0, 5_000_000);
  await firstStore.control(
    sessionId,
    "finish",
    firstCapture,
    nextRunControlCursor(firstStore.snapshot(sessionId), "finish"),
  );
  assert.equal(firstStore.snapshot(sessionId).currentEpisode?.runFinalisation, "finish-requested");

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const controls: string[] = [];
  reloadedCapture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  const recorder = recorderConnection("finish-request-recovery-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  await reloadedStore.armRecorder(sessionId, recorder);

  const recovered = reloadedStore.snapshot(sessionId);
  assert.equal(recovered.currentEpisode?.id, episode.id);
  assert.equal(recovered.currentEpisode?.runFinalisation, "finish-requested");
  assert.equal(recovered.run.status, "running");
  assert.equal(recovered.run.phase, null);
  assert.equal(recovered.run.recordingState, "stopping");
  assert.deepEqual(
    controls.filter((action) => action.startsWith("recording-")),
    ["recording-started", "recording-paused", "recording-event", "recording-stopping"],
  );

  await finaliseRequestedStop(reloadedStore, sessionId, reloadedCapture);
  assert.equal(reloadedStore.snapshot(sessionId).run.status, "complete");
  assert.equal(reloadedStore.snapshot(sessionId).episodes[0]?.runFinalisation, "finish-completed");
});

test("recovers a durably completed Finish as an idempotent complete run", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-complete-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "finish-complete-recovery-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const firstCapture = connectReadyCapture(firstStore, sessionId);
  const episode = await recordValidTake(firstStore, sessionId, firstCapture, 0, 6_000_000);
  await firstStore.control(
    sessionId,
    "finish",
    firstCapture,
    nextRunControlCursor(firstStore.snapshot(sessionId), "finish"),
  );
  await finaliseRequestedStop(firstStore, sessionId, firstCapture);
  assert.equal(firstStore.snapshot(sessionId).episodes[0]?.runFinalisation, "finish-completed");

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const controls: string[] = [];
  reloadedCapture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  const recorder = recorderConnection("finish-complete-recovery-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  await reloadedStore.armRecorder(sessionId, recorder);

  const recovered = reloadedStore.snapshot(sessionId);
  assert.equal(recovered.run.status, "complete");
  assert.equal(recovered.run.phase, null);
  assert.equal(recovered.run.recordingState, "idle");
  assert.equal(recovered.currentEpisode, null);
  assert.equal(recovered.pendingEpisode, null);
  assert.equal(recovered.episodes[0]?.id, episode.id);
  assert.equal(recovered.episodes[0]?.runFinalisation, "finish-completed");
  assert.equal(controls.includes("recording-stopping"), false);

  await reloadedStore.armRecorder(sessionId, recorder);
  assert.equal(reloadedStore.snapshot(sessionId).run.status, "complete");
  assert.equal(reloadedStore.snapshot(sessionId).episodes.filter(({ id }) => id === episode.id).length, 1);
});

test("recovers a post-task-pause Finish as terminal finalisation", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-post-task-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "finish-post-task-recovery-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const firstCapture = connectReadyCapture(firstStore, sessionId);
  const episode = await recordValidTake(firstStore, sessionId, firstCapture, 0, 6_500_000);
  await firstStore.control(
    sessionId,
    "next-task",
    firstCapture,
    nextRunControlCursor(firstStore.snapshot(sessionId), "next-task"),
  );
  assert.equal(firstStore.snapshot(sessionId).run.phase, "post-task-pause");
  await writeMissingCompletedSegmentEnds(firstStore, sessionId, 6_500_001);
  assert.ok(firstStore.snapshot(sessionId).currentEpisode?.segments?.[0]?.endSourceTimestampUs);
  await firstStore.control(
    sessionId,
    "finish",
    firstCapture,
    nextRunControlCursor(firstStore.snapshot(sessionId), "finish"),
  );
  assert.equal(firstStore.snapshot(sessionId).currentEpisode?.runFinalisation, "finish-requested");

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const recorder = recorderConnection("finish-post-task-recovery-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  await reloadedStore.armRecorder(sessionId, recorder);

  const recovered = reloadedStore.snapshot(sessionId);
  assert.equal(recovered.currentEpisode?.id, episode.id);
  assert.equal(recovered.currentEpisode?.runFinalisation, "finish-requested");
  assert.equal(recovered.run.status, "running");
  assert.equal(recovered.run.phase, null);
  assert.equal(recovered.run.recordingState, "stopping");
  await finaliseRequestedStop(reloadedStore, sessionId, reloadedCapture);
  assert.equal(reloadedStore.snapshot(sessionId).run.status, "complete");
  assert.equal(reloadedStore.snapshot(sessionId).episodes[0]?.runFinalisation, "finish-completed");
});

test("does not resurrect a completed Finish after reconfiguration", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-reconfiguration-fence-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "finish-reconfiguration-fence-session";
  const firstStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await firstStore.armRecorder(sessionId);
  const firstCapture = connectReadyCapture(firstStore, sessionId);
  const episode = await recordValidTake(firstStore, sessionId, firstCapture, 0, 6_750_000);
  await firstStore.control(
    sessionId,
    "finish",
    firstCapture,
    nextRunControlCursor(firstStore.snapshot(sessionId), "finish"),
  );
  await finaliseRequestedStop(firstStore, sessionId, firstCapture);
  const completedRevision = firstStore.snapshot(sessionId).episodes[0]?.configurationRevision;
  assert.equal(completedRevision, firstStore.snapshot(sessionId).configurationStatus.revision);

  const replacement = structuredClone(firstStore.snapshot(sessionId).configuration);
  replacement.runTitle = "Replacement run";
  replacement.tasks = [{
    id: "replacement-task",
    label: "Replacement task",
    instructions: "Use the new run definition",
    type: "open",
    repeatCount: 1,
    resetTimeS: 5,
  }];
  await firstStore.setConfiguration(sessionId, replacement);
  assert.ok(firstStore.snapshot(sessionId).configurationStatus.revision > (completedRevision ?? 0));

  const reloadedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloadedStore, sessionId);
  const recorder = recorderConnection("finish-reconfiguration-fence-recorder", reloadedCapture.pairingId!);
  assert.equal(reloadedStore.connect(sessionId, recorder).accepted, true);
  await reloadedStore.armRecorder(sessionId, recorder);

  const recovered = reloadedStore.snapshot(sessionId);
  assert.equal(recovered.configuration.runTitle, "Replacement run");
  assert.equal(recovered.configuration.tasks[0]?.id, "replacement-task");
  assert.equal(recovered.run.status, "stopped");
  assert.equal(recovered.run.recordingState, "idle");
  assert.equal(recovered.currentEpisode, null);
  assert.equal(recovered.pendingEpisode, null);
  assert.equal(recovered.episodes.some(({ id }) => id === episode.id), true);
});

test("does not commit recovered state when the recorder storage probe fails", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recovery-probe-failure-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "recovery-probe-failure-session";
  await seedAcceptedPendingJournal(dataRoot, sessionId, 4_200_000);

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const controls: string[] = [];
  capture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  const recorder = recorderConnection("probe-failure-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  const writable = store as unknown as { probeRecorderJournal: () => Promise<void> };
  writable.probeRecorderJournal = async () => {
    throw new RecorderStoreError("write-failed", "simulated recorder journal probe failure");
  };

  await assert.rejects(store.armRecorder(sessionId, recorder), /simulated recorder journal probe failure/);
  const failed = store.snapshot(sessionId);
  assert.equal(failed.currentEpisode, null);
  assert.equal(failed.pendingEpisode, null);
  assert.equal(failed.episodes.length, 0);
  assert.equal(failed.attempts.length, 0);
  assert.equal(controls.includes("recording-started"), false);
});

test("a replaced recorder cannot publish or commit its staged journal recovery", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-stale-arm-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "stale-arm-recovery-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_300_000);

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const controls: string[] = [];
  capture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  const firstRecorder = recorderConnection("stale-arm-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, firstRecorder).accepted, true);

  let releaseRecovery!: () => void;
  let recoveryStarted!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  type ReconcileJournal = (session: unknown, blocks: unknown[]) => Promise<unknown>;
  type PersistEpisode = (session: unknown, episode: Episode) => Promise<void>;
  const writable = store as unknown as {
    reconcileRecorderJournal: ReconcileJournal;
    persistEpisode: PersistEpisode;
  };
  const reconcileRecorderJournal = writable.reconcileRecorderJournal.bind(store);
  const persistEpisode = writable.persistEpisode.bind(store);
  const persistedIntegrities: Episode["integrity"][] = [];
  writable.reconcileRecorderJournal = async (session, blocks) => {
    recoveryStarted();
    await recoveryGate;
    return reconcileRecorderJournal(session, blocks);
  };
  writable.persistEpisode = async (session, episode) => {
    persistedIntegrities.push(episode.integrity);
    await persistEpisode(session, episode);
  };

  const staleArm = store.armRecorder(sessionId, firstRecorder);
  await started;
  await store.disconnect(sessionId, firstRecorder);
  const replacement = recorderConnection("replacement-arm-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, replacement).accepted, true);
  releaseRecovery();
  await assert.rejects(
    staleArm,
    (error: unknown) => error instanceof RecorderStoreError && error.code === "not-capture",
  );
  const unchanged = store.snapshot(sessionId);
  assert.equal(unchanged.currentEpisode, null);
  assert.equal(unchanged.pendingEpisode, null);
  assert.equal(controls.includes("recording-started"), false);
  assert.equal(persistedIntegrities.includes("valid"), false);
  const root = path.join(dataRoot, "sessions", sessionId, "episodes", seeded.episode.id);
  const staleCommit = JSON.parse(await readFile(path.join(root, "episode.commit.json"), "utf8")) as { episode?: Episode };
  assert.equal(staleCommit.episode?.integrity, "pending");

  assert.deepEqual(await store.armRecorder(sessionId, replacement), { nextSequence: 2 });
  assert.equal(store.snapshot(sessionId).currentEpisode?.id, seeded.episode.id);
  assert.equal(controls.includes("recording-started"), true);
  assert.equal(persistedIntegrities.includes("valid"), false);
  const recoveredCommit = JSON.parse(await readFile(path.join(root, "episode.commit.json"), "utf8")) as { episode?: Episode };
  assert.equal(recoveredCommit.episode?.integrity, "pending");

  const crashReload = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const crashCapture = connectReadyCapture(crashReload, sessionId);
  const crashRecorder = recorderConnection("crash-reload-recorder", crashCapture.pairingId!);
  assert.equal(crashReload.connect(sessionId, crashRecorder).accepted, true);
  assert.deepEqual(await crashReload.armRecorder(sessionId, crashRecorder), { nextSequence: 2 });
  assert.equal(crashReload.snapshot(sessionId).currentEpisode?.integrity, "valid");
});

test("recorder supersession preserves the final pre-append boundary and recovers an in-flight append", async (context) => {
  const preAppendRoot = await mkdtemp(path.join(tmpdir(), "ceres-pre-append-authority-"));
  const postAppendRoot = await mkdtemp(path.join(tmpdir(), "ceres-post-append-authority-"));
  context.after(() => Promise.all([
    rm(preAppendRoot, { recursive: true, force: true }),
    rm(postAppendRoot, { recursive: true, force: true }),
  ]));

  const preSessionId = "pre-append-authority-session";
  const preStore = new SessionStore({ dataRoot: preAppendRoot, minimumFreeBytes: 0 });
  const preCapture = connectReadyCapture(preStore, preSessionId);
  const preRecorder = recorderConnection("pre-append-recorder", preCapture.pairingId!);
  assert.equal(preStore.connect(preSessionId, preRecorder).accepted, true);
  await preStore.armRecorder(preSessionId, preRecorder);
  await preStore.control(preSessionId, "start-sequence");
  const preEpisode = preStore.snapshot(preSessionId).pendingEpisode;
  assert.ok(preEpisode);
  const preBlock = encodedBlock(recorderInput(preSessionId, preEpisode.id, 0, 0, 5_100_000));
  type AssertStorageSafe = (additionalBytes?: number) => Promise<void>;
  const preWritable = preStore as unknown as { assertStorageSafe: AssertStorageSafe };
  const assertStorageSafe = preWritable.assertStorageSafe.bind(preStore);
  let releaseStorage!: () => void;
  let storageStarted!: () => void;
  const storageGate = new Promise<void>((resolve) => { releaseStorage = resolve; });
  const storageCheckStarted = new Promise<void>((resolve) => { storageStarted = resolve; });
  preWritable.assertStorageSafe = async (additionalBytes) => {
    await assertStorageSafe(additionalBytes);
    if ((additionalBytes ?? 0) > 0) {
      storageStarted();
      await storageGate;
    }
  };
  const rejectedBeforeAppend = preStore.recordRecorderBlock(
    preSessionId,
    preBlock.decoded,
    preBlock.encoded,
    preRecorder,
  );
  await storageCheckStarted;
  await preStore.disconnect(preSessionId, preRecorder);
  const preReplacement = recorderConnection("pre-append-replacement", preCapture.pairingId!);
  assert.equal(preStore.connect(preSessionId, preReplacement).accepted, true);
  releaseStorage();
  await assert.rejects(
    rejectedBeforeAppend,
    (error: unknown) => error instanceof RecorderStoreError && error.code === "not-capture",
  );
  const preJournal = path.join(preAppendRoot, "sessions", preSessionId, "recorder.blocks");
  assert.equal((await stat(preJournal)).size, 0);
  assert.deepEqual(await preStore.armRecorder(preSessionId, preReplacement), { nextSequence: 0 });

  const postSessionId = "post-append-authority-session";
  const postStore = new SessionStore({ dataRoot: postAppendRoot, minimumFreeBytes: 0 });
  const monitorMessages: string[] = [];
  postStore.connect(postSessionId, {
    id: "post-append-monitor",
    role: "monitor",
    send: (type) => monitorMessages.push(type),
  });
  const postCapture = connectReadyCapture(postStore, postSessionId);
  const postRecorder = recorderConnection("post-append-recorder", postCapture.pairingId!);
  assert.equal(postStore.connect(postSessionId, postRecorder).accepted, true);
  await postStore.armRecorder(postSessionId, postRecorder);
  await postStore.control(postSessionId, "start-sequence");
  const postEpisode = postStore.snapshot(postSessionId).pendingEpisode;
  assert.ok(postEpisode);
  const postBlock = encodedBlock(recorderInput(postSessionId, postEpisode.id, 0, 0, 5_200_000));
  type AppendDurable = (file: string, data: Uint8Array) => Promise<void>;
  const postWritable = postStore as unknown as { appendDurable: AppendDurable };
  const appendDurable = postWritable.appendDurable.bind(postStore);
  let releaseAppend!: () => void;
  let appendStarted!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const durableAppendStarted = new Promise<void>((resolve) => { appendStarted = resolve; });
  postWritable.appendDurable = async (file, data) => {
    await appendDurable(file, data);
    if (file.endsWith("recorder.blocks")) {
      appendStarted();
      await appendGate;
    }
  };
  monitorMessages.length = 0;
  const rejectedAfterAppend = postStore.recordRecorderBlock(
    postSessionId,
    postBlock.decoded,
    postBlock.encoded,
    postRecorder,
  );
  await durableAppendStarted;
  await postStore.disconnect(postSessionId, postRecorder);
  const postReplacement = recorderConnection("post-append-replacement", postCapture.pairingId!);
  assert.equal(postStore.connect(postSessionId, postReplacement).accepted, true);
  releaseAppend();
  await assert.rejects(
    rejectedAfterAppend,
    (error: unknown) => error instanceof RecorderStoreError && error.code === "not-capture",
  );
  postWritable.appendDurable = appendDurable;
  const postJournal = path.join(postAppendRoot, "sessions", postSessionId, "recorder.blocks");
  const sensorPath = path.join(postAppendRoot, "sessions", postSessionId, "episodes", postEpisode.id, "sensors.jsonl");
  assert.deepEqual(await readFile(postJournal), Buffer.from(postBlock.encoded));
  await assert.rejects(readFile(sensorPath), (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  ));
  assert.equal(postStore.snapshot(postSessionId).captureStatus.recorderDurableAckSequence, -1);
  assert.equal(monitorMessages.includes("sensor-frame"), false);

  assert.deepEqual(await postStore.armRecorder(postSessionId, postReplacement), { nextSequence: 1 });
  assert.equal((await postStore.recordRecorderBlock(
    postSessionId,
    postBlock.decoded,
    postBlock.encoded,
    postReplacement,
  )).status, "duplicate");
  assert.equal((await readFile(sensorPath, "utf8")).trim().split("\n").length, 1);
  assert.equal(monitorMessages.includes("sensor-frame"), false);
});

test("truncates only an incomplete final journal block and accepts its retransmission", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-partial-journal-tail-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "partial-journal-tail-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_400_000);
  const retransmission = encodedBlock(recorderInput(sessionId, seeded.episode.id, 2, 1, 4_433_333));
  await appendFile(seeded.journalPath, retransmission.encoded.subarray(0, 17));

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("partial-tail-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await store.armRecorder(sessionId, recorder), { nextSequence: 2 });
  assert.equal((await stat(seeded.journalPath)).size, seeded.start.encoded.byteLength + seeded.frame.encoded.byteLength);
  assert.equal((await store.recordRecorderBlock(
    sessionId,
    retransmission.decoded,
    retransmission.encoded,
    recorder,
  )).status, "durable");
});

test("fails closed on a complete corrupt journal block without truncating it", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-corrupt-journal-block-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "corrupt-journal-block-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_500_000);
  const corrupt = encodeRecorderBlock(recorderInput(sessionId, seeded.episode.id, 2, 1, 4_533_333));
  corrupt[corrupt.byteLength - 1] ^= 0xff;
  await appendFile(seeded.journalPath, corrupt);
  const corruptSize = (await stat(seeded.journalPath)).size;

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("corrupt-block-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  await assert.rejects(
    store.armRecorder(sessionId, recorder),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "checksum-mismatch",
  );
  assert.equal((await stat(seeded.journalPath)).size, corruptSize);
  assert.equal(store.snapshot(sessionId).currentEpisode, null);
});

test("uses committed episode metadata when an uncommitted compatibility view is corrupt", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-episode-commit-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "episode-commit-recovery-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_600_000);
  const root = path.join(dataRoot, "sessions", sessionId, "episodes", seeded.episode.id);
  await writeFile(path.join(root, "episode.json"), "{\"id\":");

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("episode-commit-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await store.armRecorder(sessionId, recorder), { nextSequence: 2 });
  const recovered = store.snapshot(sessionId).currentEpisode;
  assert.equal(recovered?.id, seeded.episode.id);
  assert.equal(recovered?.integrity, "valid");
  assert.equal(recovered?.outcome, "recording");
  assert.equal(recovered?.frameCount, 1);
  assert.equal((JSON.parse(await readFile(path.join(root, "attempt.json"), "utf8")) as Episode).id, seeded.episode.id);
  await assert.rejects(readFile(path.join(root, "episode.json"), "utf8"), (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  ));
  const commit = JSON.parse(await readFile(path.join(root, "episode.commit.json"), "utf8")) as {
    sessionId?: string;
    episodeId?: string;
    episode?: Episode;
  };
  assert.equal(commit.sessionId, sessionId);
  assert.equal(commit.episodeId, seeded.episode.id);
  assert.equal(commit.episode?.integrity, "pending");
});

test("restores a valid active episode as one coherent post-arm recording publication", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-active-episode-recovery-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "active-episode-recovery-session";
  const seedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await seedStore.armRecorder(sessionId);
  const seedCapture = connectReadyCapture(seedStore, sessionId);
  await seedStore.control(sessionId, "start-sequence");
  const pending = seedStore.snapshot(sessionId).pendingEpisode;
  const segment = pending?.segments?.[0];
  assert.ok(pending);
  assert.ok(segment);
  await seedStore.acceptRecording(sessionId, seedCapture, pending.id);
  const start = encodedBlock({
    ...recorderInput(sessionId, pending.id, 0, 0, 5_300_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  const frame = encodedBlock(recorderInput(sessionId, pending.id, 1, 0, 5_300_000));
  await seedStore.recordRecorderBlock(sessionId, start.decoded, start.encoded);
  await seedStore.recordRecorderBlock(sessionId, frame.decoded, frame.encoded);
  assert.equal(seedStore.snapshot(sessionId).currentEpisode?.integrity, "valid");

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const messages: Array<{ type: string; payload: any }> = [];
  capture.send = (type, payload) => messages.push({ type, payload });
  const recorder = recorderConnection("active-recovery-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  messages.length = 0;

  assert.deepEqual(await store.armRecorder(sessionId, recorder), { nextSequence: 2 });
  const recovered = store.snapshot(sessionId);
  assert.equal(recovered.currentEpisode?.id, pending.id);
  assert.equal(recovered.currentEpisode?.integrity, "valid");
  assert.equal(recovered.pendingEpisode, null);
  assert.equal(recovered.recording, true);
  assert.equal(recovered.run.status, "running");
  assert.equal(recovered.run.phase, "active-task");
  assert.equal(recovered.run.recordingState, "recording");
  assert.equal(recovered.run.recordingLatched, true);
  assert.equal(recovered.run.activeTaskIndex, 0);
  assert.equal(recovered.run.cycle, pending.cycle);
  assert.equal(recovered.run.repetition, segment.repetition);
  assert.equal(recovered.run.take, segment.take);
  assert.equal(recovered.captureStatus.recorder, "recording");
  assert.equal(messages.filter((message) => message.type === "control" && message.payload.action === "recording-started").length, 1);
  assert.equal(messages.filter((message) => message.type === "snapshot").length, 1);

  assert.deepEqual(await store.armRecorder(sessionId, recorder), { nextSequence: 2 });
  assert.equal(messages.filter((message) => message.type === "control" && message.payload.action === "recording-started").length, 1);
  assert.equal(messages.filter((message) => message.type === "snapshot").length, 1);
});

for (const transition of ["completed", "stopped"] as const) {
  test(`recovers a committed ${transition} segment while its durable end boundary is pending`, async (context) => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), `ceres-pending-${transition}-boundary-`));
    context.after(() => rm(dataRoot, { recursive: true, force: true }));
    const sessionId = `pending-${transition}-boundary-session`;
    const seedStore = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
    await seedStore.armRecorder(sessionId);
    const seedCapture = connectReadyCapture(seedStore, sessionId);
    await seedStore.control(sessionId, "start-sequence");
    const pending = seedStore.snapshot(sessionId).pendingEpisode;
    const segment = pending?.segments?.[0];
    assert.ok(pending);
    assert.ok(segment);
    await seedStore.acceptRecording(sessionId, seedCapture, pending.id);
    const start = encodedBlock({
      ...recorderInput(sessionId, pending.id, 0, 0, 5_350_000),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent({
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }),
    });
    const frame = encodedBlock(recorderInput(sessionId, pending.id, 1, 0, 5_350_000));
    await seedStore.recordRecorderBlock(sessionId, start.decoded, start.encoded);
    await seedStore.recordRecorderBlock(sessionId, frame.decoded, frame.encoded);

    if (transition === "completed") {
      const writable = seedStore as unknown as {
        sessions: Map<string, unknown>;
        completeCurrentTask(session: unknown): Promise<void>;
      };
      const internalSession = writable.sessions.get(sessionId);
      assert.ok(internalSession);
      await writable.completeCurrentTask(internalSession);
    } else {
      await seedStore.control(sessionId, "stop");
    }
    const committed = seedStore.snapshot(sessionId).currentEpisode;
    assert.equal(committed?.segments?.at(-1)?.outcome, transition);
    assert.equal(committed?.segments?.at(-1)?.endSourceTimestampUs, undefined);

    const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
    const capture = connectReadyCapture(store, sessionId);
    const messages: Array<{ type: string; payload: any }> = [];
    capture.send = (type, payload) => messages.push({ type, payload });
    const recorder = recorderConnection(`pending-${transition}-recorder`, capture.pairingId!);
    assert.equal(store.connect(sessionId, recorder).accepted, true);
    messages.length = 0;

    assert.deepEqual(await store.armRecorder(sessionId, recorder), { nextSequence: 2 });
    const recovered = store.snapshot(sessionId);
    assert.equal(recovered.currentEpisode?.id, pending.id);
    assert.equal(recovered.recording, false);
    assert.equal(recovered.run.recordingState, transition === "completed" ? "paused" : "stopping");
    assert.equal(recovered.run.status, transition === "completed" ? "running" : "stopped");
    assert.equal(recovered.run.phase, transition === "completed" ? "post-task-pause" : null);
    const reissued = messages.filter((message) => (
      message.type === "control"
      && message.payload.action === "recording-event"
      && message.payload.event?.type === "segment-end"
      && message.payload.event.segmentId === segment.id
    ));
    assert.equal(reissued.length, 1);

    const end = encodedBlock({
      ...recorderInput(sessionId, pending.id, 2, 0, 5_450_000),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent({
        type: "segment-end",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }),
    });
    assert.equal((await store.recordRecorderBlock(sessionId, end.decoded, end.encoded, recorder)).status, "durable");
    assert.equal((await store.recordRecorderBlock(sessionId, end.decoded, end.encoded, recorder)).status, "duplicate");
    const runEventsPath = path.join(dataRoot, "sessions", sessionId, "episodes", pending.id, "run-events.jsonl");
    const runEvents = (await readFile(runEventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: { type?: string; segmentId?: string } });
    assert.equal(runEvents.filter((entry) => entry.event?.type === "segment-end" && entry.event.segmentId === segment.id).length, 1);
  });
}

test("serialises episode metadata commits so the newest snapshot remains authoritative", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-episode-commit-order-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "episode-commit-order-session";
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await store.armRecorder(sessionId);
  connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);

  type PersistEpisode = (session: unknown, episode: Episode) => Promise<void>;
  const writable = store as unknown as {
    sessions: Map<string, unknown>;
    persistEpisode: PersistEpisode;
    persistEpisodeNow: PersistEpisode;
  };
  const internalSession = writable.sessions.get(sessionId);
  assert.ok(internalSession);
  const persistEpisodeNow = writable.persistEpisodeNow.bind(store);
  let releaseOlder!: () => void;
  let olderStarted!: () => void;
  const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
  const started = new Promise<void>((resolve) => { olderStarted = resolve; });
  writable.persistEpisodeNow = async (session, candidate) => {
    if (candidate.runDescription === "older snapshot") {
      olderStarted();
      await olderGate;
    }
    await persistEpisodeNow(session, candidate);
  };
  const older = { ...structuredClone(episode), runDescription: "older snapshot" };
  const newer = { ...structuredClone(episode), runDescription: "newer snapshot" };
  const olderWrite = writable.persistEpisode(internalSession, older);
  await started;
  const newerWrite = writable.persistEpisode(internalSession, newer);
  releaseOlder();
  await Promise.all([olderWrite, newerWrite]);

  const root = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id);
  const commit = JSON.parse(await readFile(path.join(root, "episode.commit.json"), "utf8")) as { episode?: Episode };
  assert.equal(commit.episode?.runDescription, "newer snapshot");
});

test("repairs partial sidecar tails and exact media or audio materialisations from the journal", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-materialisation-repair-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "materialisation-repair-session";
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await store.setConfiguration(sessionId, {
    ...structuredClone(defaultConfiguration),
    recordAudio: true,
  });
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const segment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(segment);
  await store.acceptRecording(sessionId, capture, episode.id);
  const start = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 4_700_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  const frame = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, 4_700_000));
  const audioData = Uint8Array.of(5, 6, 7, 8);
  const audio = encodedBlock({
    ...recorderInput(sessionId, episode.id, 2, 0, 4_733_333),
    flags: RecorderBlockFlags.AudioChunk,
    payload: encodeRecorderMediaPayload("audio/webm;codecs=opus", audioData),
  });
  const media = encodedBlock({
    ...recorderInput(sessionId, episode.id, 3, 0, 4_766_666),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(9, 10, 11)),
  });
  for (const block of [start, frame, audio, media]) {
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  }

  const root = path.join(dataRoot, "sessions", sessionId, "episodes", episode.id);
  const sensorPath = path.join(root, "sensors.jsonl");
  const runEventPath = path.join(root, "run-events.jsonl");
  const audioPath = path.join(root, "audio", "0000000002.webm");
  const mediaPath = path.join(root, "video", "recorder-chunks", "0000000003.block");
  const completeUnterminatedSensorRecord = (await readFile(sensorPath, "utf8")).trim();
  await appendFile(sensorPath, completeUnterminatedSensorRecord);
  await appendFile(runEventPath, "{\"sequence\":");
  await writeFile(audioPath, Uint8Array.of(5));
  await writeFile(mediaPath, media.decoded.payload.subarray(0, 3));

  const reloaded = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloaded, sessionId);
  const recorder = recorderConnection("materialisation-repair-recorder", reloadedCapture.pairingId!);
  assert.equal(reloaded.connect(sessionId, recorder).accepted, true);
  assert.deepEqual(await reloaded.armRecorder(sessionId, recorder), { nextSequence: 4 });
  assert.deepEqual(await readFile(audioPath), Buffer.from(audioData));
  assert.deepEqual(await readFile(mediaPath), Buffer.from(media.decoded.payload));
  assert.equal((await readFile(sensorPath, "utf8")).trim().split("\n").length, 1);
  assert.equal((await readFile(runEventPath, "utf8")).trim().split("\n").length, 1);
});

test("scans each recorder sidecar once and rejects complete extra, duplicate or reordered rows", async (context) => {
  const roots: string[] = [];
  context.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const seedThreeBlocks = async (label: string, timestampUs: number) => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), `ceres-sidecar-${label}-`));
    roots.push(dataRoot);
    const sessionId = `sidecar-${label}-session`;
    const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, timestampUs);
    const secondFrame = encodedBlock(recorderInput(sessionId, seeded.episode.id, 2, 1, timestampUs + 33_333));
    await appendFile(seeded.journalPath, secondFrame.encoded);
    return { dataRoot, sessionId, seeded };
  };

  const scanCase = await seedThreeBlocks("scan-count", 5_400_000);
  const scanStore = new SessionStore({ dataRoot: scanCase.dataRoot, minimumFreeBytes: 0 });
  const scanCapture = connectReadyCapture(scanStore, scanCase.sessionId);
  const scanRecorder = recorderConnection("scan-count-recorder", scanCapture.pairingId!);
  assert.equal(scanStore.connect(scanCase.sessionId, scanRecorder).accepted, true);
  type ReadRepairableJsonLines = (file: string) => Promise<unknown[]>;
  const scanWritable = scanStore as unknown as { readRepairableJsonLines: ReadRepairableJsonLines };
  const readRepairableJsonLines = scanWritable.readRepairableJsonLines.bind(scanStore);
  const scans = new Map<string, number>();
  scanWritable.readRepairableJsonLines = async (file) => {
    const name = path.basename(file);
    scans.set(name, (scans.get(name) ?? 0) + 1);
    return readRepairableJsonLines(file);
  };
  assert.deepEqual(await scanStore.armRecorder(scanCase.sessionId, scanRecorder), { nextSequence: 3 });
  assert.deepEqual(Object.fromEntries(scans), {
    "run-events.jsonl": 1,
    "sensors.jsonl": 1,
  });

  for (const corruption of ["unknown-extra", "duplicate", "reordered"] as const) {
    const candidate = await seedThreeBlocks(corruption, 5_500_000 + roots.length * 100_000);
    const materialiser = new SessionStore({ dataRoot: candidate.dataRoot, minimumFreeBytes: 0 });
    const materialiserCapture = connectReadyCapture(materialiser, candidate.sessionId);
    const materialiserRecorder = recorderConnection(`${corruption}-materialiser`, materialiserCapture.pairingId!);
    assert.equal(materialiser.connect(candidate.sessionId, materialiserRecorder).accepted, true);
    assert.deepEqual(await materialiser.armRecorder(candidate.sessionId, materialiserRecorder), { nextSequence: 3 });
    const sensorPath = path.join(
      candidate.dataRoot,
      "sessions",
      candidate.sessionId,
      "episodes",
      candidate.seeded.episode.id,
      "sensors.jsonl",
    );
    const lines = (await readFile(sensorPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    if (corruption === "unknown-extra") {
      await appendFile(sensorPath, `${JSON.stringify({ recorder: { sequence: 999 }, unknown: true })}\n`);
    } else if (corruption === "duplicate") {
      await appendFile(sensorPath, `${lines[0]}\n`);
    } else {
      await writeFile(sensorPath, `${[...lines].reverse().join("\n")}\n`);
    }

    const rejectingStore = new SessionStore({ dataRoot: candidate.dataRoot, minimumFreeBytes: 0 });
    const rejectingCapture = connectReadyCapture(rejectingStore, candidate.sessionId);
    const rejectingRecorder = recorderConnection(`${corruption}-rejecting-recorder`, rejectingCapture.pairingId!);
    assert.equal(rejectingStore.connect(candidate.sessionId, rejectingRecorder).accepted, true);
    await assert.rejects(
      rejectingStore.armRecorder(candidate.sessionId, rejectingRecorder),
      (error: unknown) => error instanceof RecorderStoreError
        && error.code === "write-failed"
        && /sidecar/.test(error.message),
    );
  }
});

test("does not append lossy sensor rows while the recorder is disconnected", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-disconnected-lossy-sensor-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "disconnected-lossy-sensor-session";
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("lossy-sensor-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  await store.armRecorder(sessionId, recorder);
  await store.control(sessionId, "start-sequence");
  const pending = store.snapshot(sessionId).pendingEpisode;
  const segment = pending?.segments?.[0];
  assert.ok(pending);
  assert.ok(segment);
  await store.acceptRecording(sessionId, capture, pending.id);
  const start = encodedBlock({
    ...recorderInput(sessionId, pending.id, 0, 0, 5_900_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  const durableFrame = encodedBlock(recorderInput(sessionId, pending.id, 1, 0, 5_900_000));
  await store.recordRecorderBlock(sessionId, start.decoded, start.encoded, recorder);
  await store.recordRecorderBlock(sessionId, durableFrame.decoded, durableFrame.encoded, recorder);
  const sensorPath = path.join(dataRoot, "sessions", sessionId, "episodes", pending.id, "sensors.jsonl");
  const before = await readFile(sensorPath);
  assert.equal(store.snapshot(sessionId).currentEpisode?.frameCount, 1);

  await store.disconnect(sessionId, recorder);
  await store.recordFrame(sessionId, capture, {
    timestampMs: 5_933,
    frameIndex: 99,
    head: null,
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  });
  assert.deepEqual(await readFile(sensorPath), before);
  assert.equal(store.snapshot(sessionId).currentEpisode?.frameCount, 1);

  const replacement = recorderConnection("lossy-sensor-replacement", capture.pairingId!);
  assert.equal(store.connect(sessionId, replacement).accepted, true);
  assert.deepEqual(await store.armRecorder(sessionId, replacement), { nextSequence: 2 });
  assert.deepEqual(await readFile(sensorPath), before);

  const reloaded = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const reloadedCapture = connectReadyCapture(reloaded, sessionId);
  const reloadedRecorder = recorderConnection("lossy-sensor-reloaded", reloadedCapture.pairingId!);
  assert.equal(reloaded.connect(sessionId, reloadedRecorder).accepted, true);
  assert.deepEqual(await reloaded.armRecorder(sessionId, reloadedRecorder), { nextSequence: 2 });
  assert.equal((await readFile(sensorPath, "utf8")).trim().split("\n").length, 1);
  assert.equal(reloaded.snapshot(sessionId).currentEpisode?.frameCount, 1);
});

test("rejects recorder frame discontinuity while loading a complete journal", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-reload-frame-continuity-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "reload-frame-continuity-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_800_000);
  const skippedFrame = encodeRecorderBlock(recorderInput(sessionId, seeded.episode.id, 2, 2, 4_833_333));
  await appendFile(seeded.journalPath, skippedFrame);

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("frame-continuity-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  await assert.rejects(
    store.armRecorder(sessionId, recorder),
    (error: unknown) => error instanceof RecorderStoreError
      && error.code === "out-of-order"
      && /frame index 2/.test(error.message),
  );
  assert.equal(store.snapshot(sessionId).currentEpisode, null);
});

test("rejects a backwards source timestamp while loading a complete journal", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-reload-timestamp-continuity-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "reload-timestamp-continuity-session";
  const seeded = await seedAcceptedPendingJournal(dataRoot, sessionId, 4_900_000);
  const backwards = encodeRecorderBlock({
    ...recorderInput(sessionId, seeded.episode.id, 2, 1, 4_899_999),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(1)),
  });
  await appendFile(seeded.journalPath, backwards);

  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const capture = connectReadyCapture(store, sessionId);
  const recorder = recorderConnection("timestamp-continuity-recorder", capture.pairingId!);
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  await assert.rejects(
    store.armRecorder(sessionId, recorder),
    (error: unknown) => error instanceof RecorderStoreError
      && error.code === "out-of-order"
      && /timestamps must not move backwards/.test(error.message),
  );
  assert.equal(store.snapshot(sessionId).currentEpisode, null);
});

test("materialises binary media once but excludes a zero-frame attempt from accepted episodes", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-media-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "media-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);
  const first = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, 5_000_000),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(1, 2, 3)),
  });
  const second = encodedBlock({
    ...recorderInput(sessionId, episode.id, 1, 0, 5_000_000),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(4, 5)),
  });
  await store.recordRecorderBlock(sessionId, first.decoded, first.encoded);
  await store.control(sessionId, "stop");
  await store.recordRecorderBlock(sessionId, second.decoded, second.encoded);
  await finaliseRequestedStop(store, sessionId, capture);
  assert.equal((await store.recordRecorderBlock(sessionId, second.decoded, second.encoded)).status, "duplicate");
  const video = await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "video", "passthrough.webm"));
  assert.deepEqual([...video], [1, 2, 3, 4, 5]);
  assert.equal(store.snapshot(sessionId).episodes.length, 0);
  assert.equal(store.snapshot(sessionId).attempts[0].mediaChunkCount, 2);
  assert.equal(store.snapshot(sessionId).attempts[0].integrity, "interrupted");
  assert.equal(store.snapshot(sessionId).captureStatus.recorder, "armed");
});

test("normalises cycles, repetitions and legacy set counts into the canonical task model", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-task-model-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const configuration = structuredClone(defaultConfiguration);
  const configuredTask = configuration.tasks[0];
  configuration.totalCycles = 2.8;
  assert.notEqual(configuredTask.type, "pause");
  if (configuredTask.type === "pause") return;
  configuredTask.repeatCount = 2.8;
  configuredTask.resetTimeS = -4;
  await store.setConfiguration("task-model-session", configuration);

  const normalised = store.snapshot("task-model-session").configuration;
  assert.equal(normalised.totalCycles, 2);
  const task = normalised.tasks[0];
  assert.notEqual(task.type, "pause");
  if (task.type === "pause") return;
  assert.equal(task.repeatCount, 2);
  assert.equal(task.resetTimeS, 5);
  assert.equal("setCount" in task, false);
  assert.equal("repeatMode" in task, false);
  assert.equal("holdAfterEach" in task, false);

  configuredTask.repeatCount = 0;
  await store.setConfiguration("task-model-session", configuration);
  const minimumTask = store.snapshot("task-model-session").configuration.tasks[0];
  assert.notEqual(minimumTask.type, "pause");
  if (minimumTask.type !== "pause") assert.equal(minimumTask.repeatCount, 1);

  await store.setConfiguration("legacy-task-model-session", {
    ...structuredClone(defaultConfiguration),
    tasks: [{
      id: "legacy-task",
      label: "Legacy task",
      instructions: "Flatten the old set count",
      type: "open",
      repeatCount: 2,
      resetTimeS: 1,
      setCount: 3,
      repeatMode: "attempts",
      holdAfterEach: true,
    }],
  } as typeof defaultConfiguration);
  const legacyTask = store.snapshot("legacy-task-model-session").configuration.tasks[0];
  assert.notEqual(legacyTask.type, "pause");
  if (legacyTask.type === "pause") return;
  assert.equal(legacyTask.repeatCount, 6);
  assert.equal("setCount" in legacyTask, false);
});

test("persists configuration before capture joins and requires the matching applied acknowledgement", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-configuration-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessionId = "configuration-session";
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const configuration = structuredClone(defaultConfiguration);
  configuration.runTitle = "Persistent run";
  configuration.runDescription = "Configuration exists before the demonstrator joins";
  configuration.tasks = [{
    id: "task-open-stable",
    label: "Open placement",
    instructions: "Continue until stopped",
    type: "open",
    repeatCount: 2,
    resetTimeS: 5,
  }];
  await store.setConfiguration(sessionId, configuration);

  const persisted = JSON.parse(await readFile(path.join(dataRoot, "sessions", sessionId, "configuration.json"), "utf8"));
  assert.equal(persisted.schema, "ceres-capture-configuration-v2");
  assert.equal(persisted.revision, 2);
  assert.equal(persisted.configuration.runTitle, "Persistent run");
  assert.equal("durationS" in persisted.configuration.tasks[0], false);

  const restored = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  assert.equal(restored.snapshot(sessionId).configuration.runTitle, "Persistent run");
  assert.equal(restored.snapshot(sessionId).configurationStatus.state, "sent");
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: "capture-configuration-one",
    role: "capture",
    pairingId: "configuration-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  restored.connect(sessionId, capture);
  restored.requestCaptureIntent(sessionId, capture);
  const deliveries = messages.filter((message) => message.type === "configuration");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].payload.revision, 2);
  assert.equal(deliveries[0].payload.configuration.tasks[0].id, "task-open-stable");
  assert.equal(restored.snapshot(sessionId).configurationStatus.state, "sent");

  restored.acknowledgeConfiguration(sessionId, capture, deliveries[0].payload.revision, deliveries[0].payload.checksum);
  assert.equal(restored.snapshot(sessionId).configurationStatus.state, "applied");
  assert.equal(restored.snapshot(sessionId).configurationStatus.appliedRevision, 2);

  restored.disconnect(sessionId, capture);
  const reconnectMessages: Array<{ type: string; payload: any }> = [];
  const reconnect: SessionConnection = {
    id: "capture-configuration-two",
    role: "capture",
    pairingId: "configuration-pairing",
    send: (type, payload) => reconnectMessages.push({ type, payload }),
  };
  restored.connect(sessionId, reconnect);
  restored.requestCaptureIntent(sessionId, reconnect);
  assert.equal(reconnectMessages.filter((message) => message.type === "configuration").length, 1);
  assert.equal(restored.snapshot(sessionId).configurationStatus.state, "sent");
});

test("starts only after capture, configuration and durable recorder readiness, then holds TAKE until the first durable slot", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-run-start-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "run-start-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [{
    id: "timed-first-task",
    label: "Timed first task",
    instructions: "Start immediately",
    type: "timed",
    durationS: 60,
    repeatCount: 1,
    resetTimeS: 0,
  }];
  await store.setConfiguration(sessionId, configuration);

  assert.deepEqual(
    new Set(store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code)),
    new Set(["capture-disconnected", "configuration-not-applied", "recorder-not-armed"]),
  );
  await assert.rejects(store.control(sessionId, "start-sequence"), /capture client is disconnected/i);
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: "run-start-capture",
    role: "capture",
    pairingId: "run-start-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  store.activateCaptureAuthority(sessionId, capture);
  assert.deepEqual(
    store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code),
    ["configuration-not-applied", "recorder-not-armed"],
  );
  await store.armRecorder(sessionId);
  assert.deepEqual(
    store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code),
    ["configuration-not-applied"],
  );
  await assert.rejects(store.control(sessionId, "start-sequence"), /has not applied the current run configuration/i);
  const configurationDelivery = messages.find((message) => message.type === "configuration")?.payload;
  assert.ok(configurationDelivery);
  store.acknowledgeConfiguration(
    sessionId,
    capture,
    configurationDelivery.revision,
    configurationDelivery.checksum,
  );
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, true);
  messages.length = 0;
  await store.control(sessionId, "start-sequence");
  const started = store.snapshot(sessionId);
  assert.equal(started.run.status, "running");
  assert.equal(started.run.phase, null);
  assert.equal(started.run.recordingState, "arming");
  assert.ok(started.pendingEpisode);
  assert.equal(started.run.activeTaskIndex, 0);
  assert.equal(started.run.cycle, 1);
  assert.equal(started.run.repetition, 1);
  assert.ok(started.run.startedAtMs !== null);
  assert.equal(started.run.takeStartedAtMs, null);
  assert.equal(started.run.takeElapsedMs, 0);
  assert.equal(started.run.recordingElapsedMs, 0);
  assert.equal(started.sequenceReadiness.blockers[0]?.code, "sequence-active");
  assert.deepEqual(
    messages.filter(({ type }) => type === "control").map(({ payload }) => payload.action),
    ["recording-arming", "recording-event"],
  );
  await assert.rejects(store.setConfiguration(sessionId, configuration), /cannot change while the run is active/);

  await delay(30);
  const ticking = store.snapshot(sessionId);
  assert.ok(sessionElapsedMs(ticking.run) > 0);
  assert.equal(takeElapsedMs(ticking.run), 0);
  assert.equal(timedTaskRemainingMs(ticking.run, 60_000), 60_000);

  await store.acceptRecording(sessionId, capture, started.pendingEpisode!.id);
  assert.equal(store.snapshot(sessionId).run.phase, null);
  const firstSegment = started.pendingEpisode!.segments?.[0];
  assert.ok(firstSegment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, started.pendingEpisode!.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: firstSegment.id,
      taskId: firstSegment.taskId,
      taskLabel: firstSegment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const firstSlot = encodedBlock(recorderInput(sessionId, started.pendingEpisode!.id, 1, 0, 1_000_000));
  await store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded);
  const recording = store.snapshot(sessionId);
  assert.equal(recording.run.phase, "active-task");
  assert.equal(recording.run.recordingState, "recording");
  assert.ok(recording.run.takeStartedAtMs !== null);
  assert.deepEqual(
    messages.filter(({ type }) => type === "control").map(({ payload }) => payload.action),
    ["recording-arming", "recording-event", "recording-started", "sequence-started"],
  );

  await store.control(sessionId, "stop");
  assert.equal(store.snapshot(sessionId).run.status, "running");
  assert.equal(store.snapshot(sessionId).run.recordingState, "stopping");
  await store.finaliseRecording(sessionId, capture, started.pendingEpisode!.id);
  await store.setConfiguration(sessionId, { ...configuration, runTitle: "Editable again" });
  assert.equal(store.snapshot(sessionId).configuration.runTitle, "Editable again");
  assert.deepEqual(
    store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code),
    ["configuration-not-applied", "recorder-not-armed"],
  );
  const reconfigurationDelivery = messages.filter((message) => message.type === "configuration").at(-1)?.payload;
  assert.ok(reconfigurationDelivery);
  store.acknowledgeConfiguration(
    sessionId,
    capture,
    reconfigurationDelivery.revision,
    reconfigurationDelivery.checksum,
  );
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, false);
  await store.armRecorder(sessionId);
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, true);
});

test("requires capture, applied configuration and an armed recorder before run start", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-record-readiness-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "record-readiness-session";
  const initialCodes = new Set(store.snapshot(sessionId).recordingReadiness.blockers.map((blocker) => blocker.code));
  assert.deepEqual(initialCodes, new Set([
    "capture-disconnected",
    "configuration-not-applied",
    "recorder-not-armed",
    "sequence-not-started",
    "run-not-ready",
  ]));

  const initialSequenceCodes = new Set(store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code));
  assert.deepEqual(initialSequenceCodes, new Set([
    "capture-disconnected",
    "configuration-not-applied",
    "recorder-not-armed",
  ]));
  await assert.rejects(store.control(sessionId, "start-sequence"), /Sequence is not ready/);
  assert.equal(store.snapshot(sessionId).run.status, "stopped");

  const capture = connectReadyCapture(store, sessionId);
  assert.deepEqual(store.snapshot(sessionId).sequenceReadiness.blockers.map((blocker) => blocker.code), ["recorder-not-armed"]);
  await store.armRecorder(sessionId);
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, true);
  await store.control(sessionId, "start-sequence");
  assert.equal(store.snapshot(sessionId).run.status, "running");
  assert.equal(store.snapshot(sessionId).recordingReadiness.ready, false);
  assert.equal(store.snapshot(sessionId).run.recordingState, "arming");

  const monitor: SessionConnection = { id: "spoofing-monitor", role: "monitor", send: () => undefined };
  await assert.rejects(
    store.setCaptureStatus(sessionId, monitor, { ...defaultCaptureStatus, camera: "ready", xr: "active" }),
    /Only the selected capture client/,
  );
  await store.disconnect(sessionId, capture);
});

test("a pause-only server configuration cannot start", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-pause-only-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "pause-only-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [{
    id: "pause-only",
    label: "Pause only",
    instructions: "Reset",
    type: "pause",
    durationS: 1,
  }];
  await store.setConfiguration(sessionId, configuration);
  connectReadyCapture(store, sessionId);
  await store.armRecorder(sessionId);

  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, false);
  assert.deepEqual(store.snapshot(sessionId).sequenceReadiness.blockers.map(({ code }) => code), ["no-task"]);
  await assert.rejects(store.control(sessionId, "start-sequence"), /no recordable tasks/i);
});

test("does not run a timed task deadline until recording is accepted and durable", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-unrecorded-timed-expiry-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "unrecorded-timed-expiry";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [{
    id: "short-timed-task",
    label: "Short timed task",
    instructions: "Record this task before its deadline",
    type: "timed",
    durationS: 0.05,
    repeatCount: 1,
    resetTimeS: 1,
  }];
  await store.setConfiguration(sessionId, configuration);
  const capture = connectReadyCapture(store, sessionId);
  await store.armRecorder(sessionId);

  await store.control(sessionId, "start-sequence");
  const pending = store.snapshot(sessionId).pendingEpisode;
  assert.ok(pending);
  await delay(100);
  assert.equal(store.snapshot(sessionId).run.phase, null);
  assert.equal(store.snapshot(sessionId).run.takeStartedAtMs, null);
  assert.equal(store.snapshot(sessionId).pendingEpisode?.segments?.[0]?.outcome, "recording");

  await store.acceptRecording(sessionId, capture, pending.id);
  await delay(100);
  assert.equal(store.snapshot(sessionId).run.phase, null);
  assert.equal(store.snapshot(sessionId).run.takeStartedAtMs, null);

  const segment = pending.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, pending.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const firstSlot = encodedBlock(recorderInput(sessionId, pending.id, 1, 0, 1_000_000));
  await store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded);
  assert.equal(store.snapshot(sessionId).run.phase, "active-task");
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  await waitFor(() => store.snapshot(sessionId).run.phase === "post-task-pause");

  const expired = store.snapshot(sessionId);
  assert.ok(expired.run.takeElapsedMs >= 40);
  assert.equal(expired.currentEpisode?.segments?.[0]?.outcome, "completed");
});

test("retains a gap-only cycle as an interrupted attempt when optional modalities are absent", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-optional-modalities-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "optional-modalities-session";
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: "optional-modalities-capture",
    role: "capture",
    pairingId: "optional-modalities-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  store.connect(sessionId, capture);
  store.requestCaptureIntent(sessionId, capture);
  const configuration = messages.find((message) => message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(sessionId, capture, configuration.revision, configuration.checksum);
  store.activateCaptureAuthority(sessionId, capture);
  await store.setCaptureStatus(sessionId, capture, {
    ...defaultCaptureStatus,
    camera: "idle",
    xr: "ended",
    handTracking: "unavailable",
    sensorRateHz: 0,
    lastFrameAt: null,
  });
  await store.armRecorder(sessionId);
  await store.control(sessionId, "start-sequence");
  assert.equal(store.snapshot(sessionId).run.recordingState, "arming");

  await store.control(sessionId, "start");
  const pending = store.snapshot(sessionId).pendingEpisode;
  assert.ok(pending);
  await store.acceptRecording(sessionId, capture, pending.id);
  const segment = pending.segments?.[0];
  assert.ok(segment);
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, pending.id, 0, 0, 1_000_000),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const gap = encodedBlock({
    ...recorderInput(sessionId, pending.id, 1, 0, 1_000_000),
    flags: RecorderBlockFlags.Gap,
    payload: new TextEncoder().encode("xr-callback-timeout"),
  });
  await store.recordRecorderBlock(sessionId, gap.decoded, gap.encoded);
  const recording = store.snapshot(sessionId);
  assert.equal(recording.run.recordingState, "recording");
  assert.equal(recording.currentEpisode?.id, pending.id);
  assert.equal(recording.currentEpisode?.frameCount, 0);
  assert.equal(recording.currentEpisode?.gapCount, 1);

  await store.setCaptureStatus(sessionId, capture, {
    ...recording.captureStatus,
    camera: "error",
    xr: "ended",
    handTracking: "unavailable",
    sensorRateHz: 0,
    lastFrameAt: null,
  });
  const stillRecording = store.snapshot(sessionId);
  assert.equal(stillRecording.run.status, "running");
  assert.equal(stillRecording.run.recordingState, "recording");
  assert.equal(stillRecording.currentEpisode?.id, pending.id);

  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.recordingState, "stopping");
  await finaliseRequestedStop(store, sessionId, capture);
  assert.equal(store.snapshot(sessionId).run.phase, "cycle-pause");
  await store.control(sessionId, "next-task");
  const completed = store.snapshot(sessionId);
  assert.equal(completed.run.status, "complete");
  assert.equal(completed.episodes.length, 0);
  assert.equal(completed.attempts.length, 1);
  assert.equal(completed.attempts[0].id, pending.id);
  assert.equal(completed.attempts[0].outcome, "stopped");
  assert.equal(completed.attempts[0].accepted, false);
  assert.equal(completed.attempts[0].integrity, "interrupted");
  assert.match(completed.attempts[0].integrityReason ?? "", /durable sensor frame/i);
  assert.equal(completed.attempts[0].frameCount, 0);
  assert.equal(completed.attempts[0].gapCount, 1);
  assert.equal(completed.attempts[0].recorderSlotCount, 1);
  assert.equal(completed.attempts[0].segments?.[0]?.recorderSlotCount, 1);
  assert.equal(completed.attempts[0].segments?.[0]?.accepted, false);
});

test("switches provisional capture intent without binding until the XR race is won", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-provisional-capture-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "provisional-capture-race";
  const firstMessages: string[] = [];
  const secondMessages: string[] = [];
  const firstCloses: number[] = [];
  const secondCloses: number[] = [];
  const first: SessionConnection = {
    id: "provisional-first",
    role: "capture",
    pairingId: "provisional-pairing-one",
    send: (type) => firstMessages.push(type),
    close: (code) => firstCloses.push(code),
  };
  const second: SessionConnection = {
    id: "provisional-second",
    role: "capture",
    pairingId: "provisional-pairing-two",
    send: (type) => secondMessages.push(type),
    close: (code) => secondCloses.push(code),
  };

  assert.equal(store.connect(sessionId, first).accepted, true);
  assert.equal(store.connect(sessionId, second).accepted, true);
  assert.equal(store.snapshot(sessionId).captureConnected, false);
  store.requestCaptureIntent(sessionId, first);
  const recorderCloses: number[] = [];
  const recorder: SessionConnection = {
    id: "provisional-recorder-one",
    role: "recorder",
    pairingId: first.pairingId,
    send: () => undefined,
    close: (code) => recorderCloses.push(code),
  };
  assert.equal(store.connect(sessionId, recorder).accepted, true);
  await store.armRecorder(sessionId, recorder);
  assert.equal(store.isActiveRecorder(sessionId, recorder), true);
  assert.deepEqual(store.requestCaptureIntent(sessionId, second), { accepted: true, alreadyActive: false });
  assert.deepEqual(recorderCloses, [4401]);
  assert.equal(store.isActiveRecorder(sessionId, recorder), false);
  assert.equal(firstMessages.includes("capture-intent-suspended"), true);
  assert.equal(secondMessages.includes("capture-intent-granted"), true);
  const firstConfigurationCount = firstMessages.filter((type) => type === "configuration").length;
  const secondConfigurationCount = secondMessages.filter((type) => type === "configuration").length;
  await store.setConfiguration(sessionId, {
    ...defaultConfiguration,
    runTitle: "Provisional configuration update",
  });
  assert.equal(firstMessages.filter((type) => type === "configuration").length, firstConfigurationCount);
  assert.equal(secondMessages.filter((type) => type === "configuration").length, secondConfigurationCount + 1);
  assert.deepEqual(store.activateCaptureAuthority(sessionId, second), { accepted: true, alreadyActive: false });
  assert.deepEqual(firstCloses, [4401]);
  assert.deepEqual(secondCloses, []);
  assert.equal(store.snapshot(sessionId).captureConnected, true);
  assert.deepEqual(store.activateCaptureAuthority(sessionId, first), {
    accepted: false,
    code: "capture-already-paired",
    message: "This QR session is already paired with another capture tab",
  });
});

test("keeps capture tabs provisional until one enters XR and preserves that pairing on reconnect", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-capture-pairing-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "capture-pairing-session";
  const firstMessages: Array<{ type: string; payload: any }> = [];
  const replacementMessages: Array<{ type: string; payload: any }> = [];
  const rejectedMessages: Array<{ type: string; payload: any }> = [];
  const monitorMessages: Array<{ type: string; payload: any }> = [];
  const firstCloses: Array<{ code: number; reason: string }> = [];
  const replacementCloses: Array<{ code: number; reason: string }> = [];
  const rejectedCloses: Array<{ code: number; reason: string }> = [];
  const malformed: SessionConnection = {
    id: "malformed-capture-device",
    role: "capture",
    pairingId: 42 as unknown as string,
    send: () => undefined,
  };
  const first: SessionConnection = {
    id: "first-capture-socket",
    role: "capture",
    pairingId: "paired-quest-tab",
    send: (type, payload) => firstMessages.push({ type, payload }),
    close: (code, reason) => firstCloses.push({ code, reason }),
  };
  const replacement: SessionConnection = {
    id: "replacement-capture-socket",
    role: "capture",
    pairingId: "paired-quest-tab",
    send: (type, payload) => replacementMessages.push({ type, payload }),
    close: (code, reason) => replacementCloses.push({ code, reason }),
  };
  const rejected: SessionConnection = {
    id: "different-capture-device",
    role: "capture",
    pairingId: "different-quest-tab",
    send: (type, payload) => rejectedMessages.push({ type, payload }),
    close: (code, reason) => rejectedCloses.push({ code, reason }),
  };
  const monitor: SessionConnection = {
    id: "capture-director",
    role: "monitor",
    send: (type, payload) => monitorMessages.push({ type, payload }),
  };

  assert.deepEqual(store.connect(sessionId, malformed), {
    accepted: false,
    code: "capture-pairing-required",
    message: "The capture tab did not provide a valid pairing identity",
  });
  assert.deepEqual(store.connect(sessionId, first), {
    accepted: true,
    replacedConnectionIds: [],
    captureIntentGranted: true,
  });
  assert.deepEqual(store.requestCaptureIntent(sessionId, first), { accepted: true, alreadyActive: false });
  const firstConfiguration = firstMessages.find((message) => message.type === "configuration")?.payload;
  assert.ok(firstConfiguration);
  store.acknowledgeConfiguration(sessionId, first, firstConfiguration.revision, firstConfiguration.checksum);
  await store.setCaptureStatus(sessionId, first, {
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    transport: "connected",
  });
  assert.deepEqual(store.activateCaptureAuthority(sessionId, first), { accepted: true, alreadyActive: false });
  store.connect(sessionId, monitor);

  assert.deepEqual(store.connect(sessionId, rejected), {
    accepted: false,
    code: "capture-already-paired",
    message: "This QR session is already paired with another capture tab",
  });
  assert.equal(rejectedMessages.length, 0);
  assert.equal(store.snapshot(sessionId).captureConnected, true);

  assert.deepEqual(store.connect(sessionId, replacement), {
    accepted: false,
    retryable: true,
    message: "The paired capture tab is still connected",
  });
  assert.deepEqual(firstCloses, []);
  assert.equal(replacementMessages.length, 0);
  assert.equal(store.snapshot(sessionId).captureConnected, true);

  await store.disconnect(sessionId, first);
  assert.deepEqual(store.connect(sessionId, replacement), {
    accepted: true,
    replacedConnectionIds: [],
    captureIntentGranted: true,
  });
  assert.deepEqual(store.requestCaptureIntent(sessionId, replacement), { accepted: true, alreadyActive: false });
  const replacementConfiguration = replacementMessages.find((message) => message.type === "configuration")?.payload;
  assert.ok(replacementConfiguration);
  store.acknowledgeConfiguration(
    sessionId,
    replacement,
    replacementConfiguration.revision,
    replacementConfiguration.checksum,
  );
  await store.setCaptureStatus(sessionId, replacement, {
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    transport: "connected",
  });
  assert.deepEqual(store.activateCaptureAuthority(sessionId, replacement), { accepted: true, alreadyActive: false });
  assert.throws(() => store.acknowledgeConfiguration(
    sessionId,
    first,
    replacementConfiguration.revision,
    replacementConfiguration.checksum,
  ), /Only the selected capture client/);

  firstMessages.length = 0;
  replacementMessages.length = 0;
  store.requestOffer(sessionId, monitor);
  assert.equal(firstMessages.some((message) => message.type === "webrtc-request-offer"), false);
  assert.deepEqual(replacementMessages.find((message) => message.type === "webrtc-request-offer")?.payload, { peerId: monitor.id });
  const answer = { description: { type: "answer", sdp: "v=0" } };
  store.relayWebRtc(sessionId, monitor, monitor.id, answer);
  assert.equal(firstMessages.some((message) => message.type === "webrtc-signal"), false);
  assert.deepEqual(replacementMessages.find((message) => message.type === "webrtc-signal")?.payload, { peerId: monitor.id, signal: answer });

  await store.armRecorder(sessionId);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start", monitor);
  const pending = store.snapshot(sessionId).pendingEpisode;
  assert.ok(pending);
  await assert.rejects(store.acceptRecording(sessionId, first, pending.id), /Only the active capture client/);
  await assert.rejects(store.acceptRecording(sessionId, rejected, pending.id), /Only the active capture client/);
  await store.acceptRecording(sessionId, replacement, pending.id);
  const segment = pending.segments?.[0];
  assert.ok(segment);
  const sourceTimestampUs = Date.now() * 1_000;
  const segmentStart = encodedBlock({
    ...recorderInput(sessionId, pending.id, 0, 0, sourceTimestampUs),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, segmentStart.decoded, segmentStart.encoded);
  const block = encodedBlock(recorderInput(sessionId, pending.id, 1, 0, sourceTimestampUs));
  await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");

  const reconnectMessages: Array<{ type: string; payload: any }> = [];
  const reconnect: SessionConnection = {
    id: "recording-reconnect-socket",
    role: "capture",
    pairingId: "paired-quest-tab",
    send: (type, payload) => reconnectMessages.push({ type, payload }),
  };
  assert.deepEqual(store.connect(sessionId, reconnect), {
    accepted: false,
    retryable: true,
    message: "The paired capture tab is still connected",
  });
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  assert.equal(store.snapshot(sessionId).currentEpisode?.id, pending.id);
  assert.equal(reconnectMessages.length, 0);
  await store.control(sessionId, "stop", monitor);
  await finaliseRequestedStop(store, sessionId, replacement);
  assert.equal(store.snapshot(sessionId).run.status, "stopped");
});

test("admits only one live paired recorder and reconnects after it closes", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-pairing-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "recorder-pairing-session";
  const unpaired = recorderConnection("unpaired-recorder", "capture-tab-one");
  assert.deepEqual(store.connect(sessionId, unpaired), {
    accepted: false,
    code: "recorder-pairing-pending",
    message: "The recorder cannot connect before its capture tab has paired",
  });

  const capture: SessionConnection = {
    id: "paired-capture",
    role: "capture",
    pairingId: "capture-tab-one",
    send: () => undefined,
  };
  assert.equal(store.connect(sessionId, capture).accepted, true);
  store.requestCaptureIntent(sessionId, capture);
  assert.deepEqual(store.connect(sessionId, { id: "missing-pairing", role: "recorder", send: () => undefined }), {
    accepted: false,
    code: "recorder-pairing-required",
    message: "The recorder did not provide a valid capture pairing identity",
  });
  assert.deepEqual(store.connect(sessionId, recorderConnection("foreign-recorder", "capture-tab-two")), {
    accepted: false,
    code: "recorder-pairing-rejected",
    message: "The recorder does not belong to the capture tab paired with this QR session",
  });

  const firstCloses: Array<{ code: number; reason: string }> = [];
  const first: SessionConnection = {
    ...recorderConnection("first-recorder", capture.pairingId!),
    close: (code, reason) => firstCloses.push({ code, reason }),
  };
  assert.deepEqual(store.connect(sessionId, first), { accepted: true, replacedConnectionIds: [] });
  await store.armRecorder(sessionId, first);
  assert.equal(store.isActiveRecorder(sessionId, first), true);

  const replacement = recorderConnection("replacement-recorder", capture.pairingId!);
  assert.deepEqual(store.connect(sessionId, replacement), {
    accepted: false,
    retryable: true,
    message: "The paired capture recorder is still connected",
  });
  assert.deepEqual(firstCloses, []);
  assert.equal(store.isActiveRecorder(sessionId, first), true);
  assert.equal(store.isActiveRecorder(sessionId, replacement), false);
  await store.disconnect(sessionId, first);
  assert.deepEqual(store.connect(sessionId, replacement), { accepted: true, replacedConnectionIds: [] });
  assert.equal(store.isActiveRecorder(sessionId, replacement), true);
  await assert.rejects(
    store.armRecorder(sessionId, first),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "not-capture",
  );
  const staleBlock = encodedBlock(recorderInput(sessionId, "stale-episode", 0, 0, Date.now() * 1_000));
  await assert.rejects(
    store.recordRecorderBlock(sessionId, staleBlock.decoded, staleBlock.encoded, first),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "not-capture",
  );
  await store.armRecorder(sessionId, replacement);
  assert.equal(store.snapshot(sessionId).captureStatus.recorder, "armed");
});

test("interrupts a live take when the paired capture disconnects without a replacement", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-paired-capture-disconnect-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "paired-capture-disconnect";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);

  await store.disconnect(sessionId, capture);
  const interrupted = store.snapshot(sessionId);
  assert.equal(interrupted.captureConnected, false);
  assert.equal(interrupted.run.status, "stopped");
  assert.equal(interrupted.run.recordingState, "idle");
  assert.equal(interrupted.currentEpisode, null);
  assert.equal(interrupted.pendingEpisode, null);
  assert.equal(interrupted.attempts[0]?.id, episode.id);
  assert.equal(interrupted.attempts[0]?.integrity, "interrupted");
  assert.equal(interrupted.attempts[0]?.integrityReason, "The active demonstrator capture client disconnected");
});

test("pauses REC, LEFT and TAKE while SESS continues, then resumes the same recording", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recording-pause-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "recording-pause-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [{
    id: "pause-clock-task",
    label: "Pause clock task",
    instructions: "Pause without ending the take",
    type: "timed",
    durationS: 60,
    repeatCount: 1,
    resetTimeS: 0,
  }];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  await delay(25);

  await store.control(sessionId, "pause");
  const paused = store.snapshot(sessionId);
  assert.equal(paused.run.status, "running");
  assert.equal(paused.run.phase, "active-task");
  assert.equal(paused.run.recordingState, "paused");
  assert.equal(paused.currentEpisode?.id, episode.id);
  assert.equal(paused.recording, false);
  assert.equal(paused.captureStatus.recorder, "paused");
  assert.equal(paused.run.takeStartedAtMs, null);
  assert.equal(paused.run.recordingStartedAtMs, null);
  assert.ok(paused.run.takeElapsedMs > 0);
  assert.ok(paused.run.recordingElapsedMs > 0);
  const pausedSessionElapsed = sessionElapsedMs(paused.run);
  const pausedTakeElapsed = takeElapsedMs(paused.run);
  const pausedRecordingElapsed = recordingElapsedMs(paused.run);
  const pausedRemaining = timedTaskRemainingMs(paused.run, 60_000);

  await delay(40);
  const stillPaused = store.snapshot(sessionId);
  assert.ok(sessionElapsedMs(stillPaused.run) > pausedSessionElapsed);
  assert.equal(takeElapsedMs(stillPaused.run), pausedTakeElapsed);
  assert.equal(recordingElapsedMs(stillPaused.run), pausedRecordingElapsed);
  assert.equal(timedTaskRemainingMs(stillPaused.run, 60_000), pausedRemaining);

  await store.control(sessionId, "resume");
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  assert.equal(store.snapshot(sessionId).currentEpisode?.id, episode.id);
  await delay(25);
  const resumed = store.snapshot(sessionId);
  assert.ok(takeElapsedMs(resumed.run) > pausedTakeElapsed);
  assert.ok(recordingElapsedMs(resumed.run) > pausedRecordingElapsed);
  assert.ok(timedTaskRemainingMs(resumed.run, 60_000) < pausedRemaining);

  await store.control(sessionId, "next-task");
  await finaliseRequestedStop(store, sessionId, capture);
});

test("stop ends an active or paused recording, the current take and the run", async (context) => {
  for (const pauseBeforeStop of [false, true]) {
    const dataRoot = await mkdtemp(path.join(tmpdir(), `ceres-stop-${pauseBeforeStop ? "paused" : "recording"}-`));
    context.after(() => rm(dataRoot, { recursive: true, force: true }));
    const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
    const sessionId = pauseBeforeStop ? "stop-paused-session" : "stop-recording-session";
    await store.armRecorder(sessionId);
    const capture = connectReadyCapture(store, sessionId);
    const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
    if (pauseBeforeStop) await store.control(sessionId, "pause");

    await store.control(sessionId, "stop");
    const stopping = store.snapshot(sessionId);
    assert.equal(stopping.run.status, "running");
    assert.equal(stopping.run.recordingState, "stopping");
    assert.equal(stopping.currentEpisode?.id, episode.id);
    await finaliseRequestedStop(store, sessionId, capture);

    const stopped = store.snapshot(sessionId);
    assert.equal(stopped.run.status, "stopped");
    assert.equal(stopped.run.phase, null);
    assert.equal(stopped.run.recordingState, "idle");
    assert.equal(stopped.run.startedAtMs, null);
    assert.equal(stopped.currentEpisode, null);
    assert.equal(stopped.pendingEpisode, null);
    assert.equal(stopped.episodes.length, 0);
    assert.equal(stopped.attempts[0]?.id, episode.id);
    assert.equal(stopped.attempts[0]?.outcome, "stopped");
  }
});

for (const actor of ["director", "demonstrator"] as const) test(`${actor} finish preserves a partial cycle after durable recorder and media finalisation`, async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-recording-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = `finish-recording-${actor}`;
  const configuration = structuredClone(defaultConfiguration);
  configuration.totalCycles = 3;
  configuration.tasks = [
    { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 2, resetTimeS: 5 },
    { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const director: SessionConnection = { id: `director-${sessionId}`, role: "monitor-control", send: () => undefined };
  store.connect(sessionId, director);
  const control = actor === "director" ? director : capture;
  const sourceTimestampUs = Date.now() * 1_000;
  const episode = await recordValidTake(store, sessionId, capture, 0, sourceTimestampUs);
  const commands: string[] = [];
  capture.send = (type, payload) => {
    if (type === "control" && payload && typeof payload === "object" && "action" in payload) {
      commands.push(String(payload.action));
    }
  };

  await store.control(sessionId, "finish");
  await store.control(sessionId, "finish", control);
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  assert.equal(commands.some((action) => action === "recording-event"), false);
  await store.control(sessionId, "finish", control, "stale-finish-cursor");
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  assert.equal(commands.some((action) => action === "recording-event"), false);
  const finishCursor = nextRunControlCursor(store.snapshot(sessionId), "finish");
  await store.control(sessionId, "finish", control, finishCursor);
  assert.deepEqual(
    commands.filter((action) => action.startsWith("recording-")),
    ["recording-paused", "recording-event", "recording-stopping"],
  );
  const stopping = store.snapshot(sessionId);
  assert.equal(stopping.run.status, "running");
  assert.equal(stopping.run.recordingState, "stopping");
  assert.equal(stopping.currentEpisode?.id, episode.id);
  assert.equal(stopping.currentEpisode?.runFinalisation, "finish-requested");
  assert.equal(stopping.currentEpisode?.segments?.[0]?.outcome, "completed");
  assert.equal(stopping.episodes.length, 0);
  assert.equal(stopping.run.phase, null);
  assert.equal(stopping.run.resetDeadlineMs, null);
  const commandCount = commands.length;
  await store.control(sessionId, "finish", control, finishCursor);
  assert.equal(commands.length, commandCount);
  await assert.rejects(
    store.control(sessionId, "finish", control, nextRunControlCursor(store.snapshot(sessionId), "finish")),
    /already finalising/,
  );

  const terminalMedia = encodedBlock({
    ...recorderInput(sessionId, episode.id, stopping.captureStatus.recorderDurableAckSequence + 1, 0, sourceTimestampUs),
    flags: RecorderBlockFlags.MediaChunk,
    payload: encodeRecorderMediaPayload("video/webm", Uint8Array.of(1, 2, 3)),
  });
  await store.recordRecorderBlock(sessionId, terminalMedia.decoded, terminalMedia.encoded);
  assert.equal(store.snapshot(sessionId).run.recordingState, "stopping");
  assert.equal(store.snapshot(sessionId).episodes.length, 0);

  await finaliseRequestedStop(store, sessionId, capture);

  const complete = store.snapshot(sessionId);
  assert.equal(complete.run.status, "complete");
  assert.equal(complete.run.phase, null);
  assert.equal(complete.run.recordingState, "idle");
  assert.ok(complete.run.endedAtMs);
  assert.equal(complete.currentEpisode, null);
  assert.equal(complete.attempts.length, 0);
  assert.equal(complete.episodes[0]?.id, episode.id);
  assert.equal(complete.episodes[0]?.outcome, "completed");
  assert.equal(complete.episodes[0]?.accepted, true);
  assert.equal(complete.episodes[0]?.runFinalisation, "finish-completed");
  assert.equal(complete.episodes[0]?.segments?.[0]?.outcome, "completed");
  assert.equal(complete.episodes[0]?.segments?.[0]?.accepted, true);
  assert.equal(complete.episodes[0]?.frameCount, 1);
  assert.equal(complete.episodes[0]?.mediaChunkCount, 1);
  assert.equal(isExportableEpisode(complete.episodes[0]), true);
  assert.deepEqual(complete.episodes[0]?.segments?.map(({ taskId }) => taskId), ["task-a"]);
  assert.equal(complete.run.cycle, 1);
  assert.equal(complete.run.activeTaskIndex, 0);
  assert.equal(complete.pendingEpisode, null);
  const video = await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "video", "passthrough.webm"));
  assert.deepEqual([...video], [1, 2, 3]);
  await store.control(sessionId, "finish", control, finishCursor);
  assert.deepEqual(store.snapshot(sessionId), complete);
});

test("Finish rejects delayed server recorder acceptance without publishing a terminal boundary", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finish-arming-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "finish-arming-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const controls: string[] = [];
  capture.send = (type, payload) => {
    if (type === "control" && typeof payload?.action === "string") controls.push(payload.action);
  };
  await store.control(sessionId, "start-sequence");
  const pending = store.snapshot(sessionId).pendingEpisode;
  assert.ok(pending);
  controls.length = 0;

  await assert.rejects(
    store.control(
      sessionId,
      "finish",
      capture,
      nextRunControlCursor(store.snapshot(sessionId), "finish"),
    ),
    /accept the recording before finishing/,
  );
  assert.equal(store.snapshot(sessionId).run.recordingState, "arming");
  assert.equal(store.snapshot(sessionId).pendingEpisode?.segments?.[0]?.outcome, "recording");
  assert.equal(store.snapshot(sessionId).pendingEpisode?.runFinalisation, undefined);
  assert.equal(controls.includes("recording-event"), false);

  await store.acceptRecording(sessionId, capture, pending.id);
  await writeCurrentSegmentStart(store, sessionId, 1_000_000);
  const firstSlot = encodedBlock(recorderInput(
    sessionId,
    pending.id,
    store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1,
    0,
    1_000_001,
  ));
  await store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded);
  controls.length = 0;
  await store.control(
    sessionId,
    "finish",
    capture,
    nextRunControlCursor(store.snapshot(sessionId), "finish"),
  );
  assert.deepEqual(
    controls.filter((action) => action.startsWith("recording-")),
    ["recording-paused", "recording-event", "recording-stopping"],
  );
});

test("capture finalisation failure interrupts a stopping take without accepting it", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-capture-recorder-failure-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "capture-recorder-failure-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);

  await store.control(sessionId, "next-task", capture, nextRunControlCursor(store.snapshot(sessionId), "next-task"));
  assert.equal(store.snapshot(sessionId).run.phase, "post-task-pause");
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.recordingState, "stopping");
  await store.finaliseRecording(sessionId, capture, episode.id, "simulated capture recorder failure");

  const failed = store.snapshot(sessionId);
  assert.equal(failed.run.status, "stopped");
  assert.equal(failed.run.recordingState, "idle");
  assert.equal(failed.captureStatus.recorder, "failed");
  assert.equal(failed.currentEpisode, null);
  assert.equal(failed.pendingEpisode, null);
  assert.equal(failed.episodes.length, 0);
  assert.equal(failed.attempts[0]?.id, episode.id);
  assert.equal(failed.attempts[0]?.integrity, "interrupted");
  assert.equal(failed.attempts[0]?.integrityReason, "Recorder finalisation failed");
});

test("persistence failure exits the stopping state and retains an interrupted attempt", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-finalisation-persistence-failure-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "finalisation-persistence-failure-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  const writableStore = store as unknown as { persistEpisode: (...args: any[]) => Promise<void> };
  const persistEpisode = writableStore.persistEpisode.bind(store);
  writableStore.persistEpisode = async (...args: any[]) => {
    const episode = args[1] as { outcome?: string } | undefined;
    if (episode?.outcome === "completed") {
      throw new RecorderStoreError("write-failed", "simulated finalisation persistence failure");
    }
    await persistEpisode(...args);
  };

  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await writeMissingCompletedSegmentEnds(store, sessionId, Date.now() * 1_000);
  await assert.rejects(
    store.finaliseRecording(sessionId, capture, episode.id),
    /simulated finalisation persistence failure/,
  );

  const failed = store.snapshot(sessionId);
  assert.equal(failed.run.status, "stopped");
  assert.equal(failed.run.recordingState, "idle");
  assert.equal(failed.captureStatus.recorder, "failed");
  assert.equal(failed.currentEpisode, null);
  assert.equal(failed.pendingEpisode, null);
  assert.equal(failed.episodes.length, 0);
  assert.equal(failed.attempts[0]?.id, episode.id);
  assert.equal(failed.attempts[0]?.integrity, "interrupted");
  assert.equal(failed.attempts[0]?.integrityReason, "Recorder finalisation failed");
});

test("treats late finalisation of an already-settled attempt or episode as idempotent", async (context) => {
  for (const settlement of ["attempt", "episode"] as const) {
    const dataRoot = await mkdtemp(path.join(tmpdir(), `ceres-finalise-${settlement}-`));
    context.after(() => rm(dataRoot, { recursive: true, force: true }));
    const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
    const sessionId = `finalise-${settlement}-session`;
    await store.armRecorder(sessionId);
    const capture = connectReadyCapture(store, sessionId);
    const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);

    await store.control(sessionId, settlement === "attempt" ? "stop" : "next-task");
    if (settlement === "episode") await store.control(sessionId, "next-task");
    await finaliseRequestedStop(store, sessionId, capture);
    const settled = structuredClone(store.snapshot(sessionId));
    assert.equal(settlement === "attempt" ? settled.attempts[0]?.id : settled.episodes[0]?.id, episode.id);

    await store.finaliseRecording(sessionId, capture, episode.id);
    assert.deepEqual(store.snapshot(sessionId), settled);
    await assert.rejects(
      store.finaliseRecording(sessionId, capture, "unknown-episode"),
      /finalised an unexpected episode/,
    );
  }
});

test("retry resets the current take without advancing its task, repetition or cycle", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-retry-take-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "retry-take-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.totalCycles = 2;
  configuration.tasks = [{
    id: "retry-task",
    label: "Retry task",
    instructions: "Restart this take",
    type: "open",
    repeatCount: 2,
    resetTimeS: 0.05,
  }];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const sourceTimestampUs = Date.now() * 1_000;
  const episode = await recordValidTake(store, sessionId, capture, 0, sourceTimestampUs);
  const cursor = runCursor(store, sessionId);
  await delay(20);

  const deadline = store.snapshot(sessionId).run.resetDeadlineMs;
  await store.control(sessionId, "retry", capture, nextRunControlCursor(store.snapshot(sessionId), "retry"));
  assert.notEqual(store.snapshot(sessionId).run.resetDeadlineMs, deadline);
  await waitFor(() => store.snapshot(sessionId).run.phase === "active-task"
    && store.snapshot(sessionId).run.recordingState === "recording", 7_000);
  const reset = store.snapshot(sessionId);
  assert.deepEqual(runCursor(store, sessionId), cursor);
  assert.equal(reset.run.status, "running");
  assert.equal(reset.run.phase, "active-task");
  assert.equal(reset.run.recordingState, "recording");
  assert.equal(reset.run.takeElapsedMs, 0);
  assert.ok(reset.run.takeStartedAtMs !== null);
  assert.equal(reset.run.recordingElapsedMs, 0);
  assert.ok(reset.run.recordingStartedAtMs !== null);
  assert.equal(reset.currentEpisode?.id, episode.id);
  assert.equal(reset.currentEpisode?.segments?.[0]?.outcome, "retry");
  assert.equal(reset.currentEpisode?.segments?.length, 2);

  await recordValidTake(store, sessionId, capture, 1, sourceTimestampUs + 1_000_000);
  await store.control(sessionId, "next-task", capture, nextRunControlCursor(store.snapshot(sessionId), "next-task"));
  await store.control(sessionId, "next-task");
  await recordValidTake(store, sessionId, capture, 2, sourceTimestampUs + 2_000_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await finaliseRequestedStop(store, sessionId, capture);
  const completed = store.snapshot(sessionId).episodes[0];
  assert.deepEqual(completed?.segments?.map(({ outcome, recorderSlotCount, accepted }) => ({
    outcome,
    recorderSlotCount,
    accepted,
  })), [
    { outcome: "retry", recorderSlotCount: 1, accepted: false },
    { outcome: "completed", recorderSlotCount: 1, accepted: true },
    { outcome: "completed", recorderSlotCount: 1, accepted: true },
  ]);
});

test("next completes an open recording and advances to the next take", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-next-take-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "next-take-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    {
      id: "first-open-task",
      label: "First open task",
      instructions: "Complete this open goal",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
    {
      id: "second-open-task",
      label: "Second open task",
      instructions: "Continue here",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  const commandOrder: string[] = [];
  store.connect(sessionId, {
    id: "next-take-order-monitor",
    role: "monitor",
    send: (type, payload) => {
      if (type !== "control") return;
      const command = payload as { action?: string; event?: { type?: string } };
      if (command.action === "recording-paused") commandOrder.push("recording-paused");
      if (command.action === "recording-event" && command.event?.type === "segment-end") commandOrder.push("segment-end");
    },
  });

  await store.control(sessionId, "next-task");
  assert.deepEqual(commandOrder, ["recording-paused", "segment-end"]);
  assert.equal(store.snapshot(sessionId).run.recordingState, "paused");
  await store.control(sessionId, "next-task");
  const advanced = store.snapshot(sessionId);
  assert.equal(advanced.currentEpisode?.id, episode.id);
  assert.equal(advanced.currentEpisode?.segments?.length, 2);
  assert.equal(advanced.run.status, "running");
  assert.equal(advanced.run.phase, "active-task");
  assert.equal(advanced.run.activeTaskIndex, 1);
  assert.equal(advanced.run.repetition, 1);
  assert.equal(advanced.run.take, 1);
});

test("a replayed reset Next cannot complete the newly active task", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-next-cursor-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "next-cursor-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    {
      id: "cursor-task-a",
      label: "Cursor task A",
      instructions: "Complete the first task",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
    {
      id: "cursor-task-b",
      label: "Cursor task B",
      instructions: "Complete the second task",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);

  const activeCursor = nextRunControlCursor(store.snapshot(sessionId));
  await store.control(sessionId, "next-task", undefined, activeCursor);
  const resetCursor = nextRunControlCursor(store.snapshot(sessionId));
  await Promise.all([
    store.control(sessionId, "next-task", undefined, resetCursor),
    store.control(sessionId, "next-task", undefined, resetCursor),
  ]);

  const advanced = store.snapshot(sessionId);
  assert.equal(advanced.run.phase, "active-task");
  assert.equal(advanced.run.activeTaskIndex, 1);
  assert.equal(advanced.run.recordingState, "recording");
  assert.equal(advanced.currentEpisode?.segments?.length, 2);
  assert.equal(advanced.currentEpisode?.segments?.[1]?.outcome, "recording");

  await store.control(sessionId, "next-task", undefined, nextRunControlCursor(advanced));
  const completed = store.snapshot(sessionId);
  assert.equal(completed.run.phase, "post-task-pause");
  assert.equal(completed.currentEpisode?.segments?.length, 2);
  assert.equal(completed.currentEpisode?.segments?.[1]?.outcome, "completed");
});

test("a concurrent stale resume cannot leave the task reset", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-stale-resume-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "stale-resume-session";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  await store.control(sessionId, "pause");

  const nextCursor = nextRunControlCursor(store.snapshot(sessionId));
  const [nextResult, resumeResult] = await Promise.allSettled([
    store.control(sessionId, "next-task", undefined, nextCursor),
    store.control(sessionId, "resume"),
  ]);

  assert.equal(nextResult.status, "fulfilled");
  assert.equal(resumeResult.status, "rejected");
  assert.match(resumeResult.status === "rejected" ? String(resumeResult.reason) : "", /Only a paused recording can be resumed/);
  assert.equal(store.snapshot(sessionId).run.phase, "post-task-pause");
  assert.equal(store.snapshot(sessionId).run.recordingState, "paused");
});

test("duplicate concurrent voice Next commands advance a reset only once", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-voice-next-cursor-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "voice-next-cursor-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    {
      id: "voice-task-a",
      label: "Voice task A",
      instructions: "Complete the first task",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
    {
      id: "voice-task-b",
      label: "Voice task B",
      instructions: "Complete the second task",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  await store.control(sessionId, "next-task");
  const reset = store.snapshot(sessionId);
  assert.equal(reset.run.phase, "post-task-pause");
  assert.equal(reset.run.activeTaskIndex, 0);

  const transcriptTimestampMs = Date.now();
  await Promise.all([
    store.recordTranscript(sessionId, "next task", transcriptTimestampMs, capture),
    store.recordTranscript(sessionId, "next task", transcriptTimestampMs, capture),
  ]);

  const advanced = store.snapshot(sessionId);
  assert.equal(advanced.run.status, "running");
  assert.equal(advanced.run.phase, "active-task");
  assert.equal(advanced.run.activeTaskIndex, 1);
  assert.equal(advanced.run.repetition, 1);
  assert.equal(advanced.run.take, 1);
  assert.equal(advanced.run.recordingState, "recording");
  assert.equal(advanced.currentEpisode?.segments?.length, 2);
  assert.equal(advanced.currentEpisode?.segments?.[0]?.outcome, "completed");
  assert.equal(advanced.currentEpisode?.segments?.[1]?.taskId, "voice-task-b");
  assert.equal(advanced.currentEpisode?.segments?.[1]?.outcome, "recording");
});

test("advances reps within a task, then tasks within each cycle", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-run-cursor-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "run-cursor-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.totalCycles = 2;
  configuration.tasks = [
    {
      id: "two-rep-task",
      label: "Two rep task",
      instructions: "Repeat this task twice",
      type: "open",
      repeatCount: 2,
      resetTimeS: 5,
    },
    {
      id: "one-rep-task",
      label: "One rep task",
      instructions: "Complete this task once",
      type: "open",
      repeatCount: 1,
      resetTimeS: 5,
    },
  ];
  await store.setConfiguration(sessionId, configuration);
  const capture = connectReadyCapture(store, sessionId);
  await store.armRecorder(sessionId);
  const firstCycleEpisode = await recordValidTake(store, sessionId, capture, 0, 30_000_000);

  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 1, 0, 1, 1));
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 1, 0, 2, 2));
  await recordValidTake(store, sessionId, capture, 1, 30_100_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 1, 1, 1, 1));
  await recordValidTake(store, sessionId, capture, 2, 30_200_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 1, 2, 1, 1));
  assert.equal(store.snapshot(sessionId).run.phase, "cycle-pause");
  await finaliseRequestedStop(store, sessionId, capture);
  assert.equal(store.snapshot(sessionId).episodes.length, 1);
  assert.deepEqual(store.snapshot(sessionId).episodes[0]?.segments?.map((segment) => ({
    taskId: segment.taskId,
    recorderSlotCount: segment.recorderSlotCount,
    accepted: segment.accepted,
  })), [
    { taskId: "two-rep-task", recorderSlotCount: 1, accepted: true },
    { taskId: "two-rep-task", recorderSlotCount: 1, accepted: true },
    { taskId: "one-rep-task", recorderSlotCount: 1, accepted: true },
  ]);
  await store.control(sessionId, "next-task");
  const secondCycleEpisode = await recordValidTake(store, sessionId, capture, 3, 31_000_000);
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 2, 0, 1, 1));
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 2, 0, 2, 2));
  await recordValidTake(store, sessionId, capture, 4, 31_100_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.deepEqual(runCursor(store, sessionId), runPosition("running", 2, 1, 1, 1));
  await recordValidTake(store, sessionId, capture, 5, 31_200_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.phase, "cycle-pause");
  await finaliseRequestedStop(store, sessionId, capture);
  assert.equal(store.snapshot(sessionId).episodes.length, 2);
  assert.deepEqual(store.snapshot(sessionId).episodes.map(({ cycle }) => cycle), [2, 1]);
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.status, "complete");
  assert.equal(store.snapshot(sessionId).run.activeTaskIndex, 2);
});

test("rejects a cycle when any completed task segment has no durable recorder slots", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-segment-coverage-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "segment-coverage-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    { id: "task-a", label: "Task A", instructions: "Reach", type: "open", repeatCount: 1, resetTimeS: 5 },
    { id: "task-b", label: "Task B", instructions: "Place", type: "open", repeatCount: 1, resetTimeS: 5 },
  ];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, 40_000_000);

  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await store.finaliseRecording(sessionId, capture, episode.id);

  const attempt = store.snapshot(sessionId).attempts[0];
  assert.equal(store.snapshot(sessionId).episodes.length, 0);
  assert.equal(attempt?.integrityReason, "Task segment Task B has no durable recorder slots");
  assert.deepEqual(attempt?.segments?.map(({ recorderSlotCount, accepted }) => ({ recorderSlotCount, accepted })), [
    { recorderSlotCount: 1, accepted: false },
    { recorderSlotCount: 0, accepted: false },
  ]);
});

test("keeps pass and fail as optional task-reset annotations", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-take-annotation-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "take-annotation-session";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [{
    id: "annotated-task",
    label: "Annotated task",
    instructions: "Annotate only during the pause",
    type: "open",
    repeatCount: 3,
    resetTimeS: 5,
  }];
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);

  const episode = await recordValidTake(store, sessionId, capture, 0, 20_000_000);
  await assert.rejects(store.control(sessionId, "success"), /only available during the task reset/);
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.phase, "post-task-pause");
  assert.equal(store.snapshot(sessionId).run.recordingState, "paused");
  const firstDeadline = store.snapshot(sessionId).run.resetDeadlineMs;
  await store.control(sessionId, "success");
  assert.equal(store.snapshot(sessionId).run.phase, "post-task-pause");
  assert.equal(store.snapshot(sessionId).run.resetDeadlineMs, firstDeadline);
  assert.equal(store.snapshot(sessionId).currentEpisode?.segments?.[0]?.annotations.at(-1)?.action, "pass");
  await store.control(sessionId, "next-task");

  await recordValidTake(store, sessionId, capture, 1, 21_000_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "fail");
  assert.equal(store.snapshot(sessionId).currentEpisode?.segments?.[1]?.annotations.at(-1)?.action, "fail");
  await store.control(sessionId, "next-task");

  await recordValidTake(store, sessionId, capture, 2, 22_000_000);
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await finaliseRequestedStop(store, sessionId, capture);
  const saved = store.snapshot(sessionId).episodes[0];
  assert.equal(saved?.id, episode.id);
  assert.equal(saved?.segments?.length, 3);
  assert.deepEqual(saved?.segments?.map((segment) => segment.annotations.map(({ action }) => action)), [
    ["next", "pass", "next"],
    ["next", "fail", "next"],
    ["next", "next"],
  ]);
  await store.control(sessionId, "next-task");
  assert.equal(store.snapshot(sessionId).run.status, "complete");
  await assert.rejects(store.control(sessionId, "fail"), /only available during the task reset/);
});

test("enters an initial pause and advances to the first recordable task", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-initial-pause-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "initial-pause-run";
  const configuration = structuredClone(defaultConfiguration);
  configuration.tasks = [
    {
      id: "settle-pause",
      label: "Settle",
      instructions: "Prepare the workspace",
      type: "pause",
      durationS: 0.2,
    },
    {
      id: "recordable-task",
      label: "Recordable task",
      instructions: "Perform the task",
      type: "open",
      repeatCount: 1,
      resetTimeS: 0,
    },
  ];

  await store.setConfiguration(sessionId, configuration);
  const capture = connectReadyCapture(store, sessionId);
  await store.armRecorder(sessionId);
  assert.equal(store.snapshot(sessionId).run.status, "stopped");
  await store.control(sessionId, "start-sequence");
  assert.equal(store.snapshot(sessionId).run.status, "running");
  assert.equal(store.snapshot(sessionId).run.phase, "task-pause");
  assert.equal(store.snapshot(sessionId).run.activeTaskIndex, 0);
  assert.ok(store.snapshot(sessionId).run.resetDeadlineMs);

  await waitFor(() => store.snapshot(sessionId).pendingEpisode !== null
    && store.snapshot(sessionId).run.phase === null, 7_000);

  const snapshot = store.snapshot(sessionId);
  assert.equal(snapshot.run.activeTaskIndex, 1);
  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.run.phase, null);
  assert.equal(snapshot.run.recordingState, "arming");
  assert.equal(snapshot.run.takeStartedAtMs, null);
  assert.equal(snapshot.run.resetDeadlineMs, null);
  assert.ok(snapshot.pendingEpisode);

  await store.acceptRecording(sessionId, capture, snapshot.pendingEpisode.id);
  await writeCurrentSegmentStart(store, sessionId, 1_000_000);
  const firstSlot = encodedBlock(recorderInput(
    sessionId,
    snapshot.pendingEpisode.id,
    store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1,
    0,
    1_000_000,
  ));
  await store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded);
  assert.equal(store.snapshot(sessionId).run.phase, "active-task");
});

test("persists capture-quality events and a summary from durable recorder frames", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-quality-summary-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "quality-run";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);
  const timestampBase = Date.now() * 1_000;
  await writeCurrentSegmentStart(store, sessionId, timestampBase);
  const sequenceBase = store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1;
  const inputs: RecorderBlockInput[] = [
    { ...recorderInput(sessionId, episode.id, sequenceBase, 0, timestampBase), payload: trackedTelemetryPayload(0, timestampBase / 1_000, 0) },
    { ...recorderInput(sessionId, episode.id, sequenceBase + 1, 1, timestampBase + 100_000), payload: trackedTelemetryPayload(1, timestampBase / 1_000 + 100, .5) },
    { ...recorderInput(sessionId, episode.id, sequenceBase + 2, 2, timestampBase + 200_000), payload: trackedTelemetryPayload(2, timestampBase / 1_000 + 200, null) },
    {
      ...recorderInput(sessionId, episode.id, sequenceBase + 3, 3, timestampBase + 300_000),
      flags: RecorderBlockFlags.Gap,
      payload: new TextEncoder().encode("Synthetic cadence gap"),
    },
  ];
  for (const input of inputs) {
    const block = encodedBlock(input);
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  }
  await store.control(sessionId, "next-task");
  await store.control(sessionId, "next-task");
  await finaliseRequestedStop(store, sessionId, capture);

  const saved = store.snapshot(sessionId).episodes[0];
  assert.equal(saved.qualitySummary.frameCount, 3);
  assert.equal(saved.qualitySummary.gapCount, 1);
  assert.ok(saved.qualitySummary.maxLeftHandSpeedMps >= 2);
  assert.equal(saved.qualitySummary.slowHandEvents, 1);
  assert.equal(saved.qualitySummary.trackingLossEvents, 1);
  assert.equal(saved.qualitySummary.decision, "stop");
  assert.deepEqual(saved.qualityEvents.map((event) => event.type), ["slow-hands", "tracking-loss", "gap"]);
  const persisted = JSON.parse(await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "episode.json"), "utf8"));
  assert.deepEqual(persisted.qualitySummary, saved.qualitySummary);
});

test("keeps a framed take active when an optional camera stream is lost", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-stream-loss-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "stream-loss-run";
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  const episode = await recordValidTake(store, sessionId, capture, 0, Date.now() * 1_000);
  assert.equal(store.snapshot(sessionId).run.status, "running");
  assert.equal(store.snapshot(sessionId).run.recordingState, "recording");
  await store.setCaptureStatus(sessionId, capture, {
    ...store.snapshot(sessionId).captureStatus,
    camera: "error",
    lastError: "Camera track ended",
  });

  const snapshot = store.snapshot(sessionId);
  assert.equal(snapshot.run.status, "running");
  assert.equal(snapshot.run.recordingState, "recording");
  assert.equal(snapshot.currentEpisode?.id, episode.id);
  assert.equal(snapshot.episodes.length, 0);
  assert.equal(snapshot.attempts.length, 0);
  const persisted = JSON.parse(await readFile(path.join(dataRoot, "sessions", sessionId, "episodes", episode.id, "episode.json"), "utf8"));
  assert.equal(persisted.integrity, "valid");
  assert.equal(persisted.integrityReason, undefined);
});

test("requires prompt-audio preflight and records monotonic playback acknowledgements", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-prompt-audio-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  const sessionId = "prompt-audio-run";
  const configuration = structuredClone(defaultConfiguration);
  configuration.promptAudio.enabled = true;
  configuration.promptAudio.required = true;
  configuration.promptAudio.useTextToSpeech = true;
  await store.setConfiguration(sessionId, configuration);
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, false);
  assert.equal(store.snapshot(sessionId).sequenceReadiness.blockers.some((blocker) => blocker.code === "audio-not-ready"), true);
  assert.equal(store.snapshot(sessionId).recordingReadiness.blockers.some((blocker) => blocker.code === "audio-not-ready"), true);
  await assert.rejects(store.control(sessionId, "start-sequence"), /prompt audio/i);

  store.setPromptAudioStatus(sessionId, capture, { state: "ready", detail: "Prompt audio ready" });
  assert.equal(store.snapshot(sessionId).sequenceReadiness.ready, true);
  await store.control(sessionId, "start-sequence");
  assert.equal(store.snapshot(sessionId).run.recordingState, "arming");
  assert.equal(store.snapshot(sessionId).promptDeliveries.length, 0);
  const episode = store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  await store.acceptRecording(sessionId, capture, episode.id);
  await writeCurrentSegmentStart(store, sessionId, 1_000_000);
  const firstSlot = encodedBlock(recorderInput(
    sessionId,
    episode.id,
    store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1,
    0,
    1_000_000,
  ));
  await store.recordRecorderBlock(sessionId, firstSlot.decoded, firstSlot.encoded);
  const delivery = store.snapshot(sessionId).promptDeliveries[0];
  assert.ok(delivery);
  assert.equal(delivery.transition, "task-start");
  assert.equal(delivery.state, "queued");
  store.acknowledgePrompt(sessionId, capture, delivery.id, "queued");
  store.acknowledgePrompt(sessionId, capture, delivery.id, "started");
  store.acknowledgePrompt(sessionId, capture, delivery.id, "completed");
  assert.equal(store.snapshot(sessionId).promptDeliveries[0].state, "completed");
  assert.throws(() => store.acknowledgePrompt(sessionId, capture, delivery.id, "failed", "late failure"), /already finalised/);
  await store.control(sessionId, "stop");
  await finaliseRequestedStop(store, sessionId, capture);
});

test("fails closed when storage headroom is unsafe", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "ceres-recorder-storage-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = new SessionStore({ dataRoot, minimumFreeBytes: Number.MAX_SAFE_INTEGER });
  await assert.rejects(
    store.armRecorder("unsafe-storage-session"),
    (error: unknown) => error instanceof RecorderStoreError && error.code === "storage-unsafe",
  );
  assert.equal(store.snapshot("unsafe-storage-session").captureStatus.recorder, "failed");
  assert.equal(
    store.snapshot("unsafe-storage-session").sequenceReadiness.blockers.some((blocker) => blocker.code === "recorder-failed"),
    true,
  );
});

test("relays monitor overload stages to capture and suspends secondary work", () => {
  const store = new SessionStore({ minimumFreeBytes: 0 });
  const messages: Array<{ type: string; payload: unknown }> = [];
  const capture: SessionConnection = {
    id: "capture-one",
    role: "capture",
    pairingId: "load-pairing",
    send: (type, payload) => messages.push({ type, payload }),
  };
  const monitor: SessionConnection = { id: "monitor-one", role: "monitor", send: () => undefined };

  store.connect("load-session", capture);
  store.requestCaptureIntent("load-session", capture);
  store.connect("load-session", monitor);
  store.setMonitorLoad("load-session", monitor, 4);
  assert.deepEqual(messages.filter((message) => message.type === "monitor-load").at(-1)?.payload, { stage: 4 });
  assert.equal(store.runSecondaryWork("load-session"), true);

  store.setMonitorLoad("load-session", monitor, 6);
  assert.deepEqual(messages.filter((message) => message.type === "monitor-load").at(-1)?.payload, { stage: 5 });
  assert.equal(store.runSecondaryWork("load-session"), false);
  store.disconnect("load-session", monitor);
  assert.equal(store.runSecondaryWork("load-session"), true);
  assert.deepEqual(messages.filter((message) => message.type === "monitor-load").at(-1)?.payload, { stage: 0 });
});

async function seedAcceptedPendingJournal(dataRoot: string, sessionId: string, sourceTimestampUs: number) {
  const store = new SessionStore({ dataRoot, minimumFreeBytes: 0 });
  await store.armRecorder(sessionId);
  const capture = connectReadyCapture(store, sessionId);
  await store.control(sessionId, "start-sequence");
  const episode = store.snapshot(sessionId).pendingEpisode;
  const segment = episode?.segments?.[0];
  assert.ok(episode);
  assert.ok(segment);
  await store.acceptRecording(sessionId, capture, episode.id);
  const start = encodedBlock({
    ...recorderInput(sessionId, episode.id, 0, 0, sourceTimestampUs),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  const frame = encodedBlock(recorderInput(sessionId, episode.id, 1, 0, sourceTimestampUs));
  const journalPath = path.join(dataRoot, "sessions", sessionId, "recorder.blocks");
  await appendFile(journalPath, start.encoded);
  await appendFile(journalPath, frame.encoded);
  return { episode, frame, journalPath, start };
}

function recorderConnection(id: string, pairingId: string): SessionConnection {
  return { id, role: "recorder", pairingId, send: () => undefined };
}

function connectReadyCapture(store: SessionStore, sessionId: string) {
  const messages: Array<{ type: string; payload: any }> = [];
  const capture: SessionConnection = {
    id: `capture-${sessionId}`,
    role: "capture",
    pairingId: `pairing-${sessionId}`,
    send: (type, payload) => messages.push({ type, payload }),
  };
  const connected = store.connect(sessionId, capture);
  assert.equal(connected.accepted, true);
  assert.equal(store.requestCaptureIntent(sessionId, capture).accepted, true);
  const configuration = messages.find((message) => message.type === "configuration")?.payload;
  assert.ok(configuration);
  store.acknowledgeConfiguration(sessionId, capture, configuration.revision, configuration.checksum);
  assert.equal(store.activateCaptureAuthority(sessionId, capture).accepted, true);
  void store.setCaptureStatus(sessionId, capture, {
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    transport: "connected",
    recorder: "armed",
    sensorRateHz: defaultConfiguration.recorderRateHz,
    lastFrameAt: Date.now(),
  });
  return capture;
}

async function recordValidTake(
  store: SessionStore,
  sessionId: string,
  capture: SessionConnection,
  _sequence: number,
  sourceTimestampUs: number,
) {
  if (store.snapshot(sessionId).run.status !== "running") await store.control(sessionId, "start-sequence");
  await store.setCaptureStatus(sessionId, capture, {
    ...store.snapshot(sessionId).captureStatus,
    camera: "ready",
    xr: "active",
    transport: "connected",
    sensorRateHz: store.snapshot(sessionId).configuration.recorderRateHz,
    lastFrameAt: Date.now(),
  });
  await store.control(sessionId, "start");
  const episode = store.snapshot(sessionId).currentEpisode ?? store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  if (store.snapshot(sessionId).pendingEpisode) await store.acceptRecording(sessionId, capture, episode.id);
  await writeMissingCompletedSegmentEnds(store, sessionId, sourceTimestampUs);
  const recorderFrameIndex = store.snapshot(sessionId).currentEpisode?.recorderSlotCount ?? 0;
  const segment = (store.snapshot(sessionId).currentEpisode ?? store.snapshot(sessionId).pendingEpisode)?.segments?.at(-1);
  let sequence = store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1;
  if (segment && segment.startSourceTimestampUs === undefined) {
    const start = encodedBlock({
      ...recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent({
        type: "segment-start",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }),
    });
    await store.recordRecorderBlock(sessionId, start.decoded, start.encoded);
    sequence += 1;
  }
  const block = encodedBlock(recorderInput(sessionId, episode.id, sequence, recorderFrameIndex, sourceTimestampUs));
  await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  return episode;
}

async function finaliseRequestedStop(store: SessionStore, sessionId: string, capture: SessionConnection) {
  const episode = store.snapshot(sessionId).currentEpisode ?? store.snapshot(sessionId).pendingEpisode;
  assert.ok(episode);
  const latestBoundaryUs = Math.max(0, ...(episode.segments ?? []).flatMap((segment) => [
    segment.startSourceTimestampUs ?? 0,
    segment.endSourceTimestampUs ?? 0,
  ]));
  const internal = (store as unknown as {
    sessions: Map<string, { recorderLedger: Map<number, { sourceTimestampUs: number }> }>;
  }).sessions.get(sessionId);
  const latestRecorderTimestampUs = Math.max(
    0,
    ...[...(internal?.recorderLedger.values() ?? [])].map((entry) => entry.sourceTimestampUs),
  );
  await writeMissingCompletedSegmentEnds(store, sessionId, Math.max(latestRecorderTimestampUs, latestBoundaryUs));
  await store.finaliseRecording(sessionId, capture, episode.id);
}

async function writeCurrentSegmentStart(
  store: SessionStore,
  sessionId: string,
  sourceTimestampUs: number,
) {
  const snapshot = store.snapshot(sessionId);
  const episode = snapshot.currentEpisode ?? snapshot.pendingEpisode;
  const segment = episode?.segments?.at(-1);
  assert.ok(episode);
  assert.ok(segment);
  if (segment.startSourceTimestampUs !== undefined) return;
  const block = encodedBlock({
    ...recorderInput(
      sessionId,
      episode.id,
      snapshot.captureStatus.recorderDurableAckSequence + 1,
      episode.recorderSlotCount ?? 0,
      sourceTimestampUs,
    ),
    flags: RecorderBlockFlags.RunEvent,
    payload: encodeRecorderRunEvent({
      type: "segment-start",
      segmentId: segment.id,
      taskId: segment.taskId,
      taskLabel: segment.taskLabel,
    }),
  });
  await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
}

async function writeMissingCompletedSegmentEnds(
  store: SessionStore,
  sessionId: string,
  sourceTimestampUs: number,
) {
  const snapshot = store.snapshot(sessionId);
  const episode = snapshot.currentEpisode ?? snapshot.pendingEpisode;
  if (!episode) return;
  for (const segment of episode.segments ?? []) {
    if ((segment.outcome !== "completed" && segment.outcome !== "retry")
      || segment.endSourceTimestampUs !== undefined
      || segment.startSourceTimestampUs === undefined) continue;
    const sequence = store.snapshot(sessionId).captureStatus.recorderDurableAckSequence + 1;
    const recorderFrameIndex = (store.snapshot(sessionId).currentEpisode ?? store.snapshot(sessionId).pendingEpisode)?.recorderSlotCount ?? 0;
    const block = encodedBlock({
      ...recorderInput(
        sessionId,
        episode.id,
        sequence,
        recorderFrameIndex,
        Math.max(sourceTimestampUs, segment.startSourceTimestampUs),
      ),
      flags: RecorderBlockFlags.RunEvent,
      payload: encodeRecorderRunEvent({
        type: "segment-end",
        segmentId: segment.id,
        taskId: segment.taskId,
        taskLabel: segment.taskLabel,
      }),
    });
    await store.recordRecorderBlock(sessionId, block.decoded, block.encoded);
  }
}

function runCursor(store: SessionStore, sessionId: string) {
  const run = store.snapshot(sessionId).run;
  return {
    status: run.status,
    cycle: run.cycle,
    activeTaskIndex: run.activeTaskIndex,
    repetition: run.repetition,
    take: run.take,
  };
}

function runPosition(status: RunProgress["status"], cycle: number, activeTaskIndex: number, repetition: number, take: number) {
  return { status, cycle, activeTaskIndex, repetition, take };
}

function sessionElapsedMs(run: RunProgress, now = Date.now()) {
  return run.startedAtMs === null ? 0 : Math.max(0, (run.endedAtMs ?? now) - run.startedAtMs);
}

function takeElapsedMs(run: RunProgress, now = Date.now()) {
  return run.takeElapsedMs + (run.takeStartedAtMs === null ? 0 : Math.max(0, now - run.takeStartedAtMs));
}

function recordingElapsedMs(run: RunProgress, now = Date.now()) {
  return run.recordingElapsedMs + (run.recordingStartedAtMs === null ? 0 : Math.max(0, now - run.recordingStartedAtMs));
}

function timedTaskRemainingMs(run: RunProgress, durationMs: number, now = Date.now()) {
  return Math.max(0, durationMs - takeElapsedMs(run, now));
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms`);
    await delay(10);
  }
}

function recorderInput(sessionId: string, episodeId: string, sequence: number, recorderFrameIndex: number, sourceTimestampUs: number): RecorderBlockInput {
  return {
    sessionId,
    episodeId,
    sequence,
    recorderFrameIndex,
    sourceTimestampUs,
    flags: RecorderBlockFlags.SensorFrameJson,
    payload: telemetryPayload(recorderFrameIndex),
  };
}

function telemetryPayload(frameIndex: number) {
  const frame: SensorFrame = {
    timestampMs: 0,
    frameIndex,
    head: null,
    leftHand: { tracked: false, joints: {}, pinch: 0 },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  };
  return new TextEncoder().encode(JSON.stringify(frame));
}

function trackedTelemetryPayload(frameIndex: number, timestampMs: number, wristX: number | null) {
  const frame: SensorFrame = {
    timestampMs,
    frameIndex,
    head: null,
    leftHand: {
      tracked: wristX !== null,
      joints: wristX === null ? {} : {
        wrist: {
          position: { x: wristX, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      pinch: 0,
    },
    rightHand: { tracked: false, joints: {}, pinch: 0 },
    sceneStatus: { planes: false, meshes: false, anchors: false },
  };
  return new TextEncoder().encode(JSON.stringify(frame));
}

function encodedBlock(input: RecorderBlockInput) {
  const encoded = encodeRecorderBlock(input);
  return { encoded, decoded: decodeRecorderBlock(encoded) };
}
