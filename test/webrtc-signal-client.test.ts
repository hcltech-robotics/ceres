import assert from "node:assert/strict";
import test from "node:test";
import { PAIRING_CONNECTION_ACTIVE_CLOSE_CODE } from "../shared/protocol.js";
import {
  invitationAuthorityExpired,
  invitationCloseExpired,
  invitationHasExpired,
  WebRtcSignalClient,
  webRtcSignalUrl,
  type WebRtcSignalError,
} from "../src/webrtc-signal-client.js";

test("builds a session-scoped WebSocket URL for the selected relay", () => {
  assert.equal(
    webRtcSignalUrl("https://ceres.ceres-relay.workers.dev/", "abcd1234"),
    "wss://ceres.ceres-relay.workers.dev/signal?session=abcd1234",
  );
});

test("keeps loopback development relays on ws", () => {
  assert.equal(webRtcSignalUrl("http://localhost:8787", "abcd1234"), "ws://localhost:8787/signal?session=abcd1234");
});

test("classifies relay and local invitation expiry as terminal", () => {
  const invitation = {
    roomId: "ABCDEFG2",
    capability: "a-secure-pairing-capability",
    expiresAt: "2026-07-18T12:00:00.000Z",
  };
  assert.equal(invitationHasExpired(invitation, Date.parse("2026-07-18T12:00:00.000Z")), true);
  assert.equal(invitationCloseExpired({ code: 4408, reason: "Pairing invitation expired" }, invitation, 0), true);
  assert.equal(invitationCloseExpired({ code: 1006, reason: "" }, invitation, Date.parse("2026-07-18T11:59:59.000Z")), false);
  const boundAt = "2026-07-18T12:00:00.000Z";
  assert.equal(invitationAuthorityExpired({ ...invitation, bound: true, boundAt }, boundAt, Date.parse("2026-07-19T11:59:59.999Z")), false);
  assert.equal(invitationCloseExpired(
    { code: 4408, reason: "Pairing invitation expired" },
    { ...invitation, bound: true, boundAt },
    Date.parse("2026-07-18T12:00:00.001Z"),
    true,
    boundAt,
  ), false);
  assert.equal(invitationAuthorityExpired({ ...invitation, bound: true, boundAt }, boundAt, Date.parse("2026-07-19T12:00:00.000Z")), true);
  assert.equal(invitationCloseExpired(
    { code: 1006, reason: "" },
    { ...invitation, bound: true, boundAt },
    Date.parse("2026-07-19T12:00:00.000Z"),
  ), true);
});

test("a fresh invitation registers and reports a healthy relay connection", () => {
  const sockets: FakeWebSocket[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      {
        roomId: "ABCDEFG2",
        capability: "a-secure-pairing-capability",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const connections: boolean[] = [];
    const errors: string[] = [];
    client.on<boolean>("connection", (connected) => connections.push(connected));
    client.on<{ message: string }>("error", ({ message }) => errors.push(message));
    client.connect();
    sockets[0]!.serverOpen();
    const registration = JSON.parse(sockets[0]!.sent[0]!) as Record<string, unknown>;
    assert.match(String(registration.peerId), /^[A-Za-z0-9_-]{20,128}$/);
    assert.deepEqual(registration, {
      type: "register",
      protocol: "invitation",
      sessionId: "session-abcd1234",
      role: "monitor",
      roomId: "ABCDEFG2",
      capability: "a-secure-pairing-capability",
      peerId: registration.peerId,
    });
    sockets[0]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "monitor",
    }));
    assert.deepEqual(connections, [true]);
    assert.deepEqual(errors, []);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
  }
});

test("an invitation capture registers its stable tab identity", () => {
  const sockets: FakeWebSocket[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "capture",
      "https://relay.example.test",
      "capture-tab-one",
      {
        roomId: "ABCDEFG2",
        capability: "a-secure-pairing-capability",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const bounds: string[] = [];
    client.on<string>("invitation-bound", (boundAt) => bounds.push(boundAt));
    client.connect();
    sockets[0]!.serverOpen();
    assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), {
      type: "register",
      protocol: "invitation",
      sessionId: "session-abcd1234",
      role: "capture",
      roomId: "ABCDEFG2",
      capability: "a-secure-pairing-capability",
      pairingId: "capture-tab-one",
    });
    const pickedUpAt = new Date().toISOString();
    sockets[0]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "capture",
      pickedUpAt,
    }));
    assert.deepEqual(bounds, [pickedUpAt]);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
  }
});

test("capture intent and XR authority survive signalling registration and reconnect", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void) => {
        reconnects.push(callback);
        return reconnects.length;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "capture",
      "https://relay.example.test",
      "capture-tab-one",
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability", bound: true },
    );
    const intent: boolean[] = [];
    const authority: boolean[] = [];
    client.on<boolean>("capture-intent", (granted) => intent.push(granted));
    client.on<boolean>("capture-authority", (granted) => authority.push(granted));
    assert.equal(client.markXrActive(), false);
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "capture",
    }));
    assert.deepEqual(sockets[0]!.sent.slice(1).map((message) => JSON.parse(message)), [
      { type: "capture-intent" },
      { type: "capture-xr-active" },
    ]);
    sockets[0]!.serverMessage(JSON.stringify({ type: "capture-intent-granted" }));
    sockets[0]!.serverMessage(JSON.stringify({ type: "capture-intent-suspended" }));
    sockets[0]!.serverMessage(JSON.stringify({ type: "capture-authority-granted" }));
    assert.deepEqual(intent, [true, false]);
    assert.deepEqual(authority, [true]);

    sockets[0]!.serverClose(1006, "");
    assert.equal(reconnects.length, 1);
    reconnects[0]!();
    sockets[1]!.serverOpen();
    sockets[1]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "capture",
    }));
    assert.deepEqual(sockets[1]!.sent.slice(1).map((message) => JSON.parse(message)), [
      { type: "capture-intent" },
      { type: "capture-xr-active" },
    ]);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
  }
});

test("an expired invitation reports its cause and never schedules another connection", () => {
  const sockets: FakeWebSocket[] = [];
  let scheduledReconnects = 0;
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }

  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: () => {
        scheduledReconnects += 1;
        return scheduledReconnects;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability" },
    );
    const errors: string[] = [];
    client.on<{ message: string }>("error", ({ message }) => errors.push(message));
    client.connect();
    assert.equal(sockets.length, 1);

    sockets[0]!.serverClose(4408, "Pairing invitation expired");

    assert.deepEqual(errors, ["Pairing invitation expired"]);
    assert.equal(scheduledReconnects, 0);
    client.connect();
    assert.equal(sockets.length, 1);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
  }
});

test("a relay policy rejection reports its reason and never reconnects", () => {
  const sockets: FakeWebSocket[] = [];
  let scheduledReconnects = 0;
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: () => {
        scheduledReconnects += 1;
        return scheduledReconnects;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "capture",
      "https://relay.example.test",
      "capture-tab-two",
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability" },
    );
    const errors: Array<{ message: string; code?: number; terminal?: boolean }> = [];
    client.on<{ message: string; code?: number; terminal?: boolean }>("error", (error) => errors.push(error));
    client.connect();
    sockets[0]!.serverClose(4403, "A different capture tab is already paired");

    assert.deepEqual(errors, [{
      message: "A different capture tab is already paired",
      code: 4403,
      terminal: true,
    }]);
    assert.equal(scheduledReconnects, 0);
    client.connect();
    assert.equal(sockets.length, 1);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
  }
});

test("an invitation monitor keeps its peer identity while signalling reconnects", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void) => {
        reconnects.push(callback);
        return reconnects.length;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability" },
    );
    const connections: boolean[] = [];
    const errors: WebRtcSignalError[] = [];
    client.on<boolean>("connection", (connected) => connections.push(connected));
    client.on<WebRtcSignalError>("error", (error) => errors.push(error));
    client.connect();
    sockets[0]!.serverOpen();
    const firstRegistration = JSON.parse(sockets[0]!.sent[0]!) as { peerId?: unknown };
    assert.match(String(firstRegistration.peerId), /^[A-Za-z0-9_-]{20,128}$/);
    sockets[0]!.dispatchEvent(new Event("error"));
    sockets[0]!.serverClose(1006, "");

    assert.deepEqual(connections, [false]);
    assert.deepEqual(errors, [{ message: "WebRTC signalling was interrupted; retrying", retrying: true }]);
    assert.equal(reconnects.length, 1);

    reconnects[0]!();
    assert.equal(sockets.length, 2);
    sockets[1]!.serverOpen();
    const secondRegistration = JSON.parse(sockets[1]!.sent[0]!) as { peerId?: unknown };
    assert.equal(secondRegistration.peerId, firstRegistration.peerId);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
  }
});

test("a picked-up invitation reconnects instead of expiring when the public timer closes signalling", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void) => {
        reconnects.push(callback);
        return reconnects.length;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      {
        roomId: "ABCDEFG2",
        capability: "a-secure-pairing-capability",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    const connections: boolean[] = [];
    const errors: WebRtcSignalError[] = [];
    client.on<boolean>("connection", (connected) => connections.push(connected));
    client.on<WebRtcSignalError>("error", (error) => errors.push(error));
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "monitor",
    }));
    sockets[0]!.serverMessage(JSON.stringify({
      type: "invitation-picked-up",
      sessionId: "session-abcd1234",
      pickedUpAt: new Date().toISOString(),
    }));

    sockets[0]!.serverClose(4408, "Pairing invitation expired");

    assert.deepEqual(connections, [true, false]);
    assert.deepEqual(errors, []);
    assert.equal(reconnects.length, 1);
    reconnects[0]!();
    assert.equal(sockets.length, 2);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
  }
});

test("a matching identity waits for the active relay socket to close", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const reconnectDelays: number[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void, delay: number) => {
        reconnects.push(callback);
        reconnectDelays.push(delay);
        return reconnects.length;
      },
    },
  });
  Object.defineProperty(Math, "random", { configurable: true, value: () => 0.5 });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "capture",
      "https://relay.example.test",
      "copied-pairing-id",
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability", bound: true },
    );
    const connections: boolean[] = [];
    const errors: string[] = [];
    client.on<boolean>("connection", (connected) => connections.push(connected));
    client.on<{ message: string }>("error", ({ message }) => errors.push(message));
    client.connect();
    sockets[0]!.dispatchEvent(new Event("error"));
    sockets[0]!.serverClose(PAIRING_CONNECTION_ACTIVE_CLOSE_CODE, "The paired capture tab is still connected");

    assert.deepEqual(connections, [false]);
    assert.deepEqual(errors, []);
    assert.equal(reconnects.length, 1);
    assert.deepEqual(reconnectDelays, [5_000]);

    reconnects[0]!();
    assert.equal(sockets.length, 2);
    sockets[1]!.serverOpen();
    sockets[1]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "capture",
    }));
    assert.deepEqual(connections, [false, true]);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
    if (randomDescriptor) Object.defineProperty(Math, "random", randomDescriptor);
  }
});

test("stops an unregistered client after eight exponentially backed-off attempts", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const reconnectDelays: number[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void, delay: number) => {
        reconnects.push(callback);
        reconnectDelays.push(delay);
        return reconnects.length;
      },
    },
  });
  Object.defineProperty(Math, "random", { configurable: true, value: () => 0.5 });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "capture",
      "https://relay.example.test",
      "capture-tab-one",
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability", bound: true },
    );
    const errors: WebRtcSignalError[] = [];
    client.on<WebRtcSignalError>("error", (error) => errors.push(error));
    client.connect();

    for (let attempt = 0; attempt < 7; attempt += 1) {
      sockets[attempt]!.serverClose(1006, "");
      reconnects[attempt]!();
    }
    sockets[7]!.serverClose(1006, "");

    assert.equal(sockets.length, 8);
    assert.deepEqual(reconnectDelays, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    assert.deepEqual(errors, [{
      message: "The signalling relay could not be reached after repeated attempts",
      code: 1006,
      terminal: true,
    }]);
    client.connect();
    assert.equal(sockets.length, 8);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
    if (randomDescriptor) Object.defineProperty(Math, "random", randomDescriptor);
  }
});

test("keeps retrying a previously registered session at the capped delay", () => {
  const sockets: FakeWebSocket[] = [];
  const reconnects: Array<() => void> = [];
  const reconnectDelays: number[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: (callback: () => void, delay: number) => {
        reconnects.push(callback);
        reconnectDelays.push(delay);
        return reconnects.length;
      },
    },
  });
  Object.defineProperty(Math, "random", { configurable: true, value: () => 0.5 });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability" },
    );
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverMessage(JSON.stringify({
      type: "session-registered",
      sessionId: "session-abcd1234",
      role: "monitor",
    }));

    for (let attempt = 0; attempt < 10; attempt += 1) {
      sockets[attempt]!.serverClose(1006, "");
      reconnects[attempt]!();
    }

    assert.equal(sockets.length, 11);
    assert.deepEqual(reconnectDelays, [
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      60_000,
      60_000,
      60_000,
      60_000,
    ]);
    client.dispose();
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
    if (randomDescriptor) Object.defineProperty(Math, "random", randomDescriptor);
  }
});

test("pauses reconnects while offline and removes the online listener on disposal", () => {
  const sockets: FakeWebSocket[] = [];
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let onlineListener: (() => void) | null = null;
  let removedListener: (() => void) | null = null;
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: TestWebSocket });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout: () => undefined,
      setTimeout: () => assert.fail("offline reconnect should not schedule a timer"),
      addEventListener: (event: string, listener: () => void) => {
        if (event === "online") onlineListener = listener;
      },
      removeEventListener: (event: string, listener: () => void) => {
        if (event === "online") removedListener = listener;
      },
    },
  });

  try {
    const client = new WebRtcSignalClient(
      "session-abcd1234",
      "monitor",
      "https://relay.example.test",
      null,
      { roomId: "ABCDEFG2", capability: "a-secure-pairing-capability" },
    );
    client.connect();
    sockets[0]!.serverClose(1006, "");
    assert.ok(onlineListener);

    client.dispose();
    assert.equal(removedListener, onlineListener);
  } finally {
    restoreGlobal("WebSocket", webSocketDescriptor);
    restoreGlobal("window", windowDescriptor);
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as unknown as Record<string, unknown>).navigator;
  }
});

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(value: string) {
    this.sent.push(value);
  }

  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  serverMessage(data: string) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.serverClose(code, reason);
  }

  serverClose(code: number, reason: string) {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

function restoreGlobal(name: "WebSocket" | "window", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as unknown as Record<string, unknown>)[name];
}
