import type { HandState, SensorFrame } from "./protocol.js";

export const HAND_SPEED_WARNING_MPS = 1.2;
export const HAND_SPEED_CRITICAL_MPS = 2;
export const HAND_SPEED_CLEAR_MPS = 1;

export interface HandSpeedSample {
  leftMps: number;
  rightMps: number;
  leftTracked: boolean;
  rightTracked: boolean;
  leftWarning: boolean;
  rightWarning: boolean;
  leftWarningStarted: boolean;
  rightWarningStarted: boolean;
  leftTrackingLost: boolean;
  rightTrackingLost: boolean;
}

export interface CaptureHealthInput {
  captureConnected: boolean;
  cameraReady: boolean;
  xrActive: boolean;
  handTracking: "waiting" | "active" | "unavailable";
  recorder: "idle" | "arming" | "armed" | "recording" | "paused" | "failed";
  sensorRateHz: number;
  targetRateHz: number;
  gapCount: number;
  droppedFrameCount: number;
  leftHandSpeedMps: number;
  rightHandSpeedMps: number;
  leftHandWarning: boolean;
  rightHandWarning: boolean;
}

export interface CaptureHealthSummary {
  decision: "go" | "caution" | "stop";
  reasons: string[];
}

export class HandSpeedTracker {
  private previous: Pick<SensorFrame, "timestampMs" | "leftHand" | "rightHand"> | null = null;
  private leftMps = 0;
  private rightMps = 0;
  private leftWarning = false;
  private rightWarning = false;

  update(frame: Pick<SensorFrame, "timestampMs" | "leftHand" | "rightHand">): HandSpeedSample {
    const previous = this.previous;
    const elapsedSeconds = previous ? (frame.timestampMs - previous.timestampMs) / 1_000 : 0;
    const leftInstant = previous ? measureHandMotion(previous.leftHand, frame.leftHand, elapsedSeconds) : 0;
    const rightInstant = previous ? measureHandMotion(previous.rightHand, frame.rightHand, elapsedSeconds) : 0;
    this.leftMps = frame.leftHand.tracked ? this.leftMps * .55 + leftInstant * .45 : 0;
    this.rightMps = frame.rightHand.tracked ? this.rightMps * .55 + rightInstant * .45 : 0;
    const priorLeftWarning = this.leftWarning;
    const priorRightWarning = this.rightWarning;
    this.leftWarning = warningWithHysteresis(this.leftWarning, frame.leftHand.tracked, this.leftMps);
    this.rightWarning = warningWithHysteresis(this.rightWarning, frame.rightHand.tracked, this.rightMps);
    const sample: HandSpeedSample = {
      leftMps: this.leftMps,
      rightMps: this.rightMps,
      leftTracked: frame.leftHand.tracked,
      rightTracked: frame.rightHand.tracked,
      leftWarning: this.leftWarning,
      rightWarning: this.rightWarning,
      leftWarningStarted: !priorLeftWarning && this.leftWarning,
      rightWarningStarted: !priorRightWarning && this.rightWarning,
      leftTrackingLost: Boolean(previous?.leftHand.tracked && !frame.leftHand.tracked),
      rightTrackingLost: Boolean(previous?.rightHand.tracked && !frame.rightHand.tracked),
    };
    this.previous = frame;
    return sample;
  }

  reset() {
    this.previous = null;
    this.leftMps = 0;
    this.rightMps = 0;
    this.leftWarning = false;
    this.rightWarning = false;
  }
}

export function measureHandMotion(previous: HandState, current: HandState, elapsedSeconds: number) {
  if (!previous.tracked || !current.tracked || elapsedSeconds <= 0 || elapsedSeconds >= .5) return 0;
  let squaredDistance = 0;
  let samples = 0;
  for (const [name, joint] of Object.entries(current.joints)) {
    const prior = previous.joints[name];
    if (!prior) continue;
    const dx = joint.position.x - prior.position.x;
    const dy = joint.position.y - prior.position.y;
    const dz = joint.position.z - prior.position.z;
    squaredDistance += dx * dx + dy * dy + dz * dz;
    samples += 1;
  }
  return samples ? Math.sqrt(squaredDistance / samples) / elapsedSeconds : 0;
}

export function captureHealthSummary(input: CaptureHealthInput): CaptureHealthSummary {
  if (!input.captureConnected) return { decision: "stop", reasons: ["Demonstrator capture is disconnected"] };
  const stopReasons: string[] = [];
  const cautionReasons: string[] = [];
  if (!input.cameraReady) cautionReasons.push("Outward camera is not ready");
  if (!input.xrActive) cautionReasons.push("XR session is not active");
  if (input.recorder === "failed") stopReasons.push("Durable recorder has failed");
  else if (!["arming", "armed", "recording"].includes(input.recorder)) stopReasons.push("Durable recorder is not armed");
  if (input.handTracking === "unavailable") cautionReasons.push("Hand tracking is unavailable");
  else if (input.handTracking !== "active") cautionReasons.push("Hand tracking is waiting");
  const targetRateHz = Math.max(1, input.targetRateHz);
  if (input.sensorRateHz < targetRateHz * .5) cautionReasons.push("Sensor cadence is below half the configured rate");
  else if (input.sensorRateHz < targetRateHz * .9) cautionReasons.push("Sensor cadence is below the configured rate");
  const maximumHandSpeed = Math.max(input.leftHandSpeedMps, input.rightHandSpeedMps);
  if (maximumHandSpeed >= HAND_SPEED_CRITICAL_MPS) cautionReasons.push("Hand motion exceeds the critical speed");
  else if (input.leftHandWarning || input.rightHandWarning) cautionReasons.push(handWarningReason(input));
  if (input.gapCount > 0) cautionReasons.push(`${input.gapCount} recorder gap${input.gapCount === 1 ? "" : "s"}`);
  if (input.droppedFrameCount > 0) cautionReasons.push(`${input.droppedFrameCount} monitor frame${input.droppedFrameCount === 1 ? "" : "s"} dropped`);
  if (stopReasons.length > 0) return { decision: "stop", reasons: [...stopReasons, ...cautionReasons] };
  if (cautionReasons.length > 0) return { decision: "caution", reasons: cautionReasons };
  return { decision: "go", reasons: [] };
}

function handWarningReason(input: CaptureHealthInput) {
  if (input.leftHandWarning && input.rightHandWarning) return "Both hands are moving too quickly";
  return `${input.leftHandWarning ? "Left" : "Right"} hand is moving too quickly`;
}

function warningWithHysteresis(active: boolean, tracked: boolean, speedMps: number) {
  if (!tracked) return false;
  return active ? speedMps >= HAND_SPEED_CLEAR_MPS : speedMps >= HAND_SPEED_WARNING_MPS;
}
