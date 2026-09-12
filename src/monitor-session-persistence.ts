import { normaliseCaptureConfiguration, type CaptureConfiguration } from "../shared/protocol.js";
import {
  connectionProfileFromSearch,
  normaliseConnectionServer,
  type ConnectionProfile,
} from "./connection-profile.js";

const activeSessionStorageKey = "ceres.monitor.active-session.v1";
const runConfigurationStorageKey = (sessionId: string) => `ceres.monitor.run.${sessionId}.v1`;
const connectionPreferenceStorageKey = (sessionId: string) => `ceres.monitor.connection.${sessionId}.v1`;
const localStorageKeys = (sessionId: string) => [
  runConfigurationStorageKey(sessionId),
  connectionPreferenceStorageKey(sessionId),
];
const sessionStorageKeys = (sessionId: string) => [
  `ceres-hf-token:${sessionId}`,
  `ceres.remote.billing-code.${sessionId}`,
  `ceres.remote.api-key.${sessionId}`,
];
const safeSessionId = /^[A-Za-z0-9_-]{8,128}$/;

export type MonitorConnectionPanel = "local" | "direct" | "invite" | null;

export interface MonitorConnectionPreference {
  profile: ConnectionProfile;
  panel: MonitorConnectionPanel;
}

const browserStorage = () => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const browserSessionStorage = () => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function rememberMonitorSession(
  requestedSessionId: string | null,
  storage: Storage | null = browserStorage(),
) {
  if (requestedSessionId && safeSessionId.test(requestedSessionId)) {
    try {
      storage?.setItem(activeSessionStorageKey, requestedSessionId);
    } catch {
      // A blocked localStorage implementation falls back to URL persistence.
    }
    return requestedSessionId;
  }
  try {
    const stored = storage?.getItem(activeSessionStorageKey) ?? null;
    return stored && safeSessionId.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeMonitorRunConfiguration(
  sessionId: string,
  configuration: CaptureConfiguration,
  storage: Storage | null = browserStorage(),
) {
  if (!safeSessionId.test(sessionId)) return false;
  try {
    storage?.setItem(runConfigurationStorageKey(sessionId), JSON.stringify({
      schema: "ceres-monitor-run-v1",
      configuration,
    }));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function loadMonitorRunConfiguration(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): CaptureConfiguration | null {
  if (!safeSessionId.test(sessionId)) return null;
  try {
    const stored = storage?.getItem(runConfigurationStorageKey(sessionId));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { schema?: string; configuration?: Partial<CaptureConfiguration> };
    if (parsed.schema !== "ceres-monitor-run-v1" || !parsed.configuration) return null;
    return normaliseCaptureConfiguration(parsed.configuration);
  } catch {
    return null;
  }
}

export function storeMonitorConnectionPreference(
  sessionId: string,
  preference: MonitorConnectionPreference,
  storage: Storage | null = browserStorage(),
) {
  if (!safeSessionId.test(sessionId)) return false;
  const normalised = normaliseConnectionPreference(preference);
  if (!normalised) return false;
  try {
    storage?.setItem(connectionPreferenceStorageKey(sessionId), JSON.stringify({
      schema: "ceres-monitor-connection-v1",
      ...normalised,
    }));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function loadMonitorConnectionPreference(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): MonitorConnectionPreference | null {
  if (!safeSessionId.test(sessionId)) return null;
  try {
    const stored = storage?.getItem(connectionPreferenceStorageKey(sessionId));
    if (!stored) return null;
    const parsed = JSON.parse(stored) as {
      schema?: string;
      profile?: ConnectionProfile;
      panel?: MonitorConnectionPanel;
    };
    if (parsed.schema !== "ceres-monitor-connection-v1") return null;
    return normaliseConnectionPreference(parsed);
  } catch {
    return null;
  }
}

export function resolveMonitorConnectionPreference(
  sessionId: string,
  search = typeof location === "undefined" ? "" : location.search,
  storage: Storage | null = browserStorage(),
): MonitorConnectionPreference {
  const parameters = new URLSearchParams(search);
  const fromUrl = connectionProfileFromSearch(search);
  const stored = loadMonitorConnectionPreference(sessionId, storage);
  const explicitProfile = parameters.has("connection") || parameters.has("relay");
  if (!explicitProfile && stored) return stored;
  if (stored && sameConnectionProfile(stored.profile, fromUrl)) {
    return { profile: fromUrl, panel: stored.panel };
  }
  return {
    profile: fromUrl,
    panel: fromUrl.mode === "local" ? "local" : fromUrl.mode === "direct" ? "direct" : null,
  };
}

export function clearMonitorSessionPersistence(
  sessionId: string,
  storage: Storage | null = browserStorage(),
  volatileStorage: Storage | null = browserSessionStorage(),
) {
  try {
    if (storage?.getItem(activeSessionStorageKey) === sessionId) storage.removeItem(activeSessionStorageKey);
    for (const key of localStorageKeys(sessionId)) storage?.removeItem(key);
  } catch {
    // Restart still proceeds when localStorage is unavailable.
  }
  try {
    for (const key of sessionStorageKeys(sessionId)) volatileStorage?.removeItem(key);
  } catch {
    // Restart still proceeds when sessionStorage is unavailable.
  }
}

function normaliseConnectionPreference(value: unknown): MonitorConnectionPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MonitorConnectionPreference>;
  if (!candidate.profile || typeof candidate.profile !== "object") return null;
  const mode = candidate.profile.mode;
  if (mode !== "local" && mode !== "direct" && mode !== "relayed") return null;
  const relayUrl = mode === "local" ? null : normaliseConnectionServer(candidate.profile.relayUrl);
  if (mode !== "local" && !relayUrl) return null;
  const panel = candidate.panel === "local" || candidate.panel === "direct" || candidate.panel === "invite"
    ? candidate.panel
    : null;
  if (mode === "local" && panel !== "local") return null;
  if (mode === "direct" && panel !== "direct" && panel !== "invite") return null;
  if (mode === "relayed" && panel !== null) return null;
  return { profile: { mode, relayUrl }, panel };
}

function sameConnectionProfile(left: ConnectionProfile, right: ConnectionProfile) {
  return left.mode === right.mode && left.relayUrl === right.relayUrl;
}

export async function deleteMonitorSessionRecordings(sessionId: string) {
  if (!safeSessionId.test(sessionId) || typeof navigator === "undefined" || !("storage" in navigator)) return;
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
  if (!storage.getDirectory) return;
  const root = await storage.getDirectory();
  try {
    const ceres = await root.getDirectoryHandle("ceres-monitor-recordings");
    await ceres.removeEntry(sessionId, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
  }
}
