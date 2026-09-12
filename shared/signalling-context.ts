export interface SignallingSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  send(value: string): void;
  close(code: number, reason: string): void;
}

export interface SignallingStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  deleteAll(): Promise<void>;
  setAlarm(deadline: number): Promise<void>;
  transaction<T>(operation: (storage: SignallingStorage) => Promise<T>): Promise<T>;
}

export interface SignallingContext {
  storage: SignallingStorage;
  getWebSockets(): SignallingSocket[];
  openWebSocket(): Response;
}
