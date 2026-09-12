import type { SessionSnapshot } from "../shared/protocol.js";

const SOLO_START_READINESS_TIMEOUT_MS = 20_000;

export interface SoloStartReadinessTarget {
  revision: number;
  checksum: string;
}

export interface SoloStartReadinessSource {
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
}

export function waitForSoloStartReadiness(
  source: SoloStartReadinessSource,
  target: SoloStartReadinessTarget,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  if (options.signal?.aborted) {
    return Promise.reject(new Error("Solo start preparation was cancelled"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    let onAbort: () => void = () => undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) globalThis.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    onAbort = () => settle(new Error("Solo start preparation was cancelled"));
    const inspect = (snapshot: SessionSnapshot) => {
      const status = snapshot.configurationStatus;
      if (status.revision !== target.revision || status.checksum !== target.checksum) {
        settle(new Error("The Solo run configuration changed while capture was preparing"));
        return;
      }
      if (status.state === "error") {
        settle(new Error(status.error ?? "The Solo run configuration could not be applied"));
        return;
      }
      if (snapshot.captureStatus.recorder === "failed") {
        settle(new Error(snapshot.captureStatus.lastError ?? "The Solo recorder failed while preparing"));
        return;
      }
      const exactConfigurationApplied = status.state === "applied"
        && status.appliedRevision === target.revision;
      if (exactConfigurationApplied
        && snapshot.captureStatus.recorder === "armed"
        && snapshot.sequenceReadiness.ready) {
        settle();
      }
    };
    timeout = globalThis.setTimeout(() => {
      settle(new Error("Solo capture did not become ready before the start timeout"));
    }, options.timeoutMs ?? SOLO_START_READINESS_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      unsubscribe = source.subscribe(inspect);
      if (settled) unsubscribe();
    } catch (error) {
      settle(error instanceof Error ? error : new Error("Solo capture readiness could not be observed"));
    }
  });
}
