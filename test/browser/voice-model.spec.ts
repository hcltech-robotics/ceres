import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

interface VoiceMessage {
  type: string;
  status?: string;
  detail?: string;
  command?: string;
  active?: boolean;
  successful?: boolean;
  failure?: { kind: string };
}

interface VoiceProbe {
  workers: Worker[];
  messages: VoiceMessage[];
  microphones: MediaStream[];
}

declare global {
  interface Window { __ceresVoiceModelProbe: VoiceProbe }
}

const model = JSON.parse(readFileSync(resolve("shared/local-voice-model.json"), "utf8")) as {
  modelId: string;
  files: Array<{ path: string }>;
};
const onnxPaths = model.files
  .filter(file => file.path.endsWith(".onnx"))
  .map(file => `/models/${model.modelId}/${file.path}`);
const missingFilesMessage = "Voice command files are missing from this CERES installation. Repair the installation, then reload.";

// Generated locally with Windows System.Speech, Microsoft David Desktop,
// default rate and volume, speaking "Pause." into 16 kHz mono 16-bit PCM.
const pauseAudio = readFileSync(new URL("../fixtures/local-voice-pause.wav", import.meta.url)).toString("base64");

test.use({ serviceWorkers: "block" });

async function observeLocalVoice(context: BrowserContext, baseURL: string) {
  const external: string[] = [];
  const requests: string[] = [];
  const origin = new URL(baseURL).origin;
  context.on("request", request => requests.push(new URL(request.url()).pathname));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (!["data:", "blob:"].includes(url.protocol) && url.origin !== origin) {
      external.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await context.routeWebSocket(/.*/, socket => {
    if (new URL(socket.url()).host !== new URL(origin).host) {
      external.push(socket.url());
      socket.close();
    } else {
      socket.connectToServer();
    }
  });
  await context.addInitScript(() => {
    const probe: VoiceProbe = { workers: [], messages: [], microphones: [] };
    window.__ceresVoiceModelProbe = probe;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        if (!String(scriptURL).includes("local-voice-command.worker")) return;
        probe.workers.push(this);
        this.addEventListener("message", event => probe.messages.push(event.data));
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getUserMedia(constraints);
      if (stream.getAudioTracks().length) probe.microphones.push(stream);
      return stream;
    };
  });
  return { external, requests };
}

async function voiceMessages(page: Page) {
  return page.evaluate(() => window.__ceresVoiceModelProbe.messages);
}

async function expectVoiceReady(page: Page) {
  await page.waitForFunction(() => window.__ceresVoiceModelProbe.messages.some(message => (
    message.type === "status" && ["ready", "error"].includes(message.status ?? "")
  )), undefined, { timeout: 90_000 });
  expect((await voiceMessages(page)).filter(message => message.type === "status").at(-1)).toMatchObject({
    status: "ready",
    detail: "Local voice commands ready",
  });
}

async function recognisePause(page: Page) {
  await page.evaluate(async audio => {
    const bytes = Uint8Array.from(atob(audio), character => character.charCodeAt(0));
    const audioContext = new AudioContext({ sampleRate: 16_000 });
    try {
      const decoded = await audioContext.decodeAudioData(bytes.buffer);
      const samples = decoded.getChannelData(0).slice();
      const worker = window.__ceresVoiceModelProbe.workers.at(-1);
      if (!worker) throw new Error("The local voice worker has not started");
      worker.postMessage({ type: "audio", samples, sampleRate: decoded.sampleRate }, [samples.buffer]);
    } finally {
      await audioContext.close();
    }
  }, pauseAudio);
  await expect.poll(async () => (await voiceMessages(page))
    .filter(message => message.type === "command")
    .map(message => message.command), { timeout: 60_000 }).toContain("pause");
  await expect.poll(async () => (await voiceMessages(page)).some(message => (
    message.type === "recognition" && message.active === false && message.successful === true
  ))).toBe(true);
}

test("the bundled voice worker recognises a command with an empty cache and no external connections", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const network = await observeLocalVoice(context, baseURL!);
  await page.goto("/monitor/");
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  const workers = readdirSync(resolve("dist/assets"))
    .filter(name => /^local-voice-command\.worker-[^.]+\.js$/.test(name));
  expect(workers).toHaveLength(1);
  await page.evaluate(url => {
    const worker = new Worker(url, { type: "module" });
    worker.postMessage({ type: "initialise" });
  }, `/assets/${workers[0]}`);

  await expectVoiceReady(page);
  await recognisePause(page);

  for (const path of onnxPaths) expect(network.requests).toContain(path);
  expect(network.requests.some(path => /ort-wasm.*\.wasm$/.test(path))).toBe(true);
  expect(network.external).toEqual([]);
});

test("missing voice files leave capture and microphone recording available and recover after repair and reload", async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  const network = await observeLocalVoice(context, baseURL!);
  const missingPath = onnxPaths[0];
  expect(missingPath).toBeTruthy();
  let repaired = false;
  let missingRequests = 0;
  await context.route(url => url.pathname === missingPath, async route => {
    if (repaired) {
      await route.continue();
    } else {
      missingRequests += 1;
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" });
    }
  });

  await page.goto("/launch/capture/?mode=solo");
  await expect(page.locator("#solo-launch-state")).toHaveText(/Solo session (?:ready|restored)/);
  const audioRecording = page.getByRole("switch", { name: "Audio recording" });
  await audioRecording.click();
  await expect(audioRecording).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Enable camera", exact: true }).click();
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await expect(page.locator("#local-voice-status")).toHaveText(missingFilesMessage, { timeout: 30_000 });
  await expect(page.locator("#capture-status")).toHaveText("Camera ready");
  expect((await voiceMessages(page)).find(message => message.status === "error")).toMatchObject({
    type: "status",
    detail: missingFilesMessage,
    failure: { kind: "model-assets" },
  });

  const recording = await page.evaluate(async () => {
    const stream = window.__ceresVoiceModelProbe.microphones.at(-1);
    if (!stream) throw new Error("CERES has not acquired the microphone");
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    await new Promise<void>((resolveRecording, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Microphone recording produced no audio")), 5_000);
      recorder.addEventListener("dataavailable", event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        if (recorder.state === "recording") recorder.stop();
      });
      recorder.addEventListener("stop", () => {
        window.clearTimeout(timeout);
        resolveRecording();
      }, { once: true });
      recorder.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("Microphone recording failed"));
      }, { once: true });
      recorder.start(250);
    });
    return {
      bytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0),
      live: stream.getAudioTracks().every(track => track.readyState === "live"),
    };
  });
  expect(recording.bytes).toBeGreaterThan(0);
  expect(recording.live).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const sessionId = new URL(location.href).searchParams.get("session")!;
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle("ceres-solo-recordings");
    const session = await recordings.getDirectoryHandle(sessionId);
    try {
      const file = await session.getFileHandle("session.json");
      const catalogue = JSON.parse(await (await file.getFile()).text());
      return {
        recorder: catalogue.snapshot.captureStatus.recorder,
        lastError: catalogue.snapshot.captureStatus.lastError ?? null,
        blockers: catalogue.snapshot.sequenceReadiness.blockers.map((blocker: { code: string }) => blocker.code),
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  })).toEqual({ recorder: "armed", lastError: null, blockers: ["xr-not-active"] });

  const failedRequestCount = missingRequests;
  const failedMessageCount = (await voiceMessages(page)).length;
  await page.evaluate(() => {
    const worker = window.__ceresVoiceModelProbe.workers[0];
    worker.postMessage({ type: "initialise" });
    worker.postMessage({ type: "audio", samples: new Float32Array(16_000), sampleRate: 16_000 });
  });
  await page.waitForTimeout(35_000);
  expect(missingRequests).toBe(failedRequestCount);
  expect(await voiceMessages(page)).toHaveLength(failedMessageCount);
  expect(await page.evaluate(() => window.__ceresVoiceModelProbe.workers.length)).toBe(1);

  repaired = true;
  await page.reload();
  await expect(page.locator("#solo-launch-state")).toHaveText(/Solo session (?:ready|restored)/);
  await page.getByRole("button", { name: "Enable camera", exact: true }).click();
  await expectVoiceReady(page);
  await expect(page.locator("#local-voice-status")).not.toContainText(missingFilesMessage);
  await expect(page.locator("#join-camera-state")).toHaveText("OK");
  await recognisePause(page);
  expect(network.external).toEqual([]);
});
