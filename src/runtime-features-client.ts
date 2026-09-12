import type { RuntimeFeatures } from "../shared/protocol.js";

export interface RuntimeFeatureResult {
  features: RuntimeFeatures;
  available: boolean;
}

const RUNTIME_FEATURE_RECOVERY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

export interface RuntimeFeatureTimerHost {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(timer: number): void;
}

export class RuntimeFeatureRecovery {
  private timer: number | null = null;
  private attempt = 0;

  get pending() {
    return this.timer !== null;
  }

  schedule(timerHost: RuntimeFeatureTimerHost, retry: () => void) {
    if (this.timer !== null) return false;
    const delayMs = RUNTIME_FEATURE_RECOVERY_DELAYS_MS[
      Math.min(this.attempt, RUNTIME_FEATURE_RECOVERY_DELAYS_MS.length - 1)
    ]!;
    this.attempt += 1;
    this.timer = timerHost.setTimeout(() => {
      this.timer = null;
      retry();
    }, delayMs);
    return true;
  }

  cancel(timerHost: RuntimeFeatureTimerHost) {
    if (this.timer !== null) timerHost.clearTimeout(this.timer);
    this.timer = null;
  }

  reset(timerHost: RuntimeFeatureTimerHost) {
    this.cancel(timerHost);
    this.attempt = 0;
  }
}

export async function loadRuntimeFeatures(
  fallback: RuntimeFeatures,
  timeoutMs = 3_000,
): Promise<RuntimeFeatureResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Runtime feature status is unavailable");
    const features = (await response.json() as { features?: { speech?: unknown; relayedConnection?: unknown } }).features;
    const speech = features?.speech;
    if (typeof speech !== "boolean") throw new Error("Runtime feature status is invalid");
    const relayedConnection = typeof features?.relayedConnection === "boolean"
      ? features.relayedConnection
      : fallback.relayedConnection;
    return {
      features: {
        speech,
        ...(typeof relayedConnection === "boolean" ? { relayedConnection } : {}),
      },
      available: true,
    };
  } catch {
    return { features: fallback, available: false };
  } finally {
    window.clearTimeout(timeout);
  }
}
