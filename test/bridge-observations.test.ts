import assert from "node:assert/strict";
import test from "node:test";
import { Observations } from "../src/bridge/observations.js";
import { decodePose, XR_HAND_JOINTS } from "../shared/bridge-protocol.js";

test("One XR acquisition supplies current wire poses and HUD joints without waiting for video", () => {
  let x = 1, calls = 0;
  const transform = () => ({ position: { x, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } });
  const frame = { session: { inputSources: ["left", "right"].map(handedness => ({ handedness,
    hand: new Map(XR_HAND_JOINTS.map(name => [name, {}])) })) },
    getViewerPose: () => ({ transform: transform() }),
    getJointPose: () => { calls++; return { transform: transform(), radius: .01 }; },
  } as unknown as XRFrame;
  const space = {} as XRReferenceSpace, packets: ArrayBuffer[] = [];
  const channel = { readyState: "open", bufferedAmount: 0, send: (buffer: ArrayBuffer) => packets.push(buffer.slice(0)) } as unknown as RTCDataChannel;
  const observations = new Observations();
  observations.publish(frame, space, channel, 1, 1000, 2);
  assert.equal(calls, 50);
  assert.equal(observations.jointPose("left", "wrist")?.transform.position.x, 1);
  assert.equal(observations.hasSample(frame, space), true);
  assert.equal(observations.hasPublishedSample(frame, space), true);
  assert.equal(observations.hasSample(frame, {} as XRReferenceSpace), false);
  x = 2;
  observations.publish(frame, space, channel, 1, 2000, 3);
  assert.equal(calls, 100);
  assert.equal(observations.jointPose("left", "wrist")?.transform.position.x, 2);
  assert.equal(decodePose(packets[4]).observedUs, 2000);
  assert.equal(decodePose(packets[4]).sequence, 1);
  Object.assign(channel, { bufferedAmount: 8192 });
  observations.publish(frame, space, channel, 1, 3000, 4);
  assert.equal(calls, 100);
  assert.equal(observations.hasSample(frame, space), false);
  assert.equal(observations.hasPublishedSample(frame, space), false);
  assert.equal(packets.length, 6);
  assert.equal(observations.dropped, 1);
});

test("A partial pose send cannot authorise optional depth work for the current callback", () => {
  const observations = new Observations();
  const frame = { session: { inputSources: [] }, getViewerPose: () => null } as unknown as XRFrame;
  const space = {} as XRReferenceSpace;
  let calls = 0;
  observations.publish(frame, space, { readyState: "open", bufferedAmount: 0,
    send: () => { if (++calls === 2) throw new Error("Channel closed"); },
  } as unknown as RTCDataChannel, 1, 1000, 2);
  assert.equal(observations.hasSample(frame, space), true, "the acquired sample remains reusable by the HUD");
  assert.equal(observations.hasPublishedSample(frame, space), false);
  assert.equal(observations.dropped, 1);
});

test("Missing hands clear the shared frame sample and retain explicit wire validity", () => {
  const observations = new Observations(), packets: ArrayBuffer[] = [];
  const frame = { session: { inputSources: [] }, getViewerPose: () => null } as unknown as XRFrame;
  observations.publish(frame, {} as XRReferenceSpace,
    { readyState: "open", bufferedAmount: 0, send: (p: ArrayBuffer) => packets.push(p.slice(0)) } as unknown as RTCDataChannel,
    5, 1000, 2);
  assert.equal(observations.jointPose("left", "wrist"), null);
  assert.deepEqual(packets.map(p => decodePose(p).valid), [false, false, false]);
  observations.clearSample();
  assert.equal(observations.viewerPose, null);
});
