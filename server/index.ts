import express from "express";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { z } from "zod";
import { isOperationalRouteRequest, resolvePublicRouteRequest, contentSecurityPolicy, createUploadVerifier } from "./deployment-profile.js";
import {
  CAPTURE_PAIRING_REJECTED_CLOSE_CODE,
  CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE,
  PAIRING_CONNECTION_ACTIVE_CLOSE_CODE,
  decodeRecorderBlock,
  decodeRecorderMediaPayload,
  isStateBoundRunControlAction,
  RecorderBlockFlags,
  RecorderProtocolError,
  type ClientMessage,
  type ClientRole,
  type RecorderError,
} from "../shared/protocol.js";
import { AsrGateway } from "./asr.js";
import { createEpisodeExportRouter, EpisodeExportAccess } from "./episode-export.js";
import { runtimeFeaturesFromEnvironment } from "./runtime-features.js";
import { canSetHandDisplay, handDisplayAuthorityError } from "./session-authority.js";
import { RecorderStoreError, SessionStore, type SessionConnection } from "./session-store.js";
import { serverBindHost } from "./network-policy.js";
import { consumeCeresServerRuntimeOptions } from "./runtime-options.js";
import { isWebSocketOriginAllowed } from "./websocket-origin.js";
import { installSignalling } from "./signalling.js";

const port = Number(process.env.PORT ?? 4317);
if (process.env.CERES_PUBLIC_ORIGIN) {
  const configuredOrigin = new URL(process.env.CERES_PUBLIC_ORIGIN);
  if (configuredOrigin.origin !== process.env.CERES_PUBLIC_ORIGIN
    || !["https:", "http:"].includes(configuredOrigin.protocol)) throw new Error("CERES_PUBLIC_ORIGIN must be an HTTP or HTTPS origin without a trailing slash");
}
const app = express();
const certificate = process.env.CERT_FILE && process.env.KEY_FILE
  ? { cert: readFileSync(process.env.CERT_FILE), key: readFileSync(process.env.KEY_FILE) }
  : null;
const bindHost = serverBindHost(process.env, Boolean(certificate));
const server = certificate ? createHttpsServer(certificate, app) : createHttpServer(app);
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const runtimeFeatures = runtimeFeaturesFromEnvironment();
const runtimeOptions = consumeCeresServerRuntimeOptions();
const sessions = new SessionStore({
  uploadCompletionVerifier: createUploadVerifier(),
  features: runtimeFeatures,
  defaultRecorderRateHz: runtimeOptions.defaultRecorderRateHz,
});
const asr = runtimeFeatures.speech ? new AsrGateway() : null;
const questStreamRecorder = runtimeOptions.questStreamRecorder ?? null;
const episodeExports = new EpisodeExportAccess({
  recorderRateHz: (sessionId) => sessions.snapshot(sessionId).configuration.recorderRateHz,
});

app.use((request, response, next) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (isOperationalRouteRequest(request.originalUrl)) {
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
  }
  next();
});
app.use((request, response, next) => {
  const decision = resolvePublicRouteRequest(request.originalUrl);
  if (!decision) return next();
  if (decision.kind === "redirect") {
    response.redirect(decision.statusCode, decision.location);
    return;
  }
  response.status(404).type("text/plain").send("Not found");
});
app.get("/api/health", (_request, response) => response.json({ ok: true, service: "ceres-capture", features: runtimeFeatures }));
const signalling = installSignalling(app, server, {
  dataDirectory: path.resolve(process.env.CERES_DATA_DIR ?? "data"),
  origin: process.env.CERES_PUBLIC_ORIGIN,
  secure: Boolean(certificate),
});
server.on("close", () => signalling.dispose());
app.use(createEpisodeExportRouter(
  episodeExports,
  (sessionId, capability) => sessions.authoriseEpisodeExport(sessionId, capability),
));
app.use(express.static(path.resolve("dist")));
app.use((_request, response) => {
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.status(404).type("text/plain").send("Not found");
});

server.on("upgrade", (request, socket, head) => {
  if (request.url?.split("?")[0] !== "/ws") {
    if (!request.url?.startsWith("/invite-signal?") && !request.url?.startsWith("/signal?")
      && !/^\/api\/bridge\/v1\/bindings\/[A-Za-z0-9_-]{20,128}\/signal(?:\?|$)/.test(request.url ?? "")) socket.destroy();
    return;
  }
  if (!isWebSocketOriginAllowed(request.headers.origin, request.headers.host, Boolean(certificate), process.env.CERES_PUBLIC_ORIGIN)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (websocket) => webSocketServer.emit("connection", websocket));
});

webSocketServer.on("connection", (websocket) => {
  const questStreamConnectionId = questStreamRecorder?.connectionOpened();
  let sessionId: string | null = null;
  let connection: SessionConnection | null = null;
  const send = (type: string, payload: unknown) => {
    const questStreamArrivedAtMs = questStreamRecorder?.captureArrivalTime();
    if (websocket.readyState !== WebSocket.OPEN) return;
    if ((type === "sensor-frame" || type === "capture-status") && websocket.bufferedAmount > 512 * 1024) return;
    const message = { type, ...(payload as object) };
    if (questStreamConnectionId) questStreamRecorder?.serverText(questStreamConnectionId, message, questStreamArrivedAtMs);
    websocket.send(JSON.stringify(message));
  };

  websocket.on("message", async (raw, isBinary) => {
    const questStreamArrivedAtMs = questStreamRecorder?.captureArrivalTime();
    if (isBinary) {
      const encoded = rawDataBytes(raw);
      if (questStreamConnectionId) questStreamRecorder?.clientBinary(questStreamConnectionId, encoded, questStreamArrivedAtMs);
      if (!sessionId || !connection) return sendRecorderError(send, { fatal: true, code: "not-capture", message: "Register the recorder before sending binary blocks" });
      if (connection.role !== "recorder") {
        return sendRecorderError(send, { fatal: true, code: "not-capture", message: "Only a recorder connection may send binary blocks", sessionId });
      }
      if (!sessions.isActiveRecorder(sessionId, connection)) {
        sendRecorderError(send, { fatal: true, code: "not-capture", message: "This recorder is no longer active for the paired capture", sessionId });
        websocket.close(CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE, "Recorder superseded for this paired capture");
        return;
      }
      let recorderContext: { episodeId: string; sequence: number } | undefined;
      try {
        const block = decodeRecorderBlock(encoded);
        recorderContext = { episodeId: block.episodeId, sequence: block.sequence };
        if (block.sessionId !== sessionId) throw new RecorderStoreError("session-mismatch", "Recorder block session does not match the registered session");
        const result = await sessions.recordRecorderBlock(sessionId, block, encoded, connection);
        send("recorder-ack", {
          sessionId,
          episodeId: block.episodeId,
          sequence: block.sequence,
          recorderFrameIndex: block.recorderFrameIndex,
          status: result.status,
        });
        if (asr && (block.flags & RecorderBlockFlags.AudioChunk) !== 0 && sessions.runSecondaryWork(sessionId)) {
          const audio = decodeRecorderMediaPayload(block.payload);
          const transcriptionSessionId = sessionId;
          void asr.transcribe(Buffer.from(audio.data).toString("base64"), audio.mimeType).then(async (transcript) => {
            sessions.publishAsrStatus(transcriptionSessionId, transcript.available ? "ready" : "unavailable");
            if (transcript.text) await sessions.recordTranscript(transcriptionSessionId, transcript.text, block.sourceTimestampUs / 1000);
          }).catch(() => sessions.publishAsrStatus(transcriptionSessionId, "error"));
        }
      } catch (error) {
        if (sessions.isActiveRecorder(sessionId, connection)) sessions.failRecorder(sessionId, error);
        sendRecorderError(send, { ...recorderErrorPayload(error, sessionId), ...recorderContext });
        if (!sessions.isActiveRecorder(sessionId, connection)) {
          websocket.close(CAPTURE_SOCKET_SUPERSEDED_CLOSE_CODE, "Recorder superseded for this paired capture");
        }
      }
      return;
    }
    const text = raw.toString();
    if (questStreamConnectionId) questStreamRecorder?.clientText(questStreamConnectionId, text, questStreamArrivedAtMs);
    const parsed = parseMessage(text);
    if (!parsed) return send("error", { message: "Invalid session message" });
    try {
      if (parsed.type === "register") {
        if (!isSafeIdentifier(parsed.sessionId)) return send("error", { message: "Session identifier is invalid" });
        if ((parsed.role === "capture" || parsed.role === "recorder")
          && (typeof parsed.pairingId !== "string" || !isSafeIdentifier(parsed.pairingId))) {
          const capture = parsed.role === "capture";
          const message = capture
            ? "The capture tab did not provide a valid pairing identity"
            : "The recorder did not provide a valid capture pairing identity";
          send("pairing-rejected", { code: capture ? "capture-pairing-required" : "recorder-pairing-required", message });
          websocket.close(CAPTURE_PAIRING_REJECTED_CLOSE_CODE, message);
          return;
        }
        if (connection && sessionId) {
          sessions.disconnect(sessionId, connection);
          connection = null;
          sessionId = null;
        }
        const candidate: SessionConnection = {
          id: randomUUID(),
          role: parsed.role,
          ...(parsed.role === "capture" || parsed.role === "recorder" ? { pairingId: parsed.pairingId } : {}),
          ...(parsed.role === "capture" ? {
            telemetryMode: parsed.telemetryMode === "standard" ? "standard" : "disabled",
          } : {}),
          send,
          close: (code, reason) => websocket.close(code, reason),
        };
        const registeredSessionId = parsed.sessionId;
        const result = sessions.connect(registeredSessionId, candidate);
        if (!result.accepted) {
          if ("code" in result) {
            send("pairing-rejected", { code: result.code, message: result.message });
            websocket.close(CAPTURE_PAIRING_REJECTED_CLOSE_CODE, result.message);
          } else {
            websocket.close(PAIRING_CONNECTION_ACTIVE_CLOSE_CODE, result.message);
          }
          return;
        }
        sessionId = registeredSessionId;
        connection = candidate;
        const exportCapability = connection.role === "monitor" || connection.role === "monitor-control"
          ? sessions.exportCapability(registeredSessionId)
          : undefined;
        send("session-registered", { sessionId, role: connection.role, exportCapability });
        if (connection.role === "capture" && result.captureIntentGranted) {
          sessions.requestCaptureIntent(sessionId, connection);
        }
        if (asr) {
          void asr.status()
            .then((state) => sessions.publishAsrStatus(registeredSessionId, state))
            .catch(() => sessions.publishAsrStatus(registeredSessionId, "error"));
        }
        if (connection.role === "recorder") {
          try {
            const ready = await sessions.armRecorder(sessionId, connection);
            if (sessions.isActiveRecorder(sessionId, connection)) {
              send("recorder-ready", { sessionId, nextSequence: ready.nextSequence });
            }
          } catch (error) {
            sendRecorderError(send, recorderErrorPayload(error, sessionId));
          }
        }
        return;
      }
      if (!sessionId || !connection) return send("error", { message: "Register the session before sending capture data" });
      if (parsed.type === "capture-intent" || parsed.type === "capture-xr-active") {
        const result = parsed.type === "capture-intent"
          ? sessions.requestCaptureIntent(sessionId, connection)
          : sessions.activateCaptureAuthority(sessionId, connection);
        if (!result.accepted) {
          if ("code" in result) {
            send("pairing-rejected", { code: result.code, message: result.message });
            websocket.close(CAPTURE_PAIRING_REJECTED_CLOSE_CODE, result.message);
          } else {
            websocket.close(PAIRING_CONNECTION_ACTIVE_CLOSE_CODE, result.message);
          }
        }
      }
      else if (parsed.type === "set-configuration") {
        if (connection.role !== "monitor" && connection.role !== "monitor-control") return send("error", { message: "Only the capture director can change run configuration" });
        await sessions.setConfiguration(sessionId, parsed.configuration);
      }
      else if (parsed.type === "set-hand-display") {
        if (!canSetHandDisplay(connection.role)) return send("error", { message: handDisplayAuthorityError });
        sessions.setHandDisplay(sessionId, parsed.settings, connection);
      }
      else if (parsed.type === "set-telemetry-mode") {
        sessions.setTelemetryMode(sessionId, connection, parsed.telemetryMode);
      }
      else if (parsed.type === "set-camera-registration") {
        if (connection.role !== "monitor" && connection.role !== "monitor-control") return send("error", { message: "Only the capture director can register the outward camera" });
        sessions.setCameraRegistration(sessionId, parsed.registration, connection);
      }
      else if (parsed.type === "configuration-applied") sessions.acknowledgeConfiguration(sessionId, connection, parsed.revision, parsed.checksum);
      else if (parsed.type === "recording-accepted") await sessions.acceptRecording(sessionId, connection, parsed.episodeId);
      else if (parsed.type === "recording-finalised") await sessions.finaliseRecording(sessionId, connection, parsed.episodeId, parsed.error);
      else if (parsed.type === "episode-upload-commit") {
        try {
          const result = await sessions.recordEpisodeUpload(
            sessionId,
            connection,
            parsed.requestId,
            parsed.episodeIds,
            parsed.receipt,
          );
          send("episode-upload-ack", {
            requestId: parsed.requestId,
            episodeIds: result.upload.episodeIds,
            status: result.status,
          });
        } catch (error) {
          send("episode-upload-error", {
            requestId: typeof parsed.requestId === "string" ? parsed.requestId : "",
            message: error instanceof Error ? error.message : "Hugging Face upload metadata could not be persisted",
          });
        }
      }
      else if (parsed.type === "delete-episode") await sessions.deleteEpisode(sessionId, connection, parsed.episodeId);
      else if (parsed.type === "prompt-audio-status") sessions.setPromptAudioStatus(sessionId, connection, parsed.status);
      else if (parsed.type === "prompt-ack") sessions.acknowledgePrompt(sessionId, connection, parsed.deliveryId, parsed.state, parsed.error);
      else if (parsed.type === "capture-status") await sessions.setCaptureStatus(sessionId, connection, parsed.status);
      else if (parsed.type === "control") {
        if (connection.role !== "monitor" && connection.role !== "monitor-control" && connection.role !== "capture") return send("error", { message: "Only the capture director or demonstrator can control the run" });
        await sessions.control(
          sessionId,
          parsed.action,
          connection,
          isStateBoundRunControlAction(parsed.action) && "nextCursor" in parsed && typeof parsed.nextCursor === "string"
            ? parsed.nextCursor
            : undefined,
        );
      }
      else if (parsed.type === "sensor-frame") await sessions.recordFrame(sessionId, connection, parsed.frame);
      else if (parsed.type === "media-chunk") await sessions.recordMedia(sessionId, connection, parsed.mimeType, parsed.sequence, parsed.dataBase64);
      else if (parsed.type === "transcript" && runtimeFeatures.speech) await sessions.recordTranscript(sessionId, parsed.text, parsed.timestampMs, connection);
      else if (parsed.type === "beam") sessions.beam(sessionId, parsed.text, parsed.speak, parsed.visual);
      else if (parsed.type === "monitor-load") sessions.setMonitorLoad(sessionId, connection, parsed.stage);
      else if (parsed.type === "restart-session") {
        if (!isSafeIdentifier(parsed.resetId)) return send("error", { message: "Session reset identifier is invalid" });
        await sessions.restartSession(sessionId, connection);
        send("session-restarted", { resetId: parsed.resetId });
      }
      else if (parsed.type === "audio-chunk") {
        await sessions.recordAudio(sessionId, connection, parsed.mimeType, parsed.sequence, parsed.dataBase64);
        if (asr && sessions.runSecondaryWork(sessionId)) {
          const transcriptionSessionId = sessionId;
          void asr.transcribe(parsed.dataBase64, parsed.mimeType).then(async (result) => {
            sessions.publishAsrStatus(transcriptionSessionId, result.available ? "ready" : "unavailable");
            if (result.text) await sessions.recordTranscript(transcriptionSessionId, result.text, Date.now());
          }).catch(() => sessions.publishAsrStatus(transcriptionSessionId, "error"));
        }
      } else if (parsed.type === "webrtc-request-offer") {
        sessions.requestOffer(sessionId, connection);
      }
      else if (parsed.type === "webrtc-signal") {
        const peerId = parsed.peerId ?? (connection.role === "monitor" ? connection.id : connection.activeWebRtcPeerId);
        if (peerId) sessions.relayWebRtc(sessionId, connection, peerId, parsed.signal);
      }
    } catch (error) {
      if (error instanceof RecorderStoreError || error instanceof RecorderProtocolError) sendRecorderError(send, recorderErrorPayload(error, sessionId ?? undefined));
      else send("error", { message: error instanceof Error ? error.message : "Session operation failed" });
    }
  });

  websocket.on("close", (code, reason) => {
    const questStreamArrivedAtMs = questStreamRecorder?.captureArrivalTime();
    if (questStreamConnectionId) questStreamRecorder?.connectionClosed(questStreamConnectionId, code, reason.toString(), questStreamArrivedAtMs);
    if (sessionId && connection) sessions.disconnect(sessionId, connection);
  });
});

server.listen(port, bindHost, () => console.log(`CERES capture server listening on ${certificate ? "https" : "http"}://${bindHost}:${port}`));

function parseMessage(value: string): ClientMessage | null {
  try {
    const message = JSON.parse(value) as ClientMessage;
    const base = z.object({ type: z.string() }).safeParse(message);
    if (!base.success) return null;
    if (message.type === "register" && !(["capture", "monitor", "monitor-control", "recorder"] satisfies ClientRole[]).includes(message.role)) return null;
    return message;
  } catch {
    return null;
  }
}

function rawDataBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function recorderErrorPayload(error: unknown, sessionId?: string): Omit<RecorderError, "type"> {
  if (error instanceof RecorderStoreError) {
    return { fatal: true, code: error.code, message: error.message, sessionId, expectedSequence: error.expectedSequence };
  }
  if (error instanceof RecorderProtocolError) {
    return { fatal: true, code: error.code, message: error.message, sessionId: error.sessionId ?? sessionId, sequence: error.sequence };
  }
  return { fatal: true, code: "write-failed", message: error instanceof Error ? error.message : "Recorder writer failed", sessionId };
}

function sendRecorderError(send: (type: string, payload: unknown) => void, payload: Omit<RecorderError, "type">) {
  send("recorder-error", payload);
}

function isSafeIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
