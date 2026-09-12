import { isSoloSystemTransitionId } from "./solo-system-transition.js";

export const SOLO_SYSTEM_RESULT_DATABASE = "ceres-solo-system-results";
export const SOLO_SYSTEM_RESULT_STORE = "results";
export const SOLO_SYSTEM_RESULT_VERSION = 1;
export const SOLO_SYSTEM_FILE_RESULT_MAX_BYTES = 1_048_576;

export interface SoloDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

export type SoloSystemResult =
  | Readonly<{
      transitionId: string;
      kind: "file-import";
      fileName: string;
      text: string;
    }>
  | Readonly<{
      transitionId: string;
      kind: "folder-export";
      directoryHandle: SoloDirectoryHandle;
    }>;

export interface SoloSystemResultBackend {
  get(transitionId: string): Promise<SoloSystemResult | null>;
  put(result: SoloSystemResult): Promise<void>;
  delete(transitionId: string): Promise<void>;
}

export class SoloSystemResultStore {
  constructor(
    private readonly backend: SoloSystemResultBackend = new IndexedDbSoloSystemResultBackend(),
  ) {}

  async putFile(transitionId: string, fileName: string, text: string) {
    const id = requireTransitionId(transitionId);
    const name = requireFileName(fileName);
    if (typeof text !== "string"
      || new TextEncoder().encode(text).byteLength > SOLO_SYSTEM_FILE_RESULT_MAX_BYTES) {
      throw new Error("The Solo system file result is larger than 1 MB");
    }
    await this.backend.put(Object.freeze({
      transitionId: id,
      kind: "file-import",
      fileName: name,
      text,
    }));
  }

  async putDirectory(
    transitionId: string,
    directoryHandle: SoloDirectoryHandle,
  ) {
    const id = requireTransitionId(transitionId);
    if (!directoryHandle || directoryHandle.kind !== "directory") {
      throw new Error("The Solo folder result is invalid");
    }
    await this.backend.put(Object.freeze({
      transitionId: id,
      kind: "folder-export",
      directoryHandle,
    }));
  }

  async get(transitionId: string) {
    const id = requireTransitionId(transitionId);
    const result = await this.backend.get(id);
    if (!result) return null;
    if (result.transitionId !== id || !isSoloSystemResult(result)) {
      await this.backend.delete(id);
      return null;
    }
    return result;
  }

  async clear(transitionId: string) {
    await this.backend.delete(requireTransitionId(transitionId));
  }
}

export async function ensureSoloDirectoryReadWritePermission(
  handle: SoloDirectoryHandle,
) {
  const descriptor = { mode: "readwrite" as const };
  const current = await handle.queryPermission?.(descriptor);
  if (current === "granted") return;
  const requested = await handle.requestPermission?.(descriptor);
  if (requested !== "granted") {
    throw new Error("Read and write permission is required for the selected Solo export folder");
  }
}

export class IndexedDbSoloSystemResultBackend implements SoloSystemResultBackend {
  async get(transitionId: string) {
    const database = await this.open();
    try {
      return await requestResult<SoloSystemResult | undefined>(
        database.transaction(SOLO_SYSTEM_RESULT_STORE, "readonly")
          .objectStore(SOLO_SYSTEM_RESULT_STORE)
          .get(transitionId),
      ) ?? null;
    } finally {
      database.close();
    }
  }

  async put(result: SoloSystemResult) {
    const database = await this.open();
    try {
      await transactionComplete(
        database.transaction(SOLO_SYSTEM_RESULT_STORE, "readwrite"),
        (store) => store.put(result),
      );
    } finally {
      database.close();
    }
  }

  async delete(transitionId: string) {
    const database = await this.open();
    try {
      await transactionComplete(
        database.transaction(SOLO_SYSTEM_RESULT_STORE, "readwrite"),
        (store) => store.delete(transitionId),
      );
    } finally {
      database.close();
    }
  }

  private open() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(
        SOLO_SYSTEM_RESULT_DATABASE,
        SOLO_SYSTEM_RESULT_VERSION,
      );
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SOLO_SYSTEM_RESULT_STORE)) {
          database.createObjectStore(SOLO_SYSTEM_RESULT_STORE, {
            keyPath: "transitionId",
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ?? new Error("The Solo system result store could not be opened"),
      );
      request.onblocked = () => reject(new Error("The Solo system result store upgrade is blocked"));
    });
  }
}

function transactionComplete(
  transaction: IDBTransaction,
  mutate: (store: IDBObjectStore) => IDBRequest,
) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("The Solo system result transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("The Solo system result transaction was aborted"),
    );
    mutate(transaction.objectStore(SOLO_SYSTEM_RESULT_STORE));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error ?? new Error("The Solo system result could not be read"),
    );
  });
}

function requireTransitionId(value: string) {
  const id = value?.trim();
  if (!isSoloSystemTransitionId(id)) {
    throw new Error("The Solo system transition identity is invalid");
  }
  return id;
}

function requireFileName(value: string) {
  const fileName = value?.trim();
  if (!fileName || fileName.length > 255 || /[/\\\0]/.test(fileName)) {
    throw new Error("The Solo system file name is invalid");
  }
  return fileName;
}

function isSoloSystemResult(value: SoloSystemResult) {
  if (value.kind === "file-import") {
    return typeof value.fileName === "string"
      && typeof value.text === "string"
      && new TextEncoder().encode(value.text).byteLength <= SOLO_SYSTEM_FILE_RESULT_MAX_BYTES;
  }
  return value.kind === "folder-export"
    && value.directoryHandle?.kind === "directory";
}
