import assert from "node:assert/strict";
import test from "node:test";
import { configureApplicationServices } from "../src/application-services.js";

import { webRtcSignalNegotiationId, type WebRtcSignal } from "../shared/protocol.js";
import { CaptureApp } from "../src/capture-app.js";
import { MonitorApp } from "../src/monitor-app.js";
import { TurnFallbackLease } from "../src/turn-lease.js";
import type { WebRtcSignalClient, WebRtcSignalError } from "../src/webrtc-signal-client.js";

const candidateSignal = (negotiationId: string): WebRtcSignal => ({
  negotiationId,
  candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host" },
});

test("normalises legacy negotiation signals and rejects unsafe generation identifiers", () => {
  assert.equal(webRtcSignalNegotiationId(undefined, "peer-1"), "legacy:peer-1");
  assert.equal(webRtcSignalNegotiationId("generation-2", "peer-1"), "generation-2");
  assert.equal(webRtcSignalNegotiationId("unsafe generation", "peer-1"), null);
  assert.equal(webRtcSignalNegotiationId("x".repeat(129), "peer-1"), null);
});

test("capture ignores a candidate from a retired negotiation generation", async () => {
  let addedCandidates = 0;
  const peer = {
    signalingState: "stable",
    addIceCandidate: async () => { addedCandidates += 1; },
  } as unknown as RTCPeerConnection;
  const app = Object.create(CaptureApp.prototype) as {
    acceptSignal(peerId: string, signal: WebRtcSignal): Promise<void>;
  };
  Object.assign(app, {
    disposed: false,
    peers: new Map([["peer-1", peer]]),
    peerNegotiationIds: new Map([["peer-1", "current-generation"]]),
    pendingIceCandidates: new Map([["current-generation", []]]),
    remoteDescriptionReadyPeers: new Set(["current-generation"]),
  });

  await app.acceptSignal("peer-1", candidateSignal("retired-generation"));
  assert.equal(addedCandidates, 0);
  await app.acceptSignal("peer-1", candidateSignal("current-generation"));
  assert.equal(addedCandidates, 1);
});

test("capture ignores an answer from a retired negotiation generation", async () => {
  let appliedDescriptions = 0;
  const peer = {
    signalingState: "have-local-offer",
    setRemoteDescription: async () => { appliedDescriptions += 1; },
    addIceCandidate: async () => undefined,
  } as unknown as RTCPeerConnection;
  const app = Object.create(CaptureApp.prototype) as {
    acceptSignal(peerId: string, signal: WebRtcSignal): Promise<void>;
  };
  Object.assign(app, {
    disposed: false,
    peers: new Map([["peer-1", peer]]),
    peerNegotiationIds: new Map([["peer-1", "current-generation"]]),
    pendingIceCandidates: new Map([["current-generation", []]]),
    remoteDescriptionReadyPeers: new Set<string>(),
  });

  const answer = (negotiationId: string): WebRtcSignal => ({
    negotiationId,
    description: { type: "answer", sdp: "v=0" },
  });
  await app.acceptSignal("peer-1", answer("retired-generation"));
  assert.equal(appliedDescriptions, 0);
  await app.acceptSignal("peer-1", answer("current-generation"));
  assert.equal(appliedDescriptions, 1);
});

test("monitor ignores a candidate from a retired negotiation generation", async () => {
  let addedCandidates = 0;
  const peer = {
    addIceCandidate: async () => { addedCandidates += 1; },
  } as unknown as RTCPeerConnection;
  const app = Object.create(MonitorApp.prototype) as {
    acceptSignal(root: HTMLElement, peerId: string, signal: WebRtcSignal): Promise<void>;
  };
  Object.assign(app, {
    disposed: false,
    rtcPeerId: "peer-1",
    rtcNegotiationId: "current-generation",
    peer,
    pendingIceCandidates: new Map<string, RTCIceCandidateInit[]>(),
    remoteDescriptionReadyPeers: new Set(["current-generation"]),
  });

  await app.acceptSignal({} as HTMLElement, "peer-1", candidateSignal("retired-generation"));
  assert.equal(addedCandidates, 0);
  await app.acceptSignal({} as HTMLElement, "peer-1", candidateSignal("current-generation"));
  assert.equal(addedCandidates, 1);
});

test("capture replaces an orphan offer whose signalling send failed", async () => {
  let createdPeers = 0;
  let scheduledRetries = 0;
  let signalIssues = 0;
  const app = Object.create(CaptureApp.prototype) as {
    createOffer(root: HTMLElement, peerId: string, replaceExisting?: boolean): Promise<void>;
    peers: Map<string, RTCPeerConnection>;
    peerNegotiationIds: Map<string, string>;
  };
  Object.assign(app, {
    disposed: false,
    captureAuthorityRevoked: false,
    pairingInvite: null,
    peers: new Map<string, RTCPeerConnection>(),
    peerNegotiationIds: new Map<string, string>(),
    signalledLocalDescriptions: new Set<string>(),
    createCapturePeer(_root: HTMLElement, peerId: string, negotiationId: string) {
      createdPeers += 1;
      const peer = {
        connectionState: "new",
        createOffer: async () => ({ type: "offer", sdp: `v=${createdPeers}` }),
        setLocalDescription: async () => undefined,
      } as unknown as RTCPeerConnection;
      this.peers.set(peerId, peer);
      this.peerNegotiationIds.set(peerId, negotiationId);
      return peer;
    },
    signalCaptureLocalDescription: () => false,
    scheduleCapturePeerNegotiationRetry: () => { scheduledRetries += 1; },
    reportTransientSignalIssue: () => { signalIssues += 1; },
  });

  await app.createOffer({} as HTMLElement, "peer-1");
  await app.createOffer({} as HTMLElement, "peer-1");
  assert.equal(createdPeers, 2);
  assert.equal(scheduledRetries, 2);
  assert.equal(signalIssues, 2);
});

test("TURN recovery creates a fresh capture peer before assigning the new generation", async () => {
  const iceServers: RTCIceServer[] = [{ urls: "turn:turn.example.test:3478", username: "user", credential: "secret" }];
  const existingPeer = { connectionState: "failed" } as RTCPeerConnection;
  let createdPeers = 0;
  let signalledDescriptions = 0;
  let scheduledRetries = 0;
  let appliedIceServers: RTCIceServer[] | null = null;
  const app = Object.create(CaptureApp.prototype) as {
    restartRelayedIce(root: HTMLElement, peerId: string): Promise<void>;
    peers: Map<string, RTCPeerConnection>;
    peerNegotiationIds: Map<string, string>;
  };
  Object.assign(app, {
    disposed: false,
    connectionProfile: { mode: "relayed" },
    peers: new Map([["peer-1", existingPeer]]),
    peerNegotiationIds: new Map([["peer-1", "retired-generation"]]),
    activeRelayedIceServers: () => iceServers,
    createCapturePeer(_root: HTMLElement, peerId: string, negotiationId: string, relayedIceServers: RTCIceServer[]) {
      createdPeers += 1;
      appliedIceServers = relayedIceServers;
      const peer = {
        createOffer: async () => ({ type: "offer", sdp: "v=0" }),
        setLocalDescription: async () => undefined,
      } as unknown as RTCPeerConnection;
      this.peers.set(peerId, peer);
      this.peerNegotiationIds.set(peerId, negotiationId);
      return peer;
    },
    signalCaptureLocalDescription: () => {
      signalledDescriptions += 1;
      return true;
    },
    scheduleCapturePeerNegotiationRetry: () => { scheduledRetries += 1; },
  });

  await app.restartRelayedIce({} as HTMLElement, "peer-1");
  assert.equal(createdPeers, 1);
  assert.equal(signalledDescriptions, 1);
  assert.equal(scheduledRetries, 1);
  assert.notEqual(app.peers.get("peer-1"), existingPeer);
  assert.deepEqual(appliedIceServers, iceServers);
});

test("monitor schedules a fresh offer after TURN lease acquisition fails", async (context) => {
  configureApplicationServices({ turn: {
    fields: () => "", mount: () => () => undefined,
    request: async () => { throw new Error("TURN server unavailable"); },
  } });
  context.after(() => configureApplicationServices({}));
  const peer = { connectionState: "failed" } as RTCPeerConnection;
  const fallback = new TurnFallbackLease();
  let resetPeers = 0;
  let privacyRevocations = 0;
  let scheduledRetries = 0;
  const app = Object.create(MonitorApp.prototype) as {
    activateTurnFallback(root: HTMLElement, peerId: string, peer: RTCPeerConnection): Promise<void>;
    peer: RTCPeerConnection | null;
  };
  Object.assign(app, {
    disposed: false,
    connectionProfile: { mode: "relayed" },
    accountSignedIn: true,
    relayedTurnFallback: fallback,
    sessionId: "session-1",
    peer,
    webRtcSignal: {},
    directSignallingConnected: true,
    showActivity: () => undefined,
    resetVideoPeer() {
      resetPeers += 1;
      this.peer = null;
      fallback.reset();
    },
    directSession: {
      resetTelemetryModeAuthority: () => { privacyRevocations += 1; },
      setCaptureConnected: () => undefined,
      snapshot: {},
    },
    renderSnapshot: () => undefined,
    scheduleOfferRequestRetry: () => { scheduledRetries += 1; },
  });

  await app.activateTurnFallback({} as HTMLElement, "peer-1", peer);
  assert.equal(resetPeers, 1);
  assert.equal(privacyRevocations, 1);
  assert.equal(scheduledRetries, 1);
  assert.equal(fallback.state, "idle");
});

test("monitor retries with a fresh permit when a TURN restart produces no offer", () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  let watchdog: (() => void) | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void) => {
        watchdog = callback;
        return 1;
      },
    },
  });
  try {
    const peer = { connectionState: "failed" } as RTCPeerConnection;
    const fallback = new TurnFallbackLease();
    const generation = fallback.beginRequest()!;
    fallback.accept(generation, {
      permitId: `permit_${"a".repeat(24)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      iceServers: [{ urls: "turn:turn.example.test:3478" }],
    });
    let resetPeers = 0;
    let scheduledRetries = 0;
    const app = Object.create(MonitorApp.prototype) as {
      scheduleTurnFallbackWatchdog(root: HTMLElement, generation: number): void;
      peer: RTCPeerConnection | null;
    };
    Object.assign(app, {
      disposed: false,
      peer,
      relayedTurnFallback: fallback,
      turnFallbackWatchdogTimer: null,
      webRtcSignal: {},
      directSignallingConnected: true,
      resetVideoPeer() {
        resetPeers += 1;
        this.peer = null;
        fallback.reset();
      },
      directSession: { setCaptureConnected: () => undefined, snapshot: {} },
      renderSnapshot: () => undefined,
      showActivity: () => undefined,
      scheduleOfferRequestRetry: () => { scheduledRetries += 1; },
    });

    app.scheduleTurnFallbackWatchdog({} as HTMLElement, generation);
    app.peer = { connectionState: "failed" } as RTCPeerConnection;
    assert.notEqual(watchdog, null);
    watchdog!();
    assert.equal(resetPeers, 1);
    assert.equal(scheduledRetries, 1);
    assert.equal(fallback.state, "idle");
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete (globalThis as unknown as Record<string, unknown>).window;
  }
});

test("capture treats a recoverable signalling outage as transient state", () => {
  const signal = {} as WebRtcSignalClient;
  const statuses: Array<{ message: string; error?: boolean }> = [];
  let persistentErrors = 0;
  const app = Object.create(CaptureApp.prototype) as {
    handleWebRtcSignalError(root: HTMLElement, signal: WebRtcSignalClient, error: WebRtcSignalError): void;
    handleWebRtcSignalConnection(root: HTMLElement, signal: WebRtcSignalClient, connected: boolean): void;
  };
  Object.assign(app, {
    webRtcSignal: signal,
    transientSignalIssue: null,
    pairingInvitationBound: false,
    connected: false,
    disposed: false,
    captureAuthorityRevoked: false,
    setStatus: (_root: HTMLElement, message: string, error?: boolean) => statuses.push({ message, error }),
    reportError: () => { persistentErrors += 1; },
  });

  app.handleWebRtcSignalError({} as HTMLElement, signal, { message: "WebRTC signalling was interrupted; retrying", retrying: true });
  app.handleWebRtcSignalConnection({} as HTMLElement, signal, true);
  assert.equal(persistentErrors, 0);
  assert.deepEqual(statuses, [
    { message: "WebRTC signalling was interrupted; retrying", error: true },
    { message: "Signalling restored; reconnecting to the capture director", error: undefined },
  ]);
});

test("monitor peer reset clears pending Beam delivery state", () => {
  const deliveryId = "a2f71cbf-bfbe-43db-87b1-42a451cb885e";
  const pending = new Set([deliveryId]);
  const activity: string[] = [];
  const teardownOrder: string[] = [];
  let peerClosed = 0;
  const app = Object.create(MonitorApp.prototype) as {
    resetVideoPeer(root: HTMLElement): void;
    peer: RTCPeerConnection | null;
  };
  Object.assign(app, {
    peer: { close: () => { peerClosed += 1; teardownOrder.push("peer-closed"); } },
    directSession: {
      resetTelemetryModeAuthority: () => { teardownOrder.push("privacy-revoked"); },
    },
    rtcPeerId: "peer-1",
    rtcNegotiationId: "generation-1",
    requestedFeed: true,
    pendingBeamDeliveries: pending,
    pendingIceCandidates: new Map(),
    remoteDescriptionReadyPeers: new Set(),
    peerControlChannel: {},
    episodeReviewMode: "live",
    peerRecorderAssembler: { reset: () => undefined },
    clearOfferRequestRetry: () => undefined,
    clearTurnFallbackWatchdog: () => undefined,
    resetTurnFallback: () => undefined,
    syncCameraOverlay: () => undefined,
    videoFrameCallback: null,
    showActivity: (_root: HTMLElement, message: string) => activity.push(message),
  });
  const video = { srcObject: {} };
  const root = {
    dataset: { lastBeamDeliveryId: deliveryId, lastBeamDeliveryState: "pending" },
    querySelector(selector: string) {
      if (selector === "#live-video") return video;
      return { classList: { remove: () => undefined } };
    },
  } as unknown as HTMLElement;

  app.resetVideoPeer(root);

  assert.equal(peerClosed, 1);
  assert.equal(app.peer, null);
  assert.equal(pending.size, 0);
  assert.equal(root.dataset.lastBeamDeliveryState, "interrupted");
  assert.deepEqual(activity, ["BEAM DELIVERY INTERRUPTED"]);
  assert.equal(video.srcObject, null);
  assert.deepEqual(teardownOrder, ["privacy-revoked", "peer-closed"]);
});
