import type { SessionSnapshot } from "../../shared/protocol.js";

export const monitorSnapshotFileName = "session.json" as const;
export const monitorSnapshotTemporaryFileName = "session.json.tmp" as const;
export const monitorSnapshotCatalogueFormat = "ceres-monitor-session-catalogue" as const;
export const monitorSnapshotCatalogueVersion = 1 as const;

export type MonitorSnapshotCandidateName =
  | typeof monitorSnapshotFileName
  | typeof monitorSnapshotTemporaryFileName;

export interface MonitorSnapshotCandidate {
  name: MonitorSnapshotCandidateName;
  data: Uint8Array | null;
  lastModified: number | null;
  error?: string;
}

export interface MonitorSnapshotRecoveryPlan {
  snapshot: SessionSnapshot | null;
  selectedData: Uint8Array | null;
  generation: number;
  promoteTemporary: boolean;
  removeTemporary: boolean;
}

interface ValidMonitorSnapshotCandidate extends MonitorSnapshotCandidate {
  data: Uint8Array;
  lastModified: number;
  snapshot: SessionSnapshot;
  generation: number;
}

interface ParsedMonitorSnapshotCandidate {
  candidate: ValidMonitorSnapshotCandidate | null;
  error: string | null;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

interface MonitorSnapshotCatalogueEnvelope {
  format: typeof monitorSnapshotCatalogueFormat;
  version: typeof monitorSnapshotCatalogueVersion;
  generation: number;
  snapshot: SessionSnapshot;
}

export function encodeMonitorSnapshotCatalogue(snapshot: SessionSnapshot, generation: number) {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("Monitor snapshot catalogue generation is invalid");
  }
  const envelope: MonitorSnapshotCatalogueEnvelope = {
    format: monitorSnapshotCatalogueFormat,
    version: monitorSnapshotCatalogueVersion,
    generation,
    snapshot,
  };
  return textEncoder.encode(JSON.stringify(envelope));
}

/**
 * Selects the committed catalogue using its embedded generation as the transaction order.
 * Legacy catalogues have generation zero and use modification time, with a temporary file
 * winning a tie because its staging location records an interrupted promotion.
 */
export function planMonitorSnapshotRecovery(
  expectedSessionId: string,
  candidates: MonitorSnapshotCandidate[],
): MonitorSnapshotRecoveryPlan {
  const byName = new Map<MonitorSnapshotCandidateName, MonitorSnapshotCandidate>();
  for (const candidate of candidates) {
    if (byName.has(candidate.name)) throw new Error(`Duplicate monitor snapshot candidate ${candidate.name}`);
    byName.set(candidate.name, candidate);
  }

  const final = parseCandidate(expectedSessionId, byName.get(monitorSnapshotFileName));
  const temporary = parseCandidate(expectedSessionId, byName.get(monitorSnapshotTemporaryFileName));
  const finalExists = byName.has(monitorSnapshotFileName);
  const temporaryExists = byName.has(monitorSnapshotTemporaryFileName);

  if (!finalExists && !temporaryExists) return {
    snapshot: null,
    selectedData: null,
    generation: 0,
    promoteTemporary: false,
    removeTemporary: false,
  };

  if (temporary.candidate && !final.candidate) return {
    snapshot: temporary.candidate.snapshot,
    selectedData: temporary.candidate.data,
    generation: temporary.candidate.generation,
    promoteTemporary: true,
    removeTemporary: true,
  };

  if (final.candidate && !temporary.candidate) return {
    snapshot: final.candidate.snapshot,
    selectedData: final.candidate.data,
    generation: final.candidate.generation,
    promoteTemporary: false,
    removeTemporary: temporaryExists,
  };

  if (final.candidate && temporary.candidate) {
    if (final.candidate.generation === temporary.candidate.generation
      && final.candidate.generation > 0
      && !sameBytes(final.candidate.data, temporary.candidate.data)) {
      throw new Error(`Monitor recorder session catalogue generation ${final.candidate.generation} conflicts`);
    }
    const promoteTemporary = temporary.candidate.generation !== final.candidate.generation
      ? temporary.candidate.generation > final.candidate.generation
      : temporary.candidate.generation === 0
        && temporary.candidate.lastModified >= final.candidate.lastModified
        && !sameBytes(final.candidate.data, temporary.candidate.data);
    const selected = promoteTemporary ? temporary.candidate : final.candidate;
    return {
      snapshot: selected.snapshot,
      selectedData: selected.data,
      generation: selected.generation,
      promoteTemporary,
      removeTemporary: true,
    };
  }

  const details = [
    finalExists ? `${monitorSnapshotFileName}: ${final.error ?? "invalid"}` : `${monitorSnapshotFileName}: missing`,
    temporaryExists
      ? `${monitorSnapshotTemporaryFileName}: ${temporary.error ?? "invalid"}`
      : `${monitorSnapshotTemporaryFileName}: missing`,
  ].join("; ");
  throw new Error(`Monitor recorder session catalogue is invalid (${details})`);
}

function parseCandidate(
  expectedSessionId: string,
  candidate: MonitorSnapshotCandidate | undefined,
): ParsedMonitorSnapshotCandidate {
  if (!candidate) return { candidate: null, error: null };
  if (!candidate.data) return {
    candidate: null,
    error: candidate.error?.trim() || "file could not be read",
  };
  if (!Number.isFinite(candidate.lastModified) || (candidate.lastModified ?? -1) < 0) return {
    candidate: null,
    error: "modification time is invalid",
  };

  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(candidate.data));
  } catch {
    return { candidate: null, error: "file is not valid UTF-8 JSON" };
  }
  const envelope = parseEnvelope(value);
  const snapshot = envelope ? envelope.snapshot : value;
  const generation = envelope?.generation ?? 0;
  if (!isSessionSnapshot(snapshot, expectedSessionId)) return {
    candidate: null,
    error: "snapshot structure or session identifier is invalid",
  };
  return {
    candidate: {
      ...candidate,
      data: candidate.data,
      lastModified: candidate.lastModified as number,
      snapshot,
      generation,
    },
    error: null,
  };
}

function parseEnvelope(value: unknown): MonitorSnapshotCatalogueEnvelope | null {
  if (!isRecord(value) || value.format !== monitorSnapshotCatalogueFormat) return null;
  if (value.version !== monitorSnapshotCatalogueVersion
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) <= 0
    || !("snapshot" in value)) return null;
  return value as unknown as MonitorSnapshotCatalogueEnvelope;
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isSessionSnapshot(value: unknown, expectedSessionId: string): value is SessionSnapshot {
  if (!isRecord(value)
    || value.sessionId !== expectedSessionId
    || typeof value.startedAt !== "string"
    || !isRecord(value.features)
    || typeof value.features.speech !== "boolean"
    || !isRecord(value.handDisplay)
    || typeof value.captureConnected !== "boolean"
    || !isNonNegativeInteger(value.monitorCount)
    || typeof value.recording !== "boolean"
    || !isNonNegativeInteger(value.activeTaskIndex)
    || !isRecord(value.run)
    || !isRecord(value.configuration)
    || !Array.isArray(value.configuration.tasks)
    || !isRecord(value.configurationStatus)
    || !isNonNegativeInteger(value.configurationStatus.revision)
    || typeof value.configurationStatus.checksum !== "string"
    || !isReadiness(value.sequenceReadiness)
    || !isReadiness(value.recordingReadiness)
    || !isNullableRecord(value.currentEpisode)
    || !isNullableRecord(value.pendingEpisode)
    || !Array.isArray(value.episodes)
    || !Array.isArray(value.attempts)
    || !Array.isArray(value.jobs)
    || !isRecord(value.promptAudioStatus)
    || !Array.isArray(value.promptDeliveries)
    || !Array.isArray(value.commandLog)
    || !isRecord(value.captureStatus)) return false;
  return true;
}

function isReadiness(value: unknown) {
  return isRecord(value) && typeof value.ready === "boolean" && Array.isArray(value.blockers);
}

function isNullableRecord(value: unknown) {
  return value === null || isRecord(value);
}

function isNonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
