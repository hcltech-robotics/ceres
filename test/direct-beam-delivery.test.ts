import assert from "node:assert/strict";
import test from "node:test";
import { isDirectBeamDeliveryId } from "../shared/protocol.js";

test("accepts UUID delivery identifiers for direct Beam acknowledgements", () => {
  assert.equal(isDirectBeamDeliveryId("9b9f1e4c-a58d-4d27-a21b-6d9d2ae8b761"), true);
  assert.equal(isDirectBeamDeliveryId("9B9F1E4C-A58D-4D27-A21B-6D9D2AE8B761"), true);
});

test("rejects malformed direct Beam delivery identifiers", () => {
  assert.equal(isDirectBeamDeliveryId(""), false);
  assert.equal(isDirectBeamDeliveryId("beam-1"), false);
  assert.equal(isDirectBeamDeliveryId("00000000-0000-0000-0000-000000000000"), false);
  assert.equal(isDirectBeamDeliveryId({}), false);
});
