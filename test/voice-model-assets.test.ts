import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseVoiceModelArguments,
  prepareVoiceModels,
  validateVoiceModelManifest,
  verifyVoiceModels,
} from "../scripts/prepare-voice-models.mjs";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function modelFixture(context: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-voice-model-"));
  context.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    return rm(root, { recursive: true, force: true });
  });
  const payloads = new Map([
    ["streaming_config.json", Buffer.from('{"encoder_dim":320}\n')],
    ["ort/encoder.ort", Buffer.from([8, 4, 18, 5, 10, 11, 12])],
  ]);
  const manifest = {
    modelId: "moonshine-ai/test-voice",
    revision: "quantized_26_07_30",
    downloadBaseUrl: "https://download.moonshine.ai/model/test-voice/quantized_26_07_30/",
    files: [...payloads].map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: hash(bytes) })),
  };
  const directory = path.join(root, "public/models");
  const filePath = (file: string) => path.join(directory, manifest.modelId, file);
  const requests: string[] = [];
  const baseUrl = manifest.downloadBaseUrl;
  const fetcher = async (input: string) => {
    requests.push(input);
    assert.ok(input.startsWith(baseUrl), input);
    const bytes = payloads.get(input.slice(baseUrl.length));
    assert.ok(bytes, input);
    return new Response(bytes);
  };
  return {
    root, directory, manifest, payloads, filePath, requests, fetcher,
    async write(file: string, bytes: Uint8Array) {
      await mkdir(path.dirname(filePath(file)), { recursive: true });
      await writeFile(filePath(file), bytes);
    },
    async contents() {
      return (await readdir(path.join(directory, manifest.modelId), { recursive: true })).sort();
    },
  };
}

test("missing model files use only the pinned revision and verified files work offline", async context => {
  const fixture = await modelFixture(context);
  const prepared = await prepareVoiceModels(fixture);
  assert.equal(prepared.downloaded, fixture.manifest.files.length);
  assert.equal(prepared.reused, 0);
  assert.equal(fixture.requests.length, fixture.manifest.files.length);
  for (const [file, bytes] of fixture.payloads) assert.deepEqual(await readFile(fixture.filePath(file)), bytes);
  assert.ok((await verifyVoiceModels(fixture)).every(file => file.valid));

  const offline = await prepareVoiceModels({ ...fixture, fetcher: () => { throw new Error("No network available"); } });
  assert.equal(offline.downloaded, 0);
  assert.equal(offline.reused, fixture.manifest.files.length);
  assert.equal(fixture.requests.length, fixture.manifest.files.length);
  assert.ok((await fixture.contents()).every(file => !file.endsWith(".tmp")));
});

test("same-sized corruption is repaired without downloading valid files again", async context => {
  const fixture = await modelFixture(context);
  await prepareVoiceModels(fixture);
  fixture.requests.length = 0;
  const file = fixture.manifest.files[1];
  await fixture.write(file.path, Buffer.alloc(file.bytes));
  assert.equal((await verifyVoiceModels(fixture))[1].reason, "SHA-256 mismatch");
  const repaired = await prepareVoiceModels(fixture);
  assert.equal(repaired.downloaded, 1);
  assert.equal(repaired.reused, 1);
  assert.equal(fixture.requests.length, 1);
  assert.ok(fixture.requests[0].endsWith(file.path));
  assert.deepEqual(await readFile(fixture.filePath(file.path)), fixture.payloads.get(file.path));
});

test("check reports every missing or corrupt file without writing or downloading", async context => {
  const fixture = await modelFixture(context);
  const check = () => prepareVoiceModels({ ...fixture, check: true, fetcher: () => { assert.fail("Check must not download"); } });
  await assert.rejects(check, error => {
    assert.ok(error instanceof Error);
    for (const file of fixture.manifest.files) assert.ok(error.message.includes(`${file.path}: missing`));
    assert.match(error.message, /npm run models:prepare/);
    return true;
  });
  assert.deepEqual(await readdir(fixture.root), []);
  const file = fixture.manifest.files[0];
  await fixture.write(file.path, Buffer.alloc(file.bytes));
  await assert.rejects(check, /SHA-256 mismatch/);
  assert.deepEqual(await readFile(fixture.filePath(file.path)), Buffer.alloc(file.bytes));
  await prepareVoiceModels(fixture);
  assert.equal((await check()).downloaded, 0);
});

test("incorrect downloads cannot replace existing files and temporary files are removed", async context => {
  for (const failure of ["hash", "short", "long"]) {
    await context.test(failure, async subcontext => {
      const fixture = await modelFixture(subcontext);
      const file = fixture.manifest.files[0];
      fixture.manifest.files = [file];
      const existing = Buffer.from("existing invalid asset");
      await fixture.write(file.path, existing);
      const length = file.bytes + (failure === "short" ? -1 : failure === "long" ? 1 : 0);
      await assert.rejects(prepareVoiceModels({
        ...fixture,
        fetcher: async () => new Response(Buffer.alloc(length)),
      }), failure === "hash" ? /SHA-256 mismatch/ : /Size mismatch/);
      assert.deepEqual(await readFile(fixture.filePath(file.path)), existing);
      assert.deepEqual(await fixture.contents(), [file.path]);
      await prepareVoiceModels(fixture);
      assert.deepEqual(await readFile(fixture.filePath(file.path)), fixture.payloads.get(file.path));
    });
  }
});

test("interrupted downloads leave no partial model or temporary files and can be retried", async context => {
  const fixture = await modelFixture(context);
  const file = fixture.manifest.files[1];
  fixture.manifest.files = [file];
  await assert.rejects(prepareVoiceModels({
    ...fixture,
    fetcher: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([8, 4])); },
      pull(controller) { controller.error(new Error("Connection interrupted")); },
    })),
  }), /Connection interrupted/);
  await assert.rejects(readFile(fixture.filePath(file.path)), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.dirname(fixture.filePath(file.path))), []);
  await prepareVoiceModels(fixture);
  assert.ok((await verifyVoiceModels(fixture)).every(result => result.valid));
});

test("offline and HTTP failures preserve existing files and give the recovery command", async context => {
  const fixture = await modelFixture(context);
  const file = fixture.manifest.files[0];
  fixture.manifest.files = [file];
  const existing = Buffer.from("original");
  await fixture.write(file.path, existing);
  for (const fetcher of [
    async () => { throw new Error("Offline"); },
    async () => new Response("Not found", { status: 404 }),
  ]) {
    await assert.rejects(prepareVoiceModels({ ...fixture, fetcher }), /npm run models:prepare/);
    assert.deepEqual(await readFile(fixture.filePath(file.path)), existing);
    assert.deepEqual(await fixture.contents(), [file.path]);
  }
});

test("linked output ancestors and model directories are rejected without changing their targets", async context => {
  for (const ancestor of ["public", "public/models", "public/models/moonshine-ai", "public/models/moonshine-ai/test-voice", "public/models/moonshine-ai/test-voice/ort"]) {
    await context.test(ancestor, async subcontext => {
      const fixture = await modelFixture(subcontext);
      const file = fixture.manifest.files[1];
      fixture.manifest.files = [file];
      const linked = path.join(fixture.root, ancestor);
      const outside = path.join(fixture.root, "outside-model-directory");
      const outsideFile = path.join(outside, path.relative(linked, fixture.filePath(file.path)));
      await mkdir(path.dirname(linked), { recursive: true });
      await mkdir(path.dirname(outsideFile), { recursive: true });
      const original = Buffer.from("Existing outside asset");
      await writeFile(outsideFile, original);
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      const before = (await readdir(outside, { recursive: true })).sort();
      const guarded = { ...fixture, fetcher: () => { assert.fail("Linked paths must be rejected before downloading"); } };
      await assert.rejects(verifyVoiceModels(guarded), /cannot traverse a link/);
      await assert.rejects(prepareVoiceModels({ ...guarded, check: true }), /cannot traverse a link/);
      await assert.rejects(prepareVoiceModels(guarded), /cannot traverse a link/);
      assert.deepEqual(await readFile(outsideFile), original);
      assert.deepEqual((await readdir(outside, { recursive: true })).sort(), before);
    });
  }
});

test("download writes recheck ancestors after the network request", async context => {
  const fixture = await modelFixture(context);
  const file = fixture.manifest.files[0];
  fixture.manifest.files = [file];
  const linked = path.join(fixture.directory, fixture.manifest.modelId);
  const outside = path.join(fixture.root, "outside-model-directory");
  await mkdir(outside);
  const original = Buffer.from("Existing outside asset");
  await writeFile(path.join(outside, file.path), original);
  await assert.rejects(prepareVoiceModels({
    ...fixture,
    fetcher: async () => {
      await mkdir(path.dirname(linked), { recursive: true });
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      return new Response(fixture.payloads.get(file.path));
    },
  }), /cannot traverse a link/);
  assert.deepEqual(await readFile(path.join(outside, file.path)), original);
  assert.deepEqual(await readdir(outside), [file.path]);
});

test("manifest validation rejects unpinned revisions, unsafe paths and ambiguous assets", () => {
  const valid = {
    modelId: "moonshine-ai/tiny-streaming-en",
    revision: "quantized_26_07_30",
    downloadBaseUrl: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_07_30/",
    files: [{ path: "ort/encoder.ort", bytes: 1, sha256: "b".repeat(64) }],
  };
  assert.equal(validateVoiceModelManifest(valid), valid);
  for (const revision of ["main", "latest", "quantized", "quantized_26_7_30", "../quantized_26_07_30"]) {
    assert.throws(() => validateVoiceModelManifest({ ...valid, revision }), /Invalid/);
  }
  for (const filePath of ["../secret", "/absolute", "ort/../../secret", "ort\\escape.ort", "ort//file.ort", "ort/file?download=1"]) {
    assert.throws(() => validateVoiceModelManifest({ ...valid, files: [{ ...valid.files[0], path: filePath }] }), /Invalid/);
  }
  for (const overrides of [{ bytes: 0 }, { bytes: 1.5 }, { sha256: "invalid" }]) {
    assert.throws(() => validateVoiceModelManifest({ ...valid, files: [{ ...valid.files[0], ...overrides }] }), /Invalid/);
  }
  assert.throws(() => validateVoiceModelManifest({ ...valid, files: [valid.files[0], { ...valid.files[0], path: "ORT/ENCODER.ORT" }] }), /duplicate/);
  for (const downloadBaseUrl of [
    undefined,
    "https://download.moonshine.ai/model/tiny-streaming-en/latest/",
    "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_07_30",
    "https://download.moonshine.ai/model/other/quantized_26_07_30/",
    "http://download.moonshine.ai/model/tiny-streaming-en/quantized_26_07_30/",
    "https://example.com/model/tiny-streaming-en/quantized_26_07_30/",
    `${valid.downloadBaseUrl}?redirect=elsewhere`,
  ]) {
    assert.throws(() => validateVoiceModelManifest({ ...valid, downloadBaseUrl }), /Invalid/);
  }
});

test("CLI paths are relative to the project and invalid arguments fail", () => {
  const root = path.resolve("fixture-project");
  assert.deepEqual(parseVoiceModelArguments([], root), { directory: path.join(root, "public/models"), check: false, help: false });
  assert.deepEqual(parseVoiceModelArguments(["--check", "--directory", "dist/models"], root), {
    directory: path.join(root, "dist/models"), check: true, help: false,
  });
  for (const args of [["--unknown"], ["--directory"], ["--directory", "--check"], ["--directory", "first", "--directory", "second"]]) {
    assert.throws(() => parseVoiceModelArguments(args, root), /Usage:/);
  }
});

test("CLI verifies the default or packaged directory from any working directory", async context => {
  const fixture = await modelFixture(context);
  await mkdir(path.join(fixture.root, "scripts"));
  await mkdir(path.join(fixture.root, "shared"));
  const script = path.join(fixture.root, "scripts/prepare-voice-models.mjs");
  await copyFile(new URL("../scripts/prepare-voice-models.mjs", import.meta.url), script);
  await writeFile(path.join(fixture.root, "shared/local-voice-model.json"), JSON.stringify(fixture.manifest));
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: "utf8", windowsHide: true });
  const missing = run("--check");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm run models:prepare/);
  await prepareVoiceModels(fixture);
  const valid = run("--check");
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /0 downloaded, 2 reused/);
  const packaged = path.join(fixture.root, "dist/models");
  await prepareVoiceModels({ ...fixture, directory: packaged });
  const packagedCheck = run("--check", "--directory", "dist/models");
  assert.equal(packagedCheck.status, 0, packagedCheck.stderr);
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  const invalid = run("--invalid");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid argument/);
});
