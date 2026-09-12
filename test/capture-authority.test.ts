import assert from "node:assert/strict";
import test from "node:test";

import type { HandDisplaySettings } from "../shared/hand-display.js";
import {
  defaultCaptureStatus,
  SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
  type CaptureStatus,
  type ClientMessage,
  type SensorFrame,
  type SessionSnapshot,
  type SoloStorageHeadroom,
  type WebRtcSignal,
} from "../shared/protocol.js";
import type {
  CaptureAuthorityControlAction,
  CaptureAuthorityEventMap,
} from "../src/capture-authority.js";
import { SessionClientCaptureAuthority } from "../src/session-client-capture-authority.js";
import { SoloCaptureAuthority } from "../src/solo-capture-authority.js";
import { SoloSessionController } from "../src/solo-session-controller.js";
import type {
  SoloRecorderControlMessage,
  SoloSessionOpenResult,
  SoloSessionPersistencePort,
} from "../src/solo-session-persistence.js";
import type { MonitorRecordingSummary } from "../src/recorder/monitor-recording-summary.js";

class FakePairedCaptureSession {
  readonly sessionId = "paired-authority";
  readonly role = "capture";
  readonly pairingId = "paired-device";
  bufferedAmount = 17;
  connected = 0;
  closed = 0;
  disposed = 0;
  captureIntentRequests = 0;
  xrActiveRequests = 0;
  readonly controls: Array<{ action: CaptureAuthorityControlAction; nextCursor?: string }> = [];
  readonly handDisplays: HandDisplaySettings[] = [];
  readonly sent: ClientMessage[] = [];
  readonly lossy: ClientMessage[] = [];
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on<T>(event: string, listener: (value: T) => void) {
    const entries = this.listeners.get(event) ?? new Set();
    entries.add(listener as (value: unknown) => void);
    this.listeners.set(event, entries);
    return () => {
      entries.delete(listener as (value: unknown) => void);
    };
  }

  emit<T>(event: string, value: T) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }

  connect() {
    this.connected += 1;
  }

  close() {
    this.closed += 1;
  }

  dispose() {
    this.disposed += 1;
  }

  control(action: CaptureAuthorityControlAction, nextCursor?: string) {
    this.controls.push({ action, ...(nextCursor ? { nextCursor } : {}) });
    return true;
  }

  setHandDisplay(settings: HandDisplaySettings) {
    this.handDisplays.push(structuredClone(settings));
  }

  requestCaptureIntent() {
    this.captureIntentRequests += 1;
    return true;
  }

  markXrActive() {
    this.xrActiveRequests += 1;
    return true;
  }

  send(message: ClientMessage) {
    this.sent.push(structuredClone(message));
    return true;
  }

  sendLossy(message: ClientMessage) {
    this.lossy.push(structuredClone(message));
    return true;
  }
}

class FakeSoloAuthorityPersistence implements SoloSessionPersistencePort {
  readonly saved: SessionSnapshot[] = [];
  readonly appended: Array<{ sequence: number; byteLength: number }> = [];
  readonly controls: SoloRecorderControlMessage[] = [];
  opened: SoloSessionOpenResult = { snapshot: null, nextSequence: 4 };
  controlSink: ((message: SoloRecorderControlMessage) => void) | null = null;
  closed = false;
  storageHeadroom: SoloStorageHeadroom = {
    state: "ready",
    availableBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES * 2,
    requiredBytes: SOLO_MINIMUM_STORAGE_HEADROOM_BYTES,
    checkedAtMs: 1,
    detail: "1024 MiB is available for Solo capture",
  };

  async open() {
    return structuredClone(this.opened);
  }

  async checkStorageHeadroom() {
    return structuredClone(this.storageHeadroom);
  }

  async saveSnapshot(snapshot: SessionSnapshot) {
    this.saved.push(structuredClone(snapshot));
  }

  appendRecorderBlock(sequence: number, block: ArrayBuffer) {
    this.appended.push({ sequence, byteLength: block.byteLength });
    return true;
  }

  async summarise(): Promise<MonitorRecordingSummary> {
    return {
      frameCount: 1,
      gapCount: 0,
      mediaChunkCount: 0,
      recorderSlotCount: 1,
      firstRecorderSequence: 0,
      lastRecorderSequence: 0,
    };
  }

  sendRecorderReady(nextSequence: number) {
    const message: SoloRecorderControlMessage = {
      type: "recorder-ready",
      sessionId: "solo-authority",
      nextSequence,
    };
    this.controls.push(message);
    this.controlSink?.(message);
  }

  setRecorderControlSink(sink: ((message: SoloRecorderControlMessage) => void) | null) {
    this.controlSink = sink;
  }

  async close() {
    this.closed = true;
  }
}

test("paired capture authority preserves SessionClient events and outbound semantics", () => {
  const session = new FakePairedCaptureSession();
  const authority = new SessionClientCaptureAuthority(session);
  const connections: boolean[] = [];
  const snapshots: SessionSnapshot[] = [];
  authority.on("connection", (connected) => connections.push(connected));
  authority.on("snapshot", (snapshot) => snapshots.push(snapshot));

  const snapshot = { sessionId: session.sessionId } as SessionSnapshot;
  session.emit("connection", true);
  session.emit("snapshot", snapshot);
  authority.connect();
  authority.control("success", "cursor-1");
  authority.setHandDisplay({
    handMode: "mesh",
    handShading: "normal",
    handTrail: "cog",
  });
  assert.equal(authority.requestCaptureIntent(), true);
  assert.equal(authority.markXrActive(), true);
  assert.equal(authority.configurationApplied(2, "checksum-2"), true);
  assert.equal(authority.publishCaptureStatus(defaultCaptureStatus), true);
  assert.equal(authority.publishPromptAudioStatus({ state: "ready", detail: "Ready" }), true);
  assert.equal(authority.sendAudioForAsr?.("audio/webm", Uint8Array.of(1, 2, 3).buffer), true);
  assert.equal(authority.acknowledgePrompt("prompt-1", "failed", "Playback failed"), true);
  assert.equal(authority.publishSensorFrame({ frameIndex: 4 } as SensorFrame), true);
  assert.equal(authority.publishRecorderResult({
    type: "recording-accepted",
    episodeId: "episode-1",
  }), true);
  assert.equal(authority.publishRecorderResult({
    type: "recording-rejected",
    episodeId: "episode-2",
    error: "Rejected",
  }), false);
  assert.equal(authority.publishRecorderResult({
    type: "recording-finalised",
    episodeId: "episode-1",
    error: "Finalisation warning",
  }), true);
  assert.equal(authority.publishWebRtcSignal("monitor-1", {
    type: "candidate",
    candidate: null,
  } as WebRtcSignal), true);
  authority.close();
  authority.dispose();

  assert.equal(authority.kind, "paired");
  assert.equal(authority.sessionId, session.sessionId);
  assert.equal(authority.pairingId, session.pairingId);
  assert.equal(authority.bufferedAmount, 17);
  assert.equal(authority.supportsPairing, true);
  assert.equal(authority.supportsPeerMedia, true);
  assert.equal(authority.recorderTransport, undefined);
  assert.deepEqual(connections, [true]);
  assert.equal(snapshots[0], snapshot);
  assert.equal(session.connected, 1);
  assert.equal(session.closed, 1);
  assert.equal(session.disposed, 1);
  assert.deepEqual(session.controls, [{ action: "success", nextCursor: "cursor-1" }]);
  assert.deepEqual(session.sent, [
    { type: "configuration-applied", revision: 2, checksum: "checksum-2" },
    { type: "capture-status", status: defaultCaptureStatus },
    { type: "prompt-audio-status", status: { state: "ready", detail: "Ready" } },
    { type: "audio-chunk", mimeType: "audio/webm", sequence: 0, dataBase64: "AQID" },
    {
      type: "prompt-ack",
      deliveryId: "prompt-1",
      state: "failed",
      error: "Playback failed",
    },
    { type: "recording-accepted", episodeId: "episode-1" },
    {
      type: "recording-finalised",
      episodeId: "episode-1",
      error: "Finalisation warning",
    },
    {
      type: "webrtc-signal",
      peerId: "monitor-1",
      signal: { type: "candidate", candidate: null },
    },
  ]);
  assert.deepEqual(session.lossy, [{ type: "sensor-frame", frame: { frameIndex: 4 } }]);
});

test("paired capture authority rejects non-capture SessionClient roles", () => {
  const session = new FakePairedCaptureSession();
  assert.throws(
    () => new SessionClientCaptureAuthority({ ...session, role: "monitor" }),
    /requires a capture SessionClient/,
  );
});

test("Solo capture authority stays local and bridges snapshots, grants and recorder control", async (context) => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let websocketAttempts = 0;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class {
      constructor() {
        websocketAttempts += 1;
        throw new Error("Solo must not open a WebSocket");
      }
    },
  });
  context.after(() => restoreGlobal("WebSocket", originalWebSocket));

  const persistence = new FakeSoloAuthorityPersistence();
  const controller = new SoloSessionController("solo-authority", {
    persistence,
    now: () => 1,
    allocateId: () => "solo-episode-1",
  });
  const authority = new SoloCaptureAuthority(controller);
  const connections: boolean[] = [];
  const configurations: CaptureAuthorityEventMap["configuration"][] = [];
  const snapshots: SessionSnapshot[] = [];
  const handDisplays: CaptureAuthorityEventMap["hand-display"][] = [];
  const grants: string[] = [];
  const recorderControls: unknown[] = [];
  authority.on("connection", (connected) => connections.push(connected));
  authority.on("configuration", (configuration) => configurations.push(configuration));
  authority.on("snapshot", (snapshot) => snapshots.push(snapshot));
  authority.on("hand-display", (settings) => handDisplays.push(settings));
  authority.on("capture-intent-granted", ({ type }) => grants.push(type));
  authority.on("capture-authority-granted", ({ type }) => grants.push(type));
  authority.recorderTransport.onControl((message) => recorderControls.push(message));

  await authority.connect();

  assert.equal(websocketAttempts, 0);
  assert.equal(authority.kind, "solo");
  assert.equal(authority.sessionId, "solo-authority");
  assert.equal(authority.pairingId, "solo-solo-authority");
  assert.equal(authority.bufferedAmount, 0);
  assert.equal(authority.supportsPairing, false);
  assert.equal(authority.supportsPeerMedia, false);
  assert.deepEqual(connections, [true]);
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0]?.configuration.recorderRateHz, 30);
  assert.equal(snapshots.at(-1)?.operatingMode, "solo");
  assert.deepEqual(recorderControls, [{
    type: "recorder-ready",
    sessionId: "solo-authority",
    nextSequence: 4,
  }]);
  assert.equal(authority.requestCaptureIntent(), true);
  assert.equal(authority.markXrActive(), true);
  assert.deepEqual(grants, [
    "capture-intent-granted",
    "capture-intent-granted",
    "capture-authority-granted",
  ]);
  assert.equal(authority.publishWebRtcSignal("monitor-1", {} as WebRtcSignal), false);

  const handDisplay: HandDisplaySettings = {
    handMode: "keypoints",
    handShading: "motion",
    handTrail: "cog",
  };
  assert.equal(authority.setHandDisplay(handDisplay), true);
  await authority.whenIdle();
  assert.deepEqual(controller.snapshot.handDisplay, handDisplay);
  assert.deepEqual(persistence.saved.at(-1)?.handDisplay, handDisplay);
  assert.deepEqual(handDisplays.at(-1), { type: "hand-display", settings: handDisplay });

  const readyStatus: CaptureStatus = {
    ...defaultCaptureStatus,
    camera: "ready",
    xr: "active",
    recorder: "armed",
  };
  assert.equal(authority.publishCaptureStatus(readyStatus), true);
  await authority.whenIdle();
  assert.equal(controller.snapshot.captureConnected, true);
  assert.equal(authority.recorderTransport.sendBlock(7, new ArrayBuffer(32)), true);
  assert.deepEqual(persistence.appended, [{ sequence: 7, byteLength: 32 }]);

  authority.close();
  await authority.whenIdle();
  assert.deepEqual(connections, [true, false]);
  assert.equal(authority.recorderTransport.sendBlock(8, new ArrayBuffer(8)), false);
  await authority.dispose();
  assert.equal(persistence.closed, true);
});

test("Solo capture authority rejects its initial connection when the session cannot mount", async () => {
  const mountError = new Error("This Solo session is already active in another tab");
  const persistence = new FakeSoloAuthorityPersistence();
  persistence.open = async () => {
    throw mountError;
  };
  const controller = new SoloSessionController("solo-authority", {
    persistence,
    now: () => 1,
    allocateId: () => "solo-episode-1",
  });
  const authority = new SoloCaptureAuthority(controller);
  const connections: boolean[] = [];
  const errors: CaptureAuthorityEventMap["error"][] = [];
  authority.on("connection", (connected) => connections.push(connected));
  authority.on("error", (error) => errors.push(error));

  await assert.rejects(authority.connect(), (error) => error === mountError);

  assert.deepEqual(connections, [false]);
  assert.deepEqual(errors, [{
    type: "error",
    message: mountError.message,
  }]);
  assert.equal(authority.publishCaptureStatus(defaultCaptureStatus), false);
  await authority.dispose();
  assert.equal(persistence.closed, true);
});

test("Solo capture authority shares one in-flight disposal through durable lease release", async () => {
  const persistence = new FakeSoloAuthorityPersistence();
  let releaseClose: (() => void) | null = null;
  let notifyCloseStarted: (() => void) | null = null;
  let closeCalls = 0;
  const closeStarted = new Promise<void>((resolve) => {
    notifyCloseStarted = resolve;
  });
  persistence.close = async () => {
    closeCalls += 1;
    notifyCloseStarted?.();
    await new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    persistence.closed = true;
  };
  const controller = new SoloSessionController("solo-authority", {
    persistence,
    now: () => 1,
    allocateId: () => "solo-episode-1",
  });
  const authority = new SoloCaptureAuthority(controller);
  await authority.connect();

  const firstDisposal = authority.dispose();
  const secondDisposal = authority.dispose();
  assert.equal(secondDisposal, firstDisposal);
  await closeStarted;
  let settled = false;
  void secondDisposal.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  releaseClose?.();
  await secondDisposal;
  assert.equal(closeCalls, 1);
  assert.equal(persistence.closed, true);
});

function restoreGlobal(key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
