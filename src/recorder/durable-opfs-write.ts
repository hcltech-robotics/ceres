type MaybePromise<T> = T | Promise<T>;

interface SyncAccessHandleLike {
  close(): MaybePromise<void>;
  flush(): MaybePromise<void>;
  getSize(): MaybePromise<number>;
  read(buffer: ArrayBufferView, options?: { at?: number }): MaybePromise<number>;
  truncate(size: number): MaybePromise<void>;
  write(buffer: ArrayBufferView, options?: { at?: number }): MaybePromise<number>;
}

interface WritableStreamLike {
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
}

type CompatibleFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
  createWritable?: (options?: { keepExistingData?: boolean }) => Promise<WritableStreamLike>;
};

export type DurableOpfsWriter = "sync-access-handle" | "writable-stream";

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function writeWithSyncAccessHandle(handle: SyncAccessHandleLike, bytes: Uint8Array) {
  let operationFailed = false;
  try {
    await handle.truncate(0);
    let writeOffset = 0;
    while (writeOffset < bytes.byteLength) {
      const written = await handle.write(bytes.subarray(writeOffset), { at: writeOffset });
      const remaining = bytes.byteLength - writeOffset;
      if (!Number.isSafeInteger(written) || written <= 0 || written > remaining) {
        throw new Error("Durable OPFS write did not make valid progress");
      }
      writeOffset += written;
    }
    await handle.flush();
    const size = await handle.getSize();
    if (size !== bytes.byteLength) {
      throw new Error(`Durable OPFS write size mismatch (${size} bytes stored, ${bytes.byteLength} expected)`);
    }
    const persisted = new Uint8Array(bytes.byteLength);
    let readOffset = 0;
    while (readOffset < persisted.byteLength) {
      const read = await handle.read(persisted.subarray(readOffset), { at: readOffset });
      const remaining = persisted.byteLength - readOffset;
      if (!Number.isSafeInteger(read) || read <= 0 || read > remaining) {
        throw new Error("Durable OPFS read-back did not make valid progress");
      }
      readOffset += read;
    }
    if (!sameBytes(persisted, bytes)) throw new Error("Durable OPFS read-back did not match the written bytes");
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

async function writeWithWritableStream(file: CompatibleFileHandle, bytes: Uint8Array) {
  const writable = await file.createWritable!({ keepExistingData: false });
  let closed = false;
  try {
    await writable.write(Uint8Array.from(bytes));
    await writable.close();
    closed = true;
  } catch (error) {
    if (!closed) await writable.abort(error).catch(() => undefined);
    throw error;
  }
  const persisted = new Uint8Array(await (await file.getFile()).arrayBuffer());
  if (!sameBytes(persisted, bytes)) throw new Error("Durable OPFS read-back did not match the written bytes");
}

export async function writeOpfsFileDurably(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<DurableOpfsWriter> {
  const compatible = fileHandle as CompatibleFileHandle;
  if (typeof compatible.createSyncAccessHandle === "function") {
    await writeWithSyncAccessHandle(await compatible.createSyncAccessHandle(), bytes);
    return "sync-access-handle";
  }
  if (typeof compatible.createWritable === "function") {
    await writeWithWritableStream(compatible, bytes);
    return "writable-stream";
  }
  throw new Error("Durable OPFS writing is unavailable in this browser");
}
