import assert from "node:assert/strict";
import test from "node:test";
import { XRSystem } from "iwer";
import { iwerRuntimeDetected, syntheticSensorSourceRequested } from "../src/sensor-source.js";

test("only enables synthetic sensor frames through an explicit simulation query", () => {
  assert.equal(syntheticSensorSourceRequested("", true), false);
  assert.equal(syntheticSensorSourceRequested("?session=dd303872", true), false);
  assert.equal(syntheticSensorSourceRequested("?simulation=0", true), false);
  assert.equal(syntheticSensorSourceRequested("?simulation=1", true), true);
  assert.equal(syntheticSensorSourceRequested("?session=dd303872&simulation=1", true), true);
  assert.equal(syntheticSensorSourceRequested("?simulation=1", false), false);
});

test("detects standard, legacy and managed IWER runtimes", () => {
  assert.equal(iwerRuntimeDetected({ IWER: {} }), true);
  assert.equal(iwerRuntimeDetected({ IWER_DEVICE: {} }), true);
  assert.equal(iwerRuntimeDetected({ __IWER_MCP_MANAGED: true }), true);
  assert.equal(iwerRuntimeDetected({}), false);
});

test("detects the canonical ESM IWER XRSystem without a window marker", () => {
  const xr = new XRSystem({} as never);
  assert.equal(iwerRuntimeDetected({ navigator: { xr } }), true);
});
