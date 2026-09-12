import type { ClientMessage, SensorFrame, ServerMessage, SessionSnapshot } from "../shared/protocol.js";
import { HandSpeedTracker } from "../shared/capture-quality.js";
import { MonitorLoadController } from "./monitor-load-controller.js";
import { MonitorEpisodeReplaySource } from "./monitor-episode-review.js";
import { MonitorRenderer } from "./monitor-renderer.js";
import type { MonitorReadout, MonitorVisualSettings } from "./monitor-worker-session.js";
import { closestSensorFrame, senderTimestampForVideoFrame } from "./video-frame-sync.js";

interface InitMessage {
  type: "init";
  sessionId: string;
  wsUrl: string | null;
  poseCanvas: OffscreenCanvas | null;
  signalCanvas: OffscreenCanvas | null;
  pixelRatio: number;
}

type IncomingMessage = InitMessage
  | { type: "send"; message: ClientMessage }
  | { type: "peer-message"; message: Extract<ServerMessage, { type: "capture-status" | "sensor-frame" }> }
  | { type: "visual-settings"; settings: MonitorVisualSettings }
  | { type: "video-frame"; captureTimestampMs: number }
  | { type: "episode-replay"; frames: SensorFrame[] }
  | { type: "clear-episode-replay" }
  | { type: "resize"; poseWidth: number; poseHeight: number; signalWidth: number; signalHeight: number }
  | { type: "close" };

const scope = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: MessageEvent<IncomingMessage>) => void): void;
  postMessage(message: unknown): void;
};

const load = new MonitorLoadController();
let renderer: MonitorRenderer | null = null;
let socket: WebSocket | null = null;
let sessionId = "";
let wsUrl: string | null = null;
let reconnectTimer: number | null = null;
let closed = false;
const episodeReplaySource = new MonitorEpisodeReplaySource();
const handSpeedTracker = new HandSpeedTracker();
let latestLiveLeftHandEnergyMps = 0;
let latestLiveRightHandEnergyMps = 0;
let latestLiveLeftHandWarning = false;
let latestLiveRightHandWarning = false;
let leftHandEnergyMps = 0;
let rightHandEnergyMps = 0;
let leftHandWarning = false;
let rightHandWarning = false;
let nextRenderAt = 0;
let nextDomAt = 0;
let droppedRenderFrames = 0;
let eligibleRenderFrames = 0;
let pendingVisualSettings: MonitorVisualSettings | null = null;
let pendingResize: Extract<IncomingMessage, { type: "resize" }> | null = null;
let renderDurationMs = 0;
let inboundBytes = 0;
let inboundWindowStartedAt = performance.now();
let inboundKbps = 0;
let announcedLoadStage = -1;
const sensorFrameBuffer: SensorFrame[] = [];
let videoSyncActiveUntil = 0;
let lastRenderedFrameIndex = -1;
let sensorClockOffsetMs: number | null = null;
let pendingRenderFrame: SensorFrame | null = null;
let renderTimer: number | null = null;

const emit = (event: string, value: unknown) => scope.postMessage({ type: "event", event, value });

const connect = () => {
  if (!sessionId || !wsUrl || closed) return;
  const active = new WebSocket(wsUrl);
  socket = active;
  active.addEventListener("open", () => {
    send({ type: "register", sessionId, role: "monitor" });
  });
  active.addEventListener("message", (event) => {
    try {
      const encoded = String(event.data);
      inboundBytes += encoded.length;
      const now = performance.now();
      const elapsed = now - inboundWindowStartedAt;
      if (elapsed >= 1_000) {
        inboundKbps = inboundBytes * 8 / elapsed;
        inboundBytes = 0;
        inboundWindowStartedAt = now;
      }
      const message = JSON.parse(encoded) as ServerMessage;
      receiveServerMessage(message);
    } catch {
      emit("error", { type: "error", message: "The server sent an unreadable message" });
    }
  });
  active.addEventListener("close", () => {
    if (socket === active) socket = null;
    emit("connection", false);
    if (!closed) reconnectTimer = setTimeout(connect, 1_000) as unknown as number;
  });
};

const send = (message: ClientMessage, lossy = false) => {
  const active = socket;
  if (!active || active.readyState !== WebSocket.OPEN) return;
  if (lossy && active.bufferedAmount > 256 * 1024) return;
  active.send(JSON.stringify(message));
};

const announceLoadStage = () => {
  if (load.stage === announcedLoadStage) return;
  announcedLoadStage = load.stage;
  send({ type: "monitor-load", stage: load.stage });
};

const observeLoad = (renderDurationMs: number, socketBufferedAmount: number) => {
  load.observe(renderDurationMs, socketBufferedAmount);
  announceLoadStage();
};

const receiveServerMessage = (message: ServerMessage) => {
  if (message.type === "session-registered") {
    if (message.sessionId !== sessionId || message.role !== "monitor") {
      emit("error", { type: "error", message: "The server acknowledged a different monitor session" });
      return;
    }
    announcedLoadStage = -1;
    emit("connection", true);
    announceLoadStage();
    return;
  }
  if (message.type === "sensor-frame") {
    receiveFrame(message.frame);
    return;
  }
  if (message.type === "snapshot") {
    emit("snapshot", message.snapshot);
    if (message.snapshot.lastFrame) receiveFrame(message.snapshot.lastFrame);
    return;
  }
  if (!load.runSecondaryWork && (message.type === "transcript" || message.type === "voice-command")) return;
  emit(message.type, message);
};

const receiveFrame = (frame: SensorFrame) => {
  const speed = handSpeedTracker.update(frame);
  latestLiveLeftHandEnergyMps = speed.leftMps;
  latestLiveRightHandEnergyMps = speed.rightMps;
  latestLiveLeftHandWarning = speed.leftWarning;
  latestLiveRightHandWarning = speed.rightWarning;
  episodeReplaySource.observeLiveFrame(frame);
  const now = performance.now();
  const observedClockOffset = Date.now() - frame.timestampMs;
  if (Number.isFinite(observedClockOffset)) {
    sensorClockOffsetMs = sensorClockOffsetMs === null ? observedClockOffset : Math.min(sensorClockOffsetMs, observedClockOffset);
  }
  if (sensorFrameBuffer.at(-1)?.frameIndex === frame.frameIndex) sensorFrameBuffer[sensorFrameBuffer.length - 1] = frame;
  else sensorFrameBuffer.push(frame);
  while (sensorFrameBuffer.length > 1 && frame.timestampMs - sensorFrameBuffer[0].timestampMs > 3_000) sensorFrameBuffer.shift();
  if (episodeReplaySource.active) return;
  leftHandEnergyMps = speed.leftMps;
  rightHandEnergyMps = speed.rightMps;
  leftHandWarning = speed.leftWarning;
  rightHandWarning = speed.rightWarning;
  if (now <= videoSyncActiveUntil) {
    publishReadout(now);
    return;
  }
  scheduleFrameRender(frame);
};

const scheduleFrameRender = (frame: SensorFrame) => {
  pendingRenderFrame = frame;
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    const pending = pendingRenderFrame;
    pendingRenderFrame = null;
    if (pending && !closed) renderFrame(pending, performance.now());
  }, 0) as unknown as number;
};

const renderFrame = (frame: SensorFrame, now: number) => {
  if (episodeReplaySource.active) return;
  if (frame.frameIndex === lastRenderedFrameIndex) {
    publishReadout(now);
    return;
  }
  const bufferedAmount = socket?.bufferedAmount ?? 0;
  if (bufferedAmount > 256 * 1024) {
    droppedRenderFrames += 1;
    observeLoad(0, bufferedAmount);
    publishReadout(now);
    return;
  }
  if (now < nextRenderAt) {
    droppedRenderFrames += 1;
    publishReadout(now);
    return;
  }
  lastRenderedFrameIndex = frame.frameIndex;
  eligibleRenderFrames += 1;
  if (load.dropMirrorFrames && eligibleRenderFrames % 2 === 0) {
    droppedRenderFrames += 1;
    nextRenderAt = now + load.renderIntervalMs;
    publishReadout(now);
    return;
  }
  renderer?.ingest(frame, load.keepHistory);
  const startedAt = performance.now();
  renderer?.render();
  const duration = performance.now() - startedAt;
  renderDurationMs = renderDurationMs === 0 ? duration : renderDurationMs * .9 + duration * .1;
  observeLoad(duration, bufferedAmount);
  nextRenderAt = now + load.renderIntervalMs;
  publishReadout(now);
};

const presentVideoFrame = (captureTimestampMs: number) => {
  if (episodeReplaySource.active) return;
  const now = performance.now();
  videoSyncActiveUntil = now + 1_000;
  const frame = closestSensorFrame(sensorFrameBuffer, senderTimestampForVideoFrame(captureTimestampMs, sensorClockOffsetMs));
  if (frame) scheduleFrameRender(frame);
};

const publishReadout = (now: number, force = false) => {
  const displayedFrame = episodeReplaySource.displayedFrame;
  if (!displayedFrame || (!force && now < nextDomAt)) return;
  const readout: MonitorReadout = {
    source: episodeReplaySource.active ? "episode" : "live",
    frameIndex: displayedFrame.frameIndex,
    traceCount: renderer?.traceCount ?? 0,
    headPosition: displayedFrame.head
      ? [displayedFrame.head.position.x, displayedFrame.head.position.y, displayedFrame.head.position.z]
      : null,
    leftHandTracked: displayedFrame.leftHand.tracked,
    rightHandTracked: displayedFrame.rightHand.tracked,
    leftWristPosition: displayedFrame.leftHand.joints.wrist
      ? [
          displayedFrame.leftHand.joints.wrist.position.x,
          displayedFrame.leftHand.joints.wrist.position.y,
          displayedFrame.leftHand.joints.wrist.position.z,
        ]
      : null,
    leftWristRotation: displayedFrame.leftHand.joints.wrist
      ? [
          displayedFrame.leftHand.joints.wrist.rotation.x,
          displayedFrame.leftHand.joints.wrist.rotation.y,
          displayedFrame.leftHand.joints.wrist.rotation.z,
          displayedFrame.leftHand.joints.wrist.rotation.w,
        ]
      : null,
    rightWristPosition: displayedFrame.rightHand.joints.wrist
      ? [
          displayedFrame.rightHand.joints.wrist.position.x,
          displayedFrame.rightHand.joints.wrist.position.y,
          displayedFrame.rightHand.joints.wrist.position.z,
        ]
      : null,
    rightWristRotation: displayedFrame.rightHand.joints.wrist
      ? [
          displayedFrame.rightHand.joints.wrist.rotation.x,
          displayedFrame.rightHand.joints.wrist.rotation.y,
          displayedFrame.rightHand.joints.wrist.rotation.z,
          displayedFrame.rightHand.joints.wrist.rotation.w,
        ]
      : null,
    handProjectionRegistered: displayedFrame.handProjection?.source === "calibrated-media-camera",
    leftProjectedJointCount: Object.keys(displayedFrame.handProjection?.leftHand.joints ?? {}).length,
    rightProjectedJointCount: Object.keys(displayedFrame.handProjection?.rightHand.joints ?? {}).length,
    trackedHandCount: renderer?.trackedHandCount ?? 0,
    manoLoaded: renderer?.manoLoaded ?? false,
    handMeshStatus: renderer?.meshStatus ?? "outline-fallback",
    leftHandEnergyMps,
    rightHandEnergyMps,
    leftHandWarning,
    rightHandWarning,
    leftPinch: displayedFrame.leftHand.pinch,
    rightPinch: displayedFrame.rightHand.pinch,
    droppedRenderFrames,
    overloadStage: load.stage,
    renderer: renderer?.kind ?? "none",
    renderDurationMs,
    gpuDurationMs: renderer?.gpuDurationMs ?? null,
    inboundKbps,
  };
  emit("monitor-readout", readout);
  nextDomAt = now + load.domIntervalMs;
};

const initialise = async (message: InitMessage) => {
  sessionId = message.sessionId;
  wsUrl = message.wsUrl;
  closed = false;
  if (message.poseCanvas && message.signalCanvas) renderer = await MonitorRenderer.create(message.poseCanvas, message.signalCanvas);
  if (renderer && pendingVisualSettings) renderer.setSettings(pendingVisualSettings);
  if (renderer && pendingResize) renderer.resize(pendingResize.poseWidth, pendingResize.poseHeight, pendingResize.signalWidth, pendingResize.signalHeight);
  if (wsUrl) connect();
  scope.postMessage({
    type: "ready",
    renderer: renderer?.kind ?? "none",
    crossOriginIsolated,
    handMeshStatus: renderer?.meshStatus ?? "outline-fallback",
  });
};

scope.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "init") {
    void initialise(message);
    return;
  }
  if (message.type === "send") {
    send(message.message);
    return;
  }
  if (message.type === "peer-message") {
    receiveServerMessage(message.message);
    return;
  }
  if (message.type === "visual-settings") {
    pendingVisualSettings = message.settings;
    renderer?.setSettings(message.settings);
    return;
  }
  if (message.type === "video-frame") {
    presentVideoFrame(message.captureTimestampMs);
    return;
  }
  if (message.type === "episode-replay") {
    if (renderTimer !== null) clearTimeout(renderTimer);
    renderTimer = null;
    pendingRenderFrame = null;
    episodeReplaySource.begin(message.frames);
    const replaySpeedTracker = new HandSpeedTracker();
    let replaySpeed = replaySpeedTracker.update(message.frames[0]);
    renderer?.clearHistory();
    message.frames.forEach((frame, index) => {
      if (index > 0) replaySpeed = replaySpeedTracker.update(frame);
      renderer?.ingest(frame, index > 0);
    });
    renderer?.render();
    leftHandEnergyMps = replaySpeed.leftMps;
    rightHandEnergyMps = replaySpeed.rightMps;
    leftHandWarning = replaySpeed.leftWarning;
    rightHandWarning = replaySpeed.rightWarning;
    lastRenderedFrameIndex = episodeReplaySource.displayedFrame?.frameIndex ?? -1;
    publishReadout(performance.now(), true);
    return;
  }
  if (message.type === "clear-episode-replay") {
    const latestLiveFrame = episodeReplaySource.clear();
    leftHandEnergyMps = latestLiveLeftHandEnergyMps;
    rightHandEnergyMps = latestLiveRightHandEnergyMps;
    leftHandWarning = latestLiveLeftHandWarning;
    rightHandWarning = latestLiveRightHandWarning;
    videoSyncActiveUntil = 0;
    renderer?.clearHistory();
    if (latestLiveFrame) renderer?.ingest(latestLiveFrame, false);
    renderer?.render();
    lastRenderedFrameIndex = latestLiveFrame?.frameIndex ?? -1;
    publishReadout(performance.now(), true);
    return;
  }
  if (message.type === "resize") {
    pendingResize = message;
    renderer?.resize(message.poseWidth, message.poseHeight, message.signalWidth, message.signalHeight);
    return;
  }
  closed = true;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (renderTimer !== null) clearTimeout(renderTimer);
  renderTimer = null;
  pendingRenderFrame = null;
  socket?.close(1000, "Monitor closed");
  socket = null;
});

export type { SessionSnapshot };
