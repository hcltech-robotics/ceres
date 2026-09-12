import assert from "node:assert/strict";
import test from "node:test";
import { serverBindHost } from "../server/network-policy.js";

test("plain HTTP binds to loopback by default", () => {
  assert.equal(serverBindHost({}, false), "127.0.0.1");
});

test("trusted HTTPS binds to all interfaces by default", () => {
  assert.equal(serverBindHost({}, true), "0.0.0.0");
});

test("an explicit bind host overrides the transport default", () => {
  assert.equal(serverBindHost({ CERES_BIND_HOST: " 10.0.0.8 " }, false), "10.0.0.8");
});
