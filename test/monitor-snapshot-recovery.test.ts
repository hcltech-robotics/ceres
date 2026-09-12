import assert from "node:assert/strict";
import test from "node:test";

import { DirectSessionReducer } from "../src/direct-session-reducer.js";
import {
  encodeMonitorSnapshotCatalogue,
  monitorSnapshotFileName,
  monitorSnapshotTemporaryFileName,
  planMonitorSnapshotRecovery,
  type MonitorSnapshotCandidate,
} from "../src/recorder/monitor-snapshot-recovery.js";
import type { SessionSnapshot } from "../shared/protocol.js";

const sessionId = "snapshot_recovery_session_0001";
const encoder = new TextEncoder();

function snapshot(revision: number): SessionSnapshot {
  const value = new DirectSessionReducer(sessionId, () => 1_700_000_000_000).snapshot;
  value.configurationStatus.revision = revision;
  value.configurationStatus.checksum = `direct-${revision}`;
  return value;
}

function candidate(
  name: MonitorSnapshotCandidate["name"],
  value: SessionSnapshot,
  lastModified: number,
  generation = 0,
): MonitorSnapshotCandidate {
  return {
    name,
    data: generation > 0
      ? encodeMonitorSnapshotCatalogue(value, generation)
      : encoder.encode(JSON.stringify(value)),
    lastModified,
  };
}

test("returns an empty recovery plan when no catalogue exists", () => {
  assert.deepEqual(planMonitorSnapshotRecovery(sessionId, []), {
    snapshot: null,
    selectedData: null,
    generation: 0,
    promoteTemporary: false,
    removeTemporary: false,
  });
});

test("promotes a newer valid temporary catalogue over a stale final catalogue", () => {
  const final = candidate(monitorSnapshotFileName, snapshot(1), 100, 1);
  const temporary = candidate(monitorSnapshotTemporaryFileName, snapshot(2), 101, 2);
  const plan = planMonitorSnapshotRecovery(sessionId, [final, temporary]);

  assert.equal(plan.snapshot?.configurationStatus.revision, 2);
  assert.equal(plan.generation, 2);
  assert.equal(plan.promoteTemporary, true);
  assert.equal(plan.removeTemporary, true);
  assert.deepEqual(plan.selectedData, temporary.data);
});

test("uses embedded generation before file modification time", () => {
  const final = candidate(monitorSnapshotFileName, snapshot(2), 100, 2);
  const temporary = candidate(monitorSnapshotTemporaryFileName, snapshot(1), 200, 1);
  const plan = planMonitorSnapshotRecovery(sessionId, [final, temporary]);

  assert.equal(plan.snapshot?.configurationStatus.revision, 2);
  assert.equal(plan.generation, 2);
  assert.equal(plan.promoteTemporary, false);
  assert.equal(plan.removeTemporary, true);
  assert.deepEqual(plan.selectedData, final.data);
});

test("promotes a new temporary generation when stale final and temporary timestamps share a millisecond", () => {
  const stale = snapshot(2);
  const current = structuredClone(stale);
  current.run.status = "running";
  current.run.phase = "active-task";
  const final = candidate(monitorSnapshotFileName, stale, 100, 7);
  const temporary = candidate(monitorSnapshotTemporaryFileName, current, 100, 8);
  const plan = planMonitorSnapshotRecovery(sessionId, [final, temporary]);

  assert.equal(plan.snapshot?.configurationStatus.revision, 2);
  assert.equal(plan.snapshot?.run.status, "running");
  assert.equal(plan.generation, 8);
  assert.equal(plan.promoteTemporary, true);
  assert.deepEqual(plan.selectedData, temporary.data);
});

test("uses transactional staging to break tied legacy catalogue timestamps", () => {
  const final = candidate(monitorSnapshotFileName, snapshot(1), 100);
  const temporary = candidate(monitorSnapshotTemporaryFileName, snapshot(2), 100);
  const plan = planMonitorSnapshotRecovery(sessionId, [final, temporary]);

  assert.equal(plan.snapshot?.configurationStatus.revision, 2);
  assert.equal(plan.generation, 0);
  assert.equal(plan.promoteTemporary, true);
});

test("fails closed when an embedded generation has conflicting contents", () => {
  const final = candidate(monitorSnapshotFileName, snapshot(1), 100, 4);
  const temporary = candidate(monitorSnapshotTemporaryFileName, snapshot(2), 101, 4);

  assert.throws(
    () => planMonitorSnapshotRecovery(sessionId, [final, temporary]),
    /generation 4 conflicts/i,
  );
});

test("promotes a valid temporary catalogue over a missing or corrupt final catalogue", () => {
  const temporary = candidate(monitorSnapshotTemporaryFileName, snapshot(3), 103, 3);
  const corruptFinal: MonitorSnapshotCandidate = {
    name: monitorSnapshotFileName,
    data: encoder.encode("not json"),
    lastModified: 102,
  };

  for (const candidates of [[temporary], [corruptFinal, temporary]]) {
    const plan = planMonitorSnapshotRecovery(sessionId, candidates);
    assert.equal(plan.snapshot?.configurationStatus.revision, 3);
    assert.equal(plan.generation, 3);
    assert.equal(plan.promoteTemporary, true);
    assert.equal(plan.removeTemporary, true);
  }
});

test("discards a corrupt temporary catalogue without replacing a valid final catalogue", () => {
  const final = candidate(monitorSnapshotFileName, snapshot(4), 104);
  const corruptTemporary: MonitorSnapshotCandidate = {
    name: monitorSnapshotTemporaryFileName,
    data: encoder.encode("{broken"),
    lastModified: 105,
  };
  const plan = planMonitorSnapshotRecovery(sessionId, [final, corruptTemporary]);

  assert.equal(plan.snapshot?.configurationStatus.revision, 4);
  assert.equal(plan.promoteTemporary, false);
  assert.equal(plan.removeTemporary, true);
  assert.deepEqual(plan.selectedData, final.data);
});

test("fails closed when no valid catalogue can be recovered", () => {
  const corruptFinal: MonitorSnapshotCandidate = {
    name: monitorSnapshotFileName,
    data: encoder.encode("null"),
    lastModified: 100,
  };
  const foreignTemporary = candidate(
    monitorSnapshotTemporaryFileName,
    new DirectSessionReducer("foreign_snapshot_session_0001").snapshot,
    101,
  );

  assert.throws(
    () => planMonitorSnapshotRecovery(sessionId, [corruptFinal, foreignTemporary]),
    /session catalogue is invalid/i,
  );
});
