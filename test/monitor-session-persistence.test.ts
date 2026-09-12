import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfiguration } from "../shared/protocol.js";
import {
  clearMonitorSessionPersistence,
  loadMonitorConnectionPreference,
  loadMonitorRunConfiguration,
  rememberMonitorSession,
  resolveMonitorConnectionPreference,
  storeMonitorConnectionPreference,
  storeMonitorRunConfiguration,
} from "../src/monitor-session-persistence.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("keeps the active monitor session and run settings across reloads", () => {
  const storage = new MemoryStorage();
  rememberMonitorSession("session01", storage);
  storeMonitorRunConfiguration("session01", {
    ...defaultConfiguration,
    runTitle: "Persistent run",
    totalCycles: 5,
  }, storage);

  assert.equal(rememberMonitorSession(null, storage), "session01");
  assert.equal(loadMonitorRunConfiguration("session01", storage)?.runTitle, "Persistent run");
  assert.equal(loadMonitorRunConfiguration("session01", storage)?.totalCycles, 5);
});

test("a restart clears both the selected session and its run settings", () => {
  const storage = new MemoryStorage();
  rememberMonitorSession("session01", storage);
  storeMonitorRunConfiguration("session01", defaultConfiguration, storage);
  storeMonitorConnectionPreference("session01", {
    profile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    panel: "invite",
  }, storage);
  storage.setItem("ceres-hf-token:session01", "hf_secret");
  storage.setItem("ceres.remote.api-key.session01", "remote_secret");
  clearMonitorSessionPersistence("session01", storage, storage);

  assert.equal(rememberMonitorSession(null, storage), null);
  assert.equal(loadMonitorRunConfiguration("session01", storage), null);
  assert.equal(loadMonitorConnectionPreference("session01", storage), null);
  assert.equal(storage.getItem("ceres-hf-token:session01"), null);
  assert.equal(storage.getItem("ceres.remote.api-key.session01"), null);
});

test("restores the selected connection surface and non-secret settings for a session", () => {
  const storage = new MemoryStorage();
  storeMonitorConnectionPreference("session01", {
    profile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    panel: "invite",
  }, storage);

  assert.deepEqual(resolveMonitorConnectionPreference("session01", "?session=session01", storage), {
    profile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    panel: "invite",
  });
  assert.deepEqual(resolveMonitorConnectionPreference(
    "session01",
    "?session=session01&connection=direct&relay=https%3A%2F%2Frelay.example.test%2F",
    storage,
  ), {
    profile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    panel: "invite",
  });
});

test("an explicit connection URL overrides a stored profile without retaining secrets", () => {
  const storage = new MemoryStorage();
  storeMonitorConnectionPreference("session01", {
    profile: { mode: "local", relayUrl: null },
    panel: "local",
  }, storage);

  const resolved = resolveMonitorConnectionPreference(
    "session01",
    "?connection=direct&relay=https%3A%2F%2Frelay.example.test%2F&billingCode=secret",
    storage,
  );
  assert.deepEqual(resolved, {
    profile: { mode: "direct", relayUrl: "https://relay.example.test/" },
    panel: "direct",
  });
  storeMonitorConnectionPreference("session01", resolved, storage);
  assert.doesNotMatch(storage.getItem("ceres.monitor.connection.session01.v1") ?? "", /secret|billing/i);
});
