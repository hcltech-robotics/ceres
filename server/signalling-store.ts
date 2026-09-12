import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { SignallingStorage } from "../shared/signalling-context.js";

export class SignallingStore implements SignallingStorage {
  private values: Record<string, unknown> = {};
  private readonly ready: Promise<void>;
  private alarm: number | null = null;
  constructor(private readonly file: string, private readonly schedule: (deadline: number) => void) {
    this.ready = this.load();
  }
  private async load() {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value.version !== 1 || !value.values || Array.isArray(value.values)) throw new Error("Invalid signalling journal");
      this.values = value.values;
      this.alarm = typeof value.alarm === "number" ? value.alarm : null;
      if (this.alarm !== null) this.schedule(this.alarm);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async commit(values: Record<string, unknown>, alarm = this.alarm) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, values, alarm }) + "\n");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, this.file);
    this.values = values;
    this.alarm = alarm;
    if (alarm !== null) this.schedule(alarm);
  }
  async get<T>(key: string): Promise<T | undefined> {
    await this.ready;
    return Object.hasOwn(this.values, key) ? structuredClone(this.values[key]) as T : undefined;
  }
  async put<T>(key: string, value: T) {
    await this.ready;
    await this.commit({ ...this.values, [key]: structuredClone(value) });
  }
  async delete(key: string) {
    await this.ready;
    const values = { ...this.values };
    delete values[key];
    await this.commit(values);
  }
  async deleteAll() { await this.ready; await this.commit({}, null); }
  async setAlarm(deadline: number) { await this.ready; await this.commit(this.values, deadline); }
  async consumeAlarm(now: number): Promise<boolean> {
    await this.ready;
    if (this.alarm === null || this.alarm > now) {
      if (this.alarm !== null) this.schedule(this.alarm);
      return false;
    }
    await this.commit(this.values, null);
    return true;
  }
  async transaction<T>(operation: (storage: SignallingStorage) => Promise<T>): Promise<T> {
    await this.ready;
    let values = structuredClone(this.values);
    let alarm = this.alarm;
    const staged: SignallingStorage = {
      get: async <V>(key: string) => Object.hasOwn(values, key) ? structuredClone(values[key]) as V : undefined,
      put: async (key, value) => { values[key] = structuredClone(value); },
      delete: async key => { delete values[key]; },
      deleteAll: async () => { values = {}; alarm = null; },
      setAlarm: async deadline => { alarm = deadline; },
      transaction: async callback => callback(staged),
    };
    const result = await operation(staged);
    await this.commit(values, alarm);
    return result;
  }
}
