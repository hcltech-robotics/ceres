import assert from "node:assert/strict";
import test from "node:test";
import { bridgeVideoEncoding, configureBridgeVideo, parseBridgeVideoQuality } from "../src/bridge/video-quality.js";
import { BridgeVideoStatsSampler } from "../src/bridge/video-stats.js";

test("Camera quality preserves native aspect ratio and respects advertised capabilities", async () => {
  const requests: MediaTrackConstraints[] = [];
  const track = { contentHint: "motion", getCapabilities: () => ({ width: { min: 320, max: 1024 }, frameRate: { min: 10, max: 25 } }),
    applyConstraints: async (constraints: MediaTrackConstraints) => { requests.push(constraints); } } as unknown as MediaStreamTrack;
  await configureBridgeVideo(track, "high");
  assert.deepEqual(requests, [{ width: { ideal: 1024 }, frameRate: { ideal: 25 } }]);
  assert.equal(track.contentHint, "detail");
  assert.deepEqual(bridgeVideoEncoding("high", 1024), { maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 });
  assert.equal(parseBridgeVideoQuality("__proto__"), "high");
  assert.equal(parseBridgeVideoQuality("maximum"), "maximum");
});

test("Fixed camera modes remain usable but unexpected device failures propagate", async () => {
  const track = { contentHint: "", applyConstraints: async () => { throw Object.assign(new Error("Fixed mode"), { name: "OverconstrainedError" }); } } as unknown as MediaStreamTrack;
  await configureBridgeVideo(track, "maximum");
  assert.equal(track.contentHint, "detail");
  track.applyConstraints = async () => { throw new Error("Camera disconnected"); };
  await assert.rejects(configureBridgeVideo(track, "high"), /disconnected/);
});

test("Video telemetry reports interval throughput and resets safely across peers", () => {
  const sampler = new BridgeVideoStatsSampler();
  const report = (timestamp: number, frames: number, bytes: number, qp: number) => new Map([
    ["codec", { mimeType: "video/H264" }],
    ["video", { id: "video", type: "outbound-rtp", kind: "video", timestamp, framesEncoded: frames, bytesSent: bytes,
      frameWidth: 1280, frameHeight: 960, totalEncodeTime: frames / 1000, packetsSent: frames * 10,
      totalPacketSendDelay: frames / 100, qpSum: qp, codecId: "codec", qualityLimitationReason: "bandwidth", encoderImplementation: "hardware" }],
  ]) as unknown as RTCStatsReport;
  sampler.sample(report(1000, 30, 1_000_000, 900));
  const stats = sampler.sample(report(1500, 45, 1_500_000, 1350));
  assert.equal(stats.bitrate, 8_000_000);
  assert.equal(stats.fps, 30);
  assert.equal(stats.qp, 30);
  assert.ok(Math.abs(stats.encodeMs - 1) < 1e-9);
  assert.equal(stats.codec, "video/H264");
  assert.equal(stats.limitation, "bandwidth");
  assert.equal(sampler.sample(report(2000, 60, 2_000_000, 1800), true).bitrate, 0);
  assert.equal(sampler.sample(report(2500, 2, 1000, 60)).bitrate, 0);
  assert.equal(sampler.sample(undefined).width, 0);
});
