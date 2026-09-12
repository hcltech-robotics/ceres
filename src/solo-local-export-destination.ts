import type { SoloDirectoryHandle } from "./solo-system-result-store.js";

export const SOLO_LOCAL_EXPORT_DATABASE = "ceres-solo-local-export";
export const SOLO_LOCAL_EXPORT_STORE = "settings";
export const SOLO_LOCAL_EXPORT_VERSION = 1;
const DESTINATION_KEY = "destination";
const FOLDER_JOB_KEY_PREFIX = "folder-job:";
const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type SoloLocalExportDestination = Readonly<
  | {
      version: 1;
      type: "browser";
    }
  | {
      version: 1;
      type: "folder";
      name: string;
      directoryHandle: SoloDirectoryHandle;
    }
>;

export type SoloLocalExportPermission = "granted" | "prompt" | "denied";

export interface SoloLocalExportDestinationBackend {
  read(): Promise<unknown>;
  write(destination: SoloLocalExportDestination): Promise<void>;
  readFolderJob(jobId: string): Promise<unknown>;
  writeFolderJob(jobId: string, destination: SoloLocalExportDestination): Promise<void>;
  deleteFolderJob(jobId: string): Promise<void>;
}

export const DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION: SoloLocalExportDestination = Object.freeze({
  version: 1,
  type: "browser",
});

export class SoloLocalExportDestinationStore {
  constructor(
    private readonly backend: SoloLocalExportDestinationBackend = new IndexedDbSoloLocalExportDestinationBackend(),
  ) {}

  async load(): Promise<SoloLocalExportDestination> {
    const value = await this.backend.read();
    return normaliseSoloLocalExportDestination(value);
  }

  async useBrowserStorage() {
    await this.backend.write(DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION);
    return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  }

  async useFolder(directoryHandle: SoloDirectoryHandle) {
    if (!directoryHandle || directoryHandle.kind !== "directory") {
      throw new Error("The selected Solo export folder is invalid");
    }
    const name = validFolderName(directoryHandle.name);
    const destination = Object.freeze({
      version: 1 as const,
      type: "folder" as const,
      name,
      directoryHandle,
    });
    await this.backend.write(destination);
    return destination;
  }

  async bindFolderJob(
    jobId: string,
    destination: Extract<SoloLocalExportDestination, { type: "folder" }>,
  ) {
    const validatedJobId = validJobId(jobId);
    const validatedDestination = normaliseSoloLocalExportDestination(destination);
    if (validatedDestination.type !== "folder") {
      throw new Error("The Solo folder job destination is invalid");
    }
    await this.backend.writeFolderJob(validatedJobId, validatedDestination);
    return validatedDestination;
  }

  async loadFolderJob(jobId: string) {
    const validatedJobId = validJobId(jobId);
    const destination = normaliseSoloLocalExportDestination(
      await this.backend.readFolderJob(validatedJobId),
    );
    return destination.type === "folder" ? destination : null;
  }

  async clearFolderJob(jobId: string) {
    await this.backend.deleteFolderJob(validJobId(jobId));
  }
}

export async function soloLocalExportPermission(
  destination: SoloLocalExportDestination,
): Promise<SoloLocalExportPermission> {
  if (destination.type === "browser") return "granted";
  const permission = await destination.directoryHandle.queryPermission?.({ mode: "readwrite" });
  return permission === "granted" || permission === "denied" ? permission : "prompt";
}

export async function requestSoloLocalExportPermission(
  destination: SoloLocalExportDestination,
): Promise<SoloLocalExportPermission> {
  if (destination.type === "browser") return "granted";
  const current = await soloLocalExportPermission(destination);
  if (current === "granted") return current;
  const requested = await destination.directoryHandle.requestPermission?.({ mode: "readwrite" });
  return requested === "granted" || requested === "denied" ? requested : "prompt";
}

export async function soloLocalExportFolderIdentityMatches(
  expected: Extract<SoloLocalExportDestination, { type: "folder" }>,
  current: SoloLocalExportDestination,
): Promise<boolean> {
  if (current.type !== "folder") return false;
  if (expected.directoryHandle === current.directoryHandle) return true;
  const expectedComparison = expected.directoryHandle.isSameEntry;
  const currentComparison = current.directoryHandle.isSameEntry;
  try {
    if (typeof expectedComparison === "function") {
      return await expectedComparison.call(
        expected.directoryHandle,
        current.directoryHandle,
      );
    }
    if (typeof currentComparison === "function") {
      return await currentComparison.call(
        current.directoryHandle,
        expected.directoryHandle,
      );
    }
  } catch {
    return false;
  }
  return false;
}

export function normaliseSoloLocalExportDestination(value: unknown): SoloLocalExportDestination {
  if (!value || typeof value !== "object") return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  const candidate = value as Partial<SoloLocalExportDestination>;
  if (candidate.version !== 1) return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  if (candidate.type === "browser") return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  if (candidate.type !== "folder") return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  const directoryHandle = candidate.directoryHandle;
  if (!directoryHandle || directoryHandle.kind !== "directory") {
    return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  }
  try {
    return Object.freeze({
      version: 1,
      type: "folder",
      name: validFolderName(candidate.name ?? directoryHandle.name),
      directoryHandle,
    });
  } catch {
    return DEFAULT_SOLO_LOCAL_EXPORT_DESTINATION;
  }
}

export class IndexedDbSoloLocalExportDestinationBackend implements SoloLocalExportDestinationBackend {
  async read() {
    const database = await this.open();
    try {
      return await requestResult<unknown>(
        database.transaction(SOLO_LOCAL_EXPORT_STORE, "readonly")
          .objectStore(SOLO_LOCAL_EXPORT_STORE)
          .get(DESTINATION_KEY),
      );
    } finally {
      database.close();
    }
  }

  async write(destination: SoloLocalExportDestination) {
    await this.writeKey(DESTINATION_KEY, destination);
  }

  async readFolderJob(jobId: string) {
    const database = await this.open();
    try {
      return await requestResult<unknown>(
        database.transaction(SOLO_LOCAL_EXPORT_STORE, "readonly")
          .objectStore(SOLO_LOCAL_EXPORT_STORE)
          .get(folderJobKey(jobId)),
      );
    } finally {
      database.close();
    }
  }

  async writeFolderJob(jobId: string, destination: SoloLocalExportDestination) {
    await this.writeKey(folderJobKey(jobId), destination);
  }

  async deleteFolderJob(jobId: string) {
    const database = await this.open();
    try {
      await transactionComplete(
        database.transaction(SOLO_LOCAL_EXPORT_STORE, "readwrite"),
        (store) => store.delete(folderJobKey(jobId)),
      );
    } finally {
      database.close();
    }
  }

  private async writeKey(key: string, destination: SoloLocalExportDestination) {
    const database = await this.open();
    try {
      await transactionComplete(
        database.transaction(SOLO_LOCAL_EXPORT_STORE, "readwrite"),
        (store) => store.put(destination, key),
      );
    } finally {
      database.close();
    }
  }

  private open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SOLO_LOCAL_EXPORT_DATABASE, SOLO_LOCAL_EXPORT_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SOLO_LOCAL_EXPORT_STORE)) {
          database.createObjectStore(SOLO_LOCAL_EXPORT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ?? new Error("The Solo local destination store could not be opened"),
      );
      request.onblocked = () => reject(
        new Error("The Solo local destination store upgrade is blocked"),
      );
    });
  }
}

function validFolderName(value: string) {
  const name = value?.trim();
  if (!name || name.length > 255 || /[/\\\0]/.test(name)) {
    throw new Error("The selected Solo export folder name is invalid");
  }
  return name;
}

function validJobId(value: string) {
  if (!SAFE_JOB_ID_PATTERN.test(value)) {
    throw new Error("The Solo folder job identifier is invalid");
  }
  return value;
}

function folderJobKey(jobId: string) {
  return `${FOLDER_JOB_KEY_PREFIX}${validJobId(jobId)}`;
}

function transactionComplete(
  transaction: IDBTransaction,
  mutate: (store: IDBObjectStore) => IDBRequest,
) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("The Solo local destination transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("The Solo local destination transaction was aborted"),
    );
    mutate(transaction.objectStore(SOLO_LOCAL_EXPORT_STORE));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("The Solo local destination could not be read"),
    );
  });
}
