import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSnapshot } from "../shared/protocol.js";
import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import {
  waitForSoloStartReadiness,
  type SoloStartReadinessSource,
  type SoloStartReadinessTarget,
} from "../src/solo-start-readiness.js";

const TARGET: SoloStartReadinessTarget = {
  revision: 7,
  checksum: "configuration-checksum",
};

test("Solo start waits for the exact applied configuration, armed recorder and sequence readiness", async () => {
  const source = new MutableReadinessSource(pendingSnapshot());
  let settled = false;
  const ready = waitForSoloStartReadiness(source, TARGET, { timeoutMs: 1_000 })
    .then(() => {
      settled = true;
    });

  await Promise.resolve();
  assert.equal(settled, false);

  source.update((snapshot) => {
    snapshot.configurationStatus.state = "applied";
    snapshot.configurationStatus.appliedRevision = TARGET.revision;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  source.update((snapshot) => {
    snapshot.captureStatus.recorder = "armed";
  });
  await Promise.resolve();
  assert.equal(settled, false);

  source.update((snapshot) => {
    snapshot.sequenceReadiness = { ready: true, blockers: [] };
  });
  await ready;
  assert.equal(settled, true);
  assert.equal(source.subscriberCount, 0);
});

test("Solo start resolves an already-ready exact configuration and unsubscribes", async () => {
  const snapshot = pendingSnapshot();
  snapshot.configurationStatus.state = "applied";
  snapshot.configurationStatus.appliedRevision = TARGET.revision;
  snapshot.captureStatus.recorder = "armed";
  snapshot.sequenceReadiness = { ready: true, blockers: [] };
  const source = new MutableReadinessSource(snapshot);

  await waitForSoloStartReadiness(source, TARGET, { timeoutMs: 1_000 });

  assert.equal(source.subscriberCount, 0);
});

test("Solo start rejects a changed configuration revision or checksum", async () => {
  const source = new MutableReadinessSource(pendingSnapshot());
  const ready = waitForSoloStartReadiness(source, TARGET, { timeoutMs: 1_000 });

  source.update((snapshot) => {
    snapshot.configurationStatus.revision += 1;
  });

  await assert.rejects(ready, /configuration changed while capture was preparing/);
  assert.equal(source.subscriberCount, 0);
});

test("Solo start reports configuration and recorder failures", async () => {
  const configurationFailure = pendingSnapshot();
  configurationFailure.configurationStatus.state = "error";
  configurationFailure.configurationStatus.error = "Configuration rejected by capture";
  await assert.rejects(
    waitForSoloStartReadiness(
      new MutableReadinessSource(configurationFailure),
      TARGET,
      { timeoutMs: 1_000 },
    ),
    /Configuration rejected by capture/,
  );

  const recorderFailure = pendingSnapshot();
  recorderFailure.captureStatus.recorder = "failed";
  recorderFailure.captureStatus.lastError = "Recorder durability check failed";
  await assert.rejects(
    waitForSoloStartReadiness(
      new MutableReadinessSource(recorderFailure),
      TARGET,
      { timeoutMs: 1_000 },
    ),
    /Recorder durability check failed/,
  );
});

test("Solo start cancellation rejects and releases its subscription", async () => {
  const source = new MutableReadinessSource(pendingSnapshot());
  const controller = new AbortController();
  const ready = waitForSoloStartReadiness(source, TARGET, {
    signal: controller.signal,
    timeoutMs: 1_000,
  });

  controller.abort();

  await assert.rejects(ready, /start preparation was cancelled/);
  assert.equal(source.subscriberCount, 0);
});

test("Solo start timeout rejects and releases its subscription", async () => {
  const source = new MutableReadinessSource(pendingSnapshot());

  await assert.rejects(
    waitForSoloStartReadiness(source, TARGET, { timeoutMs: 5 }),
    /did not become ready before the start timeout/,
  );

  assert.equal(source.subscriberCount, 0);
});

class MutableReadinessSource implements SoloStartReadinessSource {
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();

  constructor(private value: SessionSnapshot) {}

  get subscriberCount() {
    return this.listeners.size;
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void) {
    this.listeners.add(listener);
    listener(structuredClone(this.value));
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(mutator: (snapshot: SessionSnapshot) => void) {
    mutator(this.value);
    for (const listener of this.listeners) listener(structuredClone(this.value));
  }
}

function pendingSnapshot() {
  const reducer = new DirectSessionReducer("solo-start-readiness-test");
  reducer.enableSolo({ startCountdownMs: 3_000 });
  const snapshot = reducer.snapshot;
  snapshot.configurationStatus = {
    state: "sent",
    revision: TARGET.revision,
    checksum: TARGET.checksum,
    appliedRevision: null,
    error: null,
  };
  snapshot.captureStatus.recorder = "arming";
  snapshot.captureStatus.lastError = null;
  snapshot.sequenceReadiness = {
    ready: false,
    blockers: [{
      code: "configuration-not-applied",
      message: "Configuration is waiting for the demonstrator",
    }],
  };
  return snapshot;
}
