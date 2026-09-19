export type MonitorExportDestination = "opfs" | "folder" | "hugging-face";

export interface MonitorAutomaticExportPreference {
  destination: "opfs" | "folder" | null;
  cadence: "cycle" | "task";
}
export type MonitorUploadCadence = "cycle" | "task" | "session";
export function loadAutomaticUploadEnabled(): boolean | null {
  try {
    const value = localStorage.getItem("ceres.monitor.automatic-upload.v1");
    return value === "true" ? true : value === "false" ? false : null;
  } catch { return null; }
}
export function storeAutomaticUploadEnabled(value: boolean) {
  try { localStorage.setItem("ceres.monitor.automatic-upload.v1", String(value)); } catch { /* Keep the current preference. */ }
}
export function loadUploadCadence(): MonitorUploadCadence {
  try {
    const value = localStorage.getItem("ceres.monitor.upload-cadence.v1");
    if (value === "task" || value === "session") return value;
  } catch { /* Use cycle uploads by default. */ }
  return "cycle";
}
export function storeUploadCadence(value: MonitorUploadCadence) {
  try { localStorage.setItem("ceres.monitor.upload-cadence.v1", value); } catch { /* Keep the in-memory cadence. */ }
}

const storageKey = "ceres.monitor.export-destination.v1";
const automaticStorageKey = "ceres.monitor.automatic-export.v1";

export function loadAutomaticExportPreference(): MonitorAutomaticExportPreference {
  try {
    const value = JSON.parse(localStorage.getItem(automaticStorageKey) ?? "null");
    if (value && (value.destination === "opfs" || value.destination === "folder" || value.destination === null)
      && (value.cadence === "cycle" || value.cadence === "task")) return value;
  } catch {
    // Use manual export when the preference is unavailable.
  }
  return { destination: null, cadence: "cycle" };
}

export function storeAutomaticExportPreference(value: MonitorAutomaticExportPreference) {
  try { localStorage.setItem(automaticStorageKey, JSON.stringify(value)); } catch { /* Keep the in-memory preference. */ }
}

export async function savedExportFolder(value?: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ceres-monitor-export-preferences", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("preferences");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("preferences", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("preferences");
      const operation = value ? store.put(value, "folder") : store.get("folder");
      transaction.oncomplete = () => { database.close(); resolve(value ?? operation.result ?? null); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
}

export function loadMonitorExportDestination(fallback: MonitorExportDestination): MonitorExportDestination {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "opfs" || stored === "folder" || stored === "hugging-face") return stored;
  } catch {
    // Keep the selected destination usable when browser storage is unavailable.
  }
  return fallback;
}

export function storeMonitorExportDestination(destination: MonitorExportDestination) {
  try {
    localStorage.setItem(storageKey, destination);
  } catch {
    // The in-memory preference remains available for this monitor.
  }
}
