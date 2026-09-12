import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  decodeRecorderBlock,
  decodeRecorderRunEvent,
  encodeRecorderBlock,
  encodeRecorderRunEvent,
  RecorderBlockFlags,
  type ClientRole,
  type RecorderRunEvent,
} from "../shared/protocol.js";

export const QUEST_STREAM_FIXTURE_SCHEMA = "ceres-quest-stream-v1" as const;
export const QUEST_STREAM_SESSION_ALIAS = "$SESSION" as const;
export const QUEST_STREAM_SEGMENT_ALIAS_PREFIX = "SEGMENT_ALIAS_" as const;
export const QUEST_STREAM_ANNOTATION_ALIAS_PREFIX = "ANNOTATION_ALIAS_" as const;

export interface QuestStreamFixtureManifest {
  schema: typeof QUEST_STREAM_FIXTURE_SCHEMA;
  timebase: "relative-monotonic-ms";
  events: "events.ndjson";
  payloads: "payloads";
  sessionAlias: typeof QUEST_STREAM_SESSION_ALIAS;
  pairingAliases: string[];
  episodeAliases: string[];
  promptAliases: string[];
  segmentAliases: string[];
  annotationAliases: string[];
  captureTimestamps: "absolute-source-rebased-on-replay";
  redactionPolicy: {
    volatileWebRtcSignals: "omitted";
    secretLikeFields: "omitted";
    transportHeaders: "not-recorded";
  };
}

export type QuestStreamDirection = "transport" | "client-to-server" | "server-to-client";

export interface QuestStreamPayloadReference {
  file: string;
  byteLength: number;
  sha256: string;
  inject?: "dataBase64";
}

export interface QuestStreamEvent {
  schemaVersion: 1;
  sequence: number;
  atMs: number;
  connectionId: string;
  role?: ClientRole;
  direction: QuestStreamDirection;
  kind: "connect" | "text" | "binary" | "disconnect" | "redacted-text";
  message?: unknown;
  messageType?: string;
  payload?: QuestStreamPayloadReference;
  closeCode?: number;
  closeReason?: string;
  redactions?: string[];
  reason?: string;
}

export interface QuestStreamFixture {
  directory: string;
  manifest: QuestStreamFixtureManifest;
  events: QuestStreamEvent[];
  readPayload(reference: QuestStreamPayloadReference): Uint8Array;
}

export interface QuestStreamFixtureRecorderOptions {
  directory: string;
  targetSessionId: string;
  now?: () => number;
}

interface RecorderConnection {
  id: string;
  active: boolean;
  discarded: boolean;
  role?: ClientRole;
}

interface SanitisedMessage {
  message: unknown;
  redactions: string[];
  payload?: Uint8Array;
}

/**
 * Opt-in recorder for the raw WebSocket boundary used by Quest capture and its
 * recorder worker. All writes are synchronous so an interrupted test run still
 * leaves a prefix that can be inspected. The hook is inert unless explicitly
 * constructed by the server.
 */
export class QuestStreamFixtureRecorder {
  readonly directory: string;
  private readonly targetSessionId: string;
  private readonly eventsPath: string;
  private readonly payloadDirectory: string;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly connections = new Map<string, RecorderConnection>();
  private readonly pairingAliases = new Map<string, string>();
  private readonly episodeAliases = new Map<string, string>();
  private readonly promptAliases = new Map<string, string>();
  private readonly segmentAliases = new Map<string, string>();
  private readonly annotationAliases = new Map<string, string>();
  private connectionSequence = 0;
  private eventSequence = 0;

  constructor(options: QuestStreamFixtureRecorderOptions) {
    if (!isSafeIdentifier(options.targetSessionId)) throw new Error("Quest stream target session identifier is invalid");
    this.directory = path.resolve(options.directory);
    this.targetSessionId = options.targetSessionId;
    this.eventsPath = path.join(this.directory, "events.ndjson");
    this.payloadDirectory = path.join(this.directory, "payloads");
    this.now = options.now ?? (() => performance.now());
    this.startedAtMs = this.now();
    mkdirSync(this.payloadDirectory, { recursive: true });
    if (existsSync(this.eventsPath) && statSync(this.eventsPath).size > 0) {
      throw new Error(`Quest stream fixture already contains events: ${this.eventsPath}`);
    }
    writeFileSync(this.eventsPath, "");
    this.writeManifest();
  }

  connectionOpened() {
    const id = `connection-${String(this.connectionSequence).padStart(4, "0")}`;
    this.connectionSequence += 1;
    this.connections.set(id, { id, active: false, discarded: false });
    return id;
  }

  captureArrivalTime() {
    return this.elapsedMs();
  }

  clientText(connectionId: string, raw: string, arrivedAtMs = this.elapsedMs()) {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.discarded) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (connection.active) this.record({
        connectionId,
        role: connection.role,
        direction: "client-to-server",
        kind: "redacted-text",
        reason: "invalid-json-was-not-retained",
      }, arrivedAtMs);
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.type === "register") {
      const role = parsed.role;
      const sessionId = parsed.sessionId;
      if (!isClientRole(role) || sessionId !== this.targetSessionId) {
        connection.discarded = true;
        return;
      }
      connection.active = true;
      connection.role = role;
      this.record({ connectionId, role, direction: "transport", kind: "connect" }, arrivedAtMs);
    }
    if (!connection.active) return;
    this.recordText(connection, "client-to-server", parsed, arrivedAtMs);
  }

  clientBinary(connectionId: string, value: Uint8Array, arrivedAtMs = this.elapsedMs()) {
    const connection = this.connections.get(connectionId);
    if (!connection?.active) return;
    try {
      const block = decodeRecorderBlock(value);
      const payload = (block.flags & RecorderBlockFlags.RunEvent) !== 0
        ? encodeRecorderRunEvent(this.aliasRecorderRunEvent(decodeRecorderRunEvent(block.payload)))
        : block.payload;
      const canonical = encodeRecorderBlock({
        sessionId: this.aliasSession(block.sessionId),
        episodeId: this.aliasEpisode(block.episodeId),
        sequence: block.sequence,
        recorderFrameIndex: block.recorderFrameIndex,
        sourceTimestampUs: block.sourceTimestampUs,
        flags: block.flags,
        payload,
      });
      this.recordBinary(connection, "client-to-server", canonical, arrivedAtMs);
    } catch {
      this.record({
        connectionId,
        role: connection.role,
        direction: "client-to-server",
        kind: "redacted-text",
        reason: "invalid-recorder-binary-was-not-retained",
      }, arrivedAtMs);
    }
  }

  serverText(connectionId: string, message: unknown, arrivedAtMs = this.elapsedMs()) {
    const connection = this.connections.get(connectionId);
    if (!connection?.active) return;
    this.recordText(connection, "server-to-client", message, arrivedAtMs);
  }

  connectionClosed(connectionId: string, closeCode: number, closeReason: string, arrivedAtMs = this.elapsedMs()) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (connection.active) {
      this.record({
        connectionId,
        role: connection.role,
        direction: "transport",
        kind: "disconnect",
        closeCode,
        closeReason: sanitiseCloseReason(closeReason),
      }, arrivedAtMs);
    }
    this.connections.delete(connectionId);
  }

  private recordText(
    connection: RecorderConnection,
    direction: Exclude<QuestStreamDirection, "transport">,
    source: unknown,
    arrivedAtMs: number,
  ) {
    if (isRecord(source) && source.type === "webrtc-signal") {
      this.record({
        connectionId: connection.id,
        role: connection.role,
        direction,
        kind: "redacted-text",
        messageType: "webrtc-signal",
        reason: "volatile-webrtc-credentials-and-network-addresses-were-not-retained",
      }, arrivedAtMs);
      return;
    }
    const sanitised = this.sanitiseMessage(source);
    const event: Omit<QuestStreamEvent, "schemaVersion" | "sequence" | "atMs"> = {
      connectionId: connection.id,
      role: connection.role,
      direction,
      kind: "text",
      message: sanitised.message,
      ...(sanitised.redactions.length > 0 ? { redactions: sanitised.redactions } : {}),
    };
    if (sanitised.payload) event.payload = this.writePayload(sanitised.payload, "dataBase64");
    this.record(event, arrivedAtMs);
  }

  private recordBinary(
    connection: RecorderConnection,
    direction: Exclude<QuestStreamDirection, "transport">,
    value: Uint8Array,
    arrivedAtMs: number,
  ) {
    this.record({
      connectionId: connection.id,
      role: connection.role,
      direction,
      kind: "binary",
      payload: this.writePayload(value),
    }, arrivedAtMs);
  }

  private record(event: Omit<QuestStreamEvent, "schemaVersion" | "sequence" | "atMs">, arrivedAtMs: number) {
    const complete: QuestStreamEvent = {
      schemaVersion: 1,
      sequence: this.eventSequence,
      atMs: arrivedAtMs,
      ...event,
    };
    this.eventSequence += 1;
    appendFileSync(this.eventsPath, `${JSON.stringify(complete)}\n`);
  }

  private elapsedMs() {
    return Math.max(0, Number((this.now() - this.startedAtMs).toFixed(3)));
  }

  private sanitiseMessage(source: unknown): SanitisedMessage {
    const redactions: string[] = [];
    let mediaPayload: Uint8Array | undefined;
    const visit = (value: unknown, keys: string[]): unknown => {
      if (Array.isArray(value)) return value.map((entry, index) => visit(entry, [...keys, String(index)]));
      if (!isRecord(value)) return value;
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const nextKeys = [...keys, key];
        if (isSecretLikeKey(key)) {
          redactions.push(nextKeys.join("."));
          continue;
        }
        if (key === "dataBase64" && typeof child === "string" && (value.type === "media-chunk" || value.type === "audio-chunk")) {
          try {
            mediaPayload = Buffer.from(child, "base64");
            output[key] = "$PAYLOAD";
          } catch {
            redactions.push(nextKeys.join("."));
          }
          continue;
        }
        if (key === "nextCursor" && typeof child === "string") {
          output[key] = "$NEXT_CURSOR";
          continue;
        }
        if (key === "sessionId" && typeof child === "string") output[key] = this.aliasSession(child);
        else if (key === "pairingId" && typeof child === "string") output[key] = this.aliasPairing(child);
        else if (key === "episodeId" && typeof child === "string") output[key] = this.aliasEpisode(child);
        else if (key === "deliveryId" && typeof child === "string") output[key] = this.aliasPrompt(child);
        else if (key === "segmentId" && typeof child === "string") output[key] = this.aliasSegment(child);
        else if (key === "annotationId" && typeof child === "string") output[key] = this.aliasAnnotation(child);
        else if (key === "id" && typeof child === "string" && isAnnotationPath(keys, value)) output[key] = this.aliasAnnotation(child);
        else if (key === "id" && typeof child === "string" && isSegmentPath(keys, value)) output[key] = this.aliasSegment(child);
        else if (key === "id" && typeof child === "string" && isEpisodePath(keys, value)) output[key] = this.aliasEpisode(child);
        else if (key === "id" && typeof child === "string" && isPromptPath(keys, value)) output[key] = this.aliasPrompt(child);
        else output[key] = visit(child, nextKeys);
      }
      return output;
    };
    return { message: visit(source, []), redactions, payload: mediaPayload };
  }

  private aliasSession(value: string) {
    return value === this.targetSessionId ? QUEST_STREAM_SESSION_ALIAS : "$OTHER_SESSION";
  }

  private aliasPairing(value: string) {
    let alias = this.pairingAliases.get(value);
    if (!alias) {
      alias = `$PAIRING_${this.pairingAliases.size + 1}`;
      this.pairingAliases.set(value, alias);
      this.writeManifest();
    }
    return alias;
  }

  private aliasEpisode(value: string) {
    let alias = this.episodeAliases.get(value);
    if (!alias) {
      alias = `$EPISODE_${this.episodeAliases.size + 1}`;
      this.episodeAliases.set(value, alias);
      this.writeManifest();
    }
    return alias;
  }

  private aliasPrompt(value: string) {
    let alias = this.promptAliases.get(value);
    if (!alias) {
      alias = `$PROMPT_${this.promptAliases.size + 1}`;
      this.promptAliases.set(value, alias);
      this.writeManifest();
    }
    return alias;
  }

  private aliasSegment(value: string) {
    let alias = this.segmentAliases.get(value);
    if (!alias) {
      alias = `${QUEST_STREAM_SEGMENT_ALIAS_PREFIX}${this.segmentAliases.size + 1}`;
      this.segmentAliases.set(value, alias);
      this.writeManifest();
    }
    return alias;
  }

  private aliasAnnotation(value: string) {
    let alias = this.annotationAliases.get(value);
    if (!alias) {
      alias = `${QUEST_STREAM_ANNOTATION_ALIAS_PREFIX}${this.annotationAliases.size + 1}`;
      this.annotationAliases.set(value, alias);
      this.writeManifest();
    }
    return alias;
  }

  private aliasRecorderRunEvent(event: RecorderRunEvent): RecorderRunEvent {
    if (event.type === "annotation") {
      return {
        ...event,
        segmentId: this.aliasSegment(event.segmentId),
        annotationId: this.aliasAnnotation(event.annotationId),
      };
    }
    return { ...event, segmentId: this.aliasSegment(event.segmentId) };
  }

  private writePayload(value: Uint8Array, inject?: QuestStreamPayloadReference["inject"]): QuestStreamPayloadReference {
    const sequence = String(this.eventSequence).padStart(10, "0");
    const file = `payloads/${sequence}.bin`;
    const absolute = path.join(this.directory, ...file.split("/"));
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    writeFileSync(absolute, bytes);
    return {
      file,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(inject ? { inject } : {}),
    };
  }

  private writeManifest() {
    const manifest: QuestStreamFixtureManifest = {
      schema: QUEST_STREAM_FIXTURE_SCHEMA,
      timebase: "relative-monotonic-ms",
      events: "events.ndjson",
      payloads: "payloads",
      sessionAlias: QUEST_STREAM_SESSION_ALIAS,
      pairingAliases: [...this.pairingAliases.values()],
      episodeAliases: [...this.episodeAliases.values()],
      promptAliases: [...this.promptAliases.values()],
      segmentAliases: [...this.segmentAliases.values()],
      annotationAliases: [...this.annotationAliases.values()],
      captureTimestamps: "absolute-source-rebased-on-replay",
      redactionPolicy: {
        volatileWebRtcSignals: "omitted",
        secretLikeFields: "omitted",
        transportHeaders: "not-recorded",
      },
    };
    writeFileSync(path.join(this.directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function createQuestStreamRecorderFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const directory = environment.CERES_QUEST_STREAM_CAPTURE_DIR?.trim();
  if (!directory) return null;
  const targetSessionId = environment.CERES_QUEST_STREAM_SESSION?.trim();
  if (!targetSessionId) throw new Error("CERES_QUEST_STREAM_SESSION is required when Quest stream capture is enabled");
  return new QuestStreamFixtureRecorder({ directory, targetSessionId });
}

export function readQuestStreamFixture(directory: string): QuestStreamFixture {
  const absoluteDirectory = path.resolve(directory);
  const parsedManifest = JSON.parse(readFileSync(path.join(absoluteDirectory, "manifest.json"), "utf8")) as Partial<QuestStreamFixtureManifest>;
  if (parsedManifest.schema !== QUEST_STREAM_FIXTURE_SCHEMA
    || parsedManifest.timebase !== "relative-monotonic-ms"
    || parsedManifest.events !== "events.ndjson"
    || parsedManifest.payloads !== "payloads"
    || parsedManifest.sessionAlias !== QUEST_STREAM_SESSION_ALIAS
    || !isAliasArray(parsedManifest.pairingAliases, /^\$PAIRING_[0-9]+$/)
    || !isAliasArray(parsedManifest.episodeAliases, /^\$EPISODE_[0-9]+$/)
    || !isAliasArray(parsedManifest.promptAliases, /^\$PROMPT_[0-9]+$/)
    || (parsedManifest.segmentAliases !== undefined && !isAliasArray(parsedManifest.segmentAliases, /^SEGMENT_ALIAS_[0-9]+$/))
    || (parsedManifest.annotationAliases !== undefined && !isAliasArray(parsedManifest.annotationAliases, /^ANNOTATION_ALIAS_[0-9]+$/))
    || parsedManifest.captureTimestamps !== "absolute-source-rebased-on-replay") {
    throw new Error("Quest stream fixture manifest is unsupported or malformed");
  }
  const manifest = {
    ...parsedManifest,
    segmentAliases: parsedManifest.segmentAliases ?? [],
    annotationAliases: parsedManifest.annotationAliases ?? [],
  } as QuestStreamFixtureManifest;
  const lines = readFileSync(path.join(absoluteDirectory, manifest.events), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const events = lines.map((line, index) => validateEvent(JSON.parse(line) as QuestStreamEvent, index));
  events.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== index) throw new Error(`Quest stream event sequence is not contiguous at ${index}`);
    if (index > 0 && events[index].atMs < events[index - 1].atMs) throw new Error(`Quest stream time moved backwards at event ${index}`);
  }
  const readPayload = (reference: QuestStreamPayloadReference) => {
    if (!/^payloads\/[0-9]+\.bin$/.test(reference.file)) throw new Error(`Unsafe Quest stream payload path: ${reference.file}`);
    const file = path.resolve(absoluteDirectory, ...reference.file.split("/"));
    const payloadRoot = `${path.resolve(absoluteDirectory, manifest.payloads)}${path.sep}`;
    if (!file.startsWith(payloadRoot)) throw new Error(`Quest stream payload escapes fixture: ${reference.file}`);
    const value = readFileSync(file);
    if (value.byteLength !== reference.byteLength) throw new Error(`Quest stream payload length mismatch: ${reference.file}`);
    const checksum = createHash("sha256").update(value).digest("hex");
    if (checksum !== reference.sha256) throw new Error(`Quest stream payload checksum mismatch: ${reference.file}`);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  };
  for (const event of events) if (event.payload) readPayload(event.payload);
  validateConnectionTopology(events);
  return { directory: absoluteDirectory, manifest, events, readPayload };
}

function validateEvent(event: QuestStreamEvent, line: number) {
  if (event.schemaVersion !== 1
    || !Number.isSafeInteger(event.sequence) || event.sequence < 0
    || typeof event.atMs !== "number" || !Number.isFinite(event.atMs) || event.atMs < 0
    || typeof event.connectionId !== "string" || !event.connectionId
    || !["transport", "client-to-server", "server-to-client"].includes(event.direction)
    || !["connect", "text", "binary", "disconnect", "redacted-text"].includes(event.kind)) {
    throw new Error(`Malformed Quest stream event at line ${line + 1}`);
  }
  if ((event.kind === "binary" || event.payload?.inject) && !event.payload) {
    throw new Error(`Quest stream event ${event.sequence} is missing its payload reference`);
  }
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isClientRole(value: unknown): value is ClientRole {
  return value === "capture" || value === "recorder" || value === "monitor" || value === "monitor-control";
}

function isSafeIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isSecretLikeKey(key: string) {
  return /^(?:token|accessToken|refreshToken|secret|password|credential|authorization|cookie)$/i.test(key);
}

function isEpisodePath(keys: string[], object: Record<string, unknown>) {
  const parent = keys.at(-1) ?? "";
  const collection = keys.at(-2) ?? "";
  return /^(?:episode|currentEpisode|pendingEpisode)$/i.test(parent)
    || (/^[0-9]+$/.test(parent) && /^(?:episodes|attempts)$/i.test(collection))
    || (typeof object.runTitle === "string" && typeof object.cycle === "number" && typeof object.startedAt === "string");
}

function isPromptPath(keys: string[], object: Record<string, unknown>) {
  const parent = keys.at(-1) ?? "";
  const collection = keys.at(-2) ?? "";
  return /^(?:prompt|delivery)$/i.test(parent)
    || (/^[0-9]+$/.test(parent) && collection === "promptDeliveries")
    || (typeof object.transition === "string" && typeof object.state === "string");
}

function isSegmentPath(keys: string[], object: Record<string, unknown>) {
  const parent = keys.at(-1) ?? "";
  const collection = keys.at(-2) ?? "";
  return (/^[0-9]+$/.test(parent) && collection === "segments")
    || (typeof object.taskId === "string"
      && typeof object.taskLabel === "string"
      && typeof object.repetition === "number"
      && typeof object.take === "number"
      && Array.isArray(object.annotations));
}

function isAnnotationPath(keys: string[], object: Record<string, unknown>) {
  const parent = keys.at(-1) ?? "";
  const collection = keys.at(-2) ?? "";
  return (/^[0-9]+$/.test(parent) && collection === "annotations")
    || (typeof object.action === "string" && typeof object.actor === "string" && typeof object.timestampMs === "number");
}

function isAliasArray(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value)
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === "string" && pattern.test(entry));
}

function validateConnectionTopology(events: QuestStreamEvent[]) {
  const open = new Set<string>();
  const registered = new Set<string>();
  for (const event of events) {
    if (event.kind === "connect") {
      if (open.has(event.connectionId) || registered.has(event.connectionId)) {
        throw new Error(`Quest stream connection ${event.connectionId} was opened more than once`);
      }
      open.add(event.connectionId);
      continue;
    }
    if (!open.has(event.connectionId)) {
      throw new Error(`Quest stream event ${event.sequence} uses connection ${event.connectionId} outside its open lifetime`);
    }
    if (event.kind === "disconnect") {
      open.delete(event.connectionId);
      continue;
    }
    if (event.direction === "client-to-server" && event.kind === "text" && isRecord(event.message) && event.message.type === "register") {
      if (registered.has(event.connectionId)) {
        throw new Error(`Quest stream connection ${event.connectionId} re-registers on the same socket`);
      }
      registered.add(event.connectionId);
    }
  }
}

function sanitiseCloseReason(value: string) {
  return value.replace(/[A-Za-z0-9_-]{40,}/g, "<redacted>").slice(0, 123);
}
