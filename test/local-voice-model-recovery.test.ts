import assert from "node:assert/strict";
import test from "node:test";
import model from "../shared/local-voice-model.json";
import { LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE } from "../src/local-voice-command.js";
import { LocalVoiceModelRecovery } from "../src/local-voice-model-recovery.js";

const missingFileError = new Error('`env.allowRemoteModels=false` and file was not found locally at "/models/onnx-community/moonshine-tiny-ONNX/onnx/encoder_model_q4.onnx".');

for (const status of [404, 410]) {
  test(`stops retrying only after a same-origin model resource returns ${status}`, async () => {
    const recovery = new LocalVoiceModelRecovery();
    const requests: string[] = [];
    const result = await recovery.failure(missingFileError, false, {
      fetch: async (input, options) => {
        requests.push(String(input));
        assert.equal(options?.method, "HEAD");
        assert.equal(options?.cache, "no-store");
        assert.equal(options?.redirect, "error");
        assert.ok(options?.signal instanceof AbortSignal);
        return new Response(null, { status: String(input).endsWith("encoder_model_q4.onnx") ? status : 200 });
      },
    });
    assert.deepEqual(requests.sort(), model.files.map(file => `/models/${model.modelId}/${file.path}`).sort());
    assert.equal(result.detail, LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE);
    assert.deepEqual(result.failure, { kind: "model-assets", diagnosticDetail: missingFileError.message });
    assert.equal(result.retryable, false);
    assert.equal(recovery.blocked, true);
    let repeatedProbes = 0;
    const repeated = await recovery.failure(missingFileError, false, {
      fetch: async () => { repeatedProbes += 1; return new Response(null, { status: 200 }); },
    });
    assert.equal(repeated.retryable, false);
    assert.equal(repeatedProbes, 0);
    const freshWorker = new LocalVoiceModelRecovery();
    assert.equal(freshWorker.blocked, false);
  });
}

for (const status of [200, 405, 500, 503]) {
  test(`keeps ambiguous local-file errors retryable when probes return ${status}`, async () => {
    const recovery = new LocalVoiceModelRecovery();
    const result = await recovery.failure(missingFileError, false, {
      fetch: async () => new Response(null, { status }),
    });
    assert.equal(result.retryable, true);
    assert.equal(result.failure.kind, "model-download");
    assert.equal(result.failure.diagnosticDetail, missingFileError.message);
    assert.equal(recovery.blocked, false);
    assert.notEqual(result.detail, LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE);
  });
}

test("keeps network errors retryable without claiming model files are missing", async () => {
  const recovery = new LocalVoiceModelRecovery();
  const result = await recovery.failure(missingFileError, false, {
    fetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(result.retryable, true);
  assert.equal(result.failure.kind, "model-download");
  assert.equal(recovery.blocked, false);
});

test("bounds all resource probes with one timeout and permits the next retry", async () => {
  const recovery = new LocalVoiceModelRecovery();
  let aborted = 0;
  const result = await recovery.failure(missingFileError, false, {
    timeoutMs: 5,
    fetch: (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => {
        aborted += 1;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
  });
  assert.equal(aborted, model.files.length);
  assert.equal(result.retryable, true);
  assert.equal(result.failure.kind, "model-download");
  assert.equal(recovery.blocked, false);
});

test("keeps genuine ONNX runtime failures distinct when model resources exist", async () => {
  const recovery = new LocalVoiceModelRecovery();
  const result = await recovery.failure(new Error("ONNX runtime aborted"), false, {
    fetch: async () => new Response(null, { status: 200 }),
  });
  assert.equal(result.failure.kind, "model-runtime");
  assert.equal(result.retryable, true);
});

test("preserves hosted remote model loading without probing local installation files", async () => {
  const recovery = new LocalVoiceModelRecovery();
  let probes = 0;
  const result = await recovery.failure(new Error("Failed to fetch remote model"), true, {
    fetch: async () => { probes += 1; return new Response(null, { status: 404 }); },
  });
  assert.equal(probes, 0);
  assert.equal(result.retryable, true);
  assert.equal(result.failure.kind, "model-download");
  assert.equal(recovery.blocked, false);
});
