import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectNativePackages, platforms } from "../scripts/collect-native-release.mjs";
import { githubApi, preflightRelease, publishRelease, validateChecksums, validateIdentity } from "../scripts/publish-public-release.mjs";
import { prepareLocalRelease, verifyLocalRelease } from "../scripts/prepare-local-release.mjs";

const revision = "a".repeat(40);
const version = "1.2.3";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const file = (name, text) => ({ name, bytes: Buffer.from(text), sha256: hash(Buffer.from(text)) });
function inventory() {
  const payloads = [file("ceres-viewer-1.2.3-windows-x64.zip", "windows"), file("ceres-viewer-1.2.3-linux-x64.tar.gz", "linux")];
  return [...payloads, file("SHA256SUMS", payloads.map(item => `${item.sha256}  ${item.name}\n`).join("")),
    file("SHA256SUMS.sigstore.json", "new signature")];
}
function fixture({ draft = true, exists = false, existing = [], target = revision, failUpload } = {}) {
  let nextId = 1;
  let release = exists ? { id: 1, draft, tag_name: "v1.2.3", target_commitish: target } : null;
  let assets = existing.map(item => ({ id: nextId++, name: item.name, digest: item.sha256, state: "uploaded" }));
  const operations = [];
  const api = {
    async verifyTag(tag, sha) { assert.equal(tag, "v1.2.3"); assert.equal(sha, revision); operations.push("verify"); },
    async findRelease() { return release; },
    async createDraft() { operations.push("create"); release = { id: 1, draft: true, tag_name: "v1.2.3", target_commitish: revision }; return release; },
    async listAssets() { return assets.map(item => ({ ...item })); },
    async assetDigest(asset) { return asset.digest; },
    async uploadAsset(id, item) {
      operations.push(`upload:${item.name}`);
      if (failUpload === item.name) throw new Error("Upload interrupted");
      assets.push({ id: nextId++, name: item.name, digest: item.sha256, state: "uploaded" });
    },
    async deleteAsset(id) { operations.push("delete"); assets = assets.filter(item => item.id !== id); },
    async publishDraft() { operations.push("publish"); release.draft = false; },
  };
  return { api, operations, run: files => publishRelease({ api, files, tag: "v1.2.3", revision, version, notes: "Native downloads" }) };
}

test("validates the exact release version and full source revision", () => {
  assert.doesNotThrow(() => validateIdentity({ tag: "v1.2.3", revision, version }));
  assert.throws(() => validateIdentity({ tag: "v1.2.4", revision, version }), /package version/);
  assert.throws(() => validateIdentity({ tag: "v1.2.3", revision: "main", version }), /full commit/);
});

test("publishes a complete verified draft and uploads its checksum identity first", async () => {
  const target = fixture();
  const result = await target.run(inventory());
  assert.equal(result.status, "published");
  assert.deepEqual(target.operations.slice(0, 3), ["verify", "create", "upload:SHA256SUMS"]);
  assert.equal(target.operations.at(-1), "publish");
});

test("resumes a partially uploaded matching draft without replacing payloads", async () => {
  const files = inventory();
  const target = fixture({ exists: true, existing: [files[0], files[2]] });
  await target.run(files);
  assert.ok(!target.operations.includes(`upload:${files[0].name}`));
  assert.ok(!target.operations.includes("delete"));
  assert.equal(target.operations.at(-1), "publish");
});

test("refreshes regenerated signatures only within a matching draft", async () => {
  const files = inventory();
  const target = fixture({ exists: true, existing: [...files.slice(0, 3), file(files[3].name, "earlier signature")] });
  await target.run(files);
  assert.deepEqual(target.operations, ["verify", "delete", `upload:${files[3].name}`, "publish"]);
});

test("rejects a changed qualified payload before mutating a draft", async () => {
  const files = inventory();
  const target = fixture({ exists: true, existing: [file(files[0].name, "different binary"), files[2]] });
  await assert.rejects(target.run(files), /Existing release asset differs/);
  assert.deepEqual(target.operations, ["verify"]);
});

test("rejects a different checksum identity before attaching missing assets", async () => {
  const files = inventory();
  const target = fixture({ exists: true, existing: [file("SHA256SUMS", "unrelated manifest")] });
  await assert.rejects(target.run(files), /different qualified payloads/);
  assert.deepEqual(target.operations, ["verify"]);
});

test("rejects foreign draft targets and unexpected release assets", async () => {
  const foreign = fixture({ exists: true, target: "b".repeat(40) });
  await assert.rejects(foreign.run(inventory()), /different source revision/);
  assert.deepEqual(foreign.operations, ["verify"]);
  const unexpected = fixture({ exists: true, existing: [...inventory(), file("extra.exe", "unexpected")] });
  await assert.rejects(unexpected.run(inventory()), /unexpected or duplicate/);
  assert.deepEqual(unexpected.operations, ["verify"]);
});

test("does not publish after an interrupted upload", async () => {
  const target = fixture({ failUpload: inventory()[0].name });
  await assert.rejects(target.run(inventory()), /Upload interrupted/);
  assert.ok(!target.operations.includes("publish"));
});

test("does not change an already published matching release", async () => {
  const target = fixture({ exists: true, draft: false, existing: inventory() });
  assert.equal((await target.run(inventory())).status, "already-published");
  assert.deepEqual(target.operations, ["verify"]);
});

test("does not add missing assets to a published release", async () => {
  const files = inventory();
  const target = fixture({ exists: true, draft: false, existing: [files[2]] });
  await assert.rejects(target.run(files), /Published release is missing/);
  assert.deepEqual(target.operations, ["verify"]);
});

test("requires the checksum manifest to cover each payload exactly once", () => {
  const files = inventory();
  assert.doesNotThrow(() => validateChecksums(files));
  assert.throws(() => validateChecksums([...files, file("missing.zip", "unlisted")]), /inventory differs/);
  assert.throws(() => validateChecksums(files.map(item => item.name === files[0].name ? file(item.name, "changed") : item)), /checksum differs/);
  assert.throws(() => validateChecksums(files.map(item => item.name === "SHA256SUMS" ? file(item.name, `${files[0].sha256}  ../outside\n`) : item)), /Invalid or duplicate/);
});

test("refuses an unanchored existing draft", async () => {
  const target = fixture({ exists: true, existing: [inventory()[0]] });
  await assert.rejects(target.run(inventory()), /no payload identity/);
  assert.deepEqual(target.operations, ["verify"]);
});

test("published preflight verifies payloads before skipping external publication", async () => {
  const target = fixture({ exists: true, draft: false, existing: inventory() });
  assert.equal((await preflightRelease({ api: target.api, files: inventory(), tag: "v1.2.3", revision, version })).published, true);
  await assert.rejects(preflightRelease({ api: target.api, files: [...inventory(), file("absent.zip", "missing")], tag: "v1.2.3", revision, version }), /Published release payload differs/);
  assert.deepEqual(target.operations, ["verify", "verify"]);
});

test("streams release uploads with an exact content length", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-release-upload-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "archive.tar.gz");
  const expected = Buffer.from("qualified archive");
  await writeFile(filename, expected);
  const api = githubApi("test-token", async (url, options) => {
    assert.ok(url.startsWith("https://uploads.github.com/repos/hcltech-robotics/ceres/releases/7/assets"));
    assert.equal(options.headers["Content-Length"], String(expected.length));
    const chunks = [];
    for await (const chunk of options.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), expected);
    return { ok: true, json: async () => ({ id: 3 }) };
  });
  assert.deepEqual(await api.uploadAsset(7, { name: "archive.tar.gz", path: filename }), { id: 3 });
});

async function nativeFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-native-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "artifacts");
  const output = path.join(root, "release");
  await mkdir(input);
  const directories = {};
  for (const platform of platforms) {
    const directory = path.join(input, `ceres-native-${revision}-${platform}`);
    directories[platform] = directory;
    await mkdir(directory);
    const base = `ceres-viewer-${version}-${platform}`;
    const archive = `${base}.${platform === "windows-x64" ? "zip" : "tar.gz"}`;
    const sha256 = hash(Buffer.from(platform));
    await writeFile(path.join(directory, archive), platform);
    await writeFile(path.join(directory, `${archive}.sha256`), `${sha256}  ${archive}\n`);
    const identity = { version: 1, platform, release_version: version, source_revision: revision };
    await writeFile(path.join(directory, `${archive}.manifest.json`), JSON.stringify({ ...identity, schema: "ceres-viewer-package", files: {} }));
    await writeFile(path.join(directory, `${archive}.spdx.json`), JSON.stringify({ spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", packages: [{ name: "ceres-viewer" }] }));
    await writeFile(path.join(directory, `${base}.verification.json`), JSON.stringify({ ...identity, schema: "ceres-viewer-package-verification", passed: true, archive_sha256: sha256 }));
    await writeFile(path.join(directory, "workflow-inputs.json"), JSON.stringify({ ...identity, schema: "ceres-native-build-inputs" }));
  }
  return { input, output, directories, run: () => collectNativePackages({ input, output, version, revision }) };
}

test("collects the three verified native archives before release signing", async context => {
  const fixture = await nativeFixture(context);
  const result = await fixture.run();
  assert.deepEqual(result.packages.map(item => item.platform), platforms);
  const files = await readdir(fixture.output);
  assert.equal(files.length, 19);
  assert.ok(files.includes(`ceres-viewer-${version}-linux-arm64.inputs.json`));
  assert.ok(!files.includes("workflow-inputs.json"));
});

test("rejects a missing platform and never creates a partial release", async context => {
  const fixture = await nativeFixture(context);
  await rm(fixture.directories["linux-arm64"], { recursive: true });
  await assert.rejects(fixture.run(), /exactly the three/);
  await assert.rejects(readdir(fixture.output), { code: "ENOENT" });
});

test("rejects metadata from a different source revision", async context => {
  const fixture = await nativeFixture(context);
  const filename = path.join(fixture.directories["windows-x64"], "workflow-inputs.json");
  const metadata = JSON.parse(await readFile(filename, "utf8"));
  metadata.source_revision = "b".repeat(40);
  await writeFile(filename, JSON.stringify(metadata));
  await assert.rejects(fixture.run(), /build inputs identity differs/);
  await assert.rejects(readdir(fixture.output), { code: "ENOENT" });
});

test("rejects a replaced archive even when its filename remains correct", async context => {
  const fixture = await nativeFixture(context);
  await writeFile(path.join(fixture.directories["linux-x64"], `ceres-viewer-${version}-linux-x64.tar.gz`), "changed package");
  await assert.rejects(fixture.run(), /archive checksum differs/);
  await assert.rejects(readdir(fixture.output), { code: "ENOENT" });
});

test("rejects a successful report for another archive", async context => {
  const fixture = await nativeFixture(context);
  const filename = path.join(fixture.directories["linux-x64"], `ceres-viewer-${version}-linux-x64.verification.json`);
  const metadata = JSON.parse(await readFile(filename, "utf8"));
  metadata.archive_sha256 = "c".repeat(64);
  await writeFile(filename, JSON.stringify(metadata));
  await assert.rejects(fixture.run(), /matching successful verification/);
});

test("rejects stray build output in a release package artefact", async context => {
  const fixture = await nativeFixture(context);
  await writeFile(path.join(fixture.directories["linux-x64"], "test_image"), "GPU test binary");
  await assert.rejects(fixture.run(), /inventory differs/);
});

async function localFixture(context) {
  const fixture = await nativeFixture(context);
  const native = await fixture.run();
  for (const name of [`ceres-${version}-source.tar.gz`, `ceres-${version}-runtime.tar.gz`, "ceres-container.tar.gz",
    "ceres-source.spdx.json", "ceres-container.spdx.json", "python-environment.json", "ceres_bridge-1.0.0-py3-none-any.whl", "ceres_bridge-1.0.0.tar.gz"]) {
    await writeFile(path.join(fixture.output, name), `release payload ${name}`);
  }
  await writeFile(path.join(fixture.output, "native-hardware-qualification.json"), JSON.stringify({ status: "passed",
    platforms: Object.fromEntries(native.packages.map(item => [item.platform, { archive_sha256: item.sha256 }])) }));
  const signingKey = path.join(path.dirname(fixture.output), "test-signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey], { windowsHide: true });
  const publicKey = (await readFile(`${signingKey}.pub`, "utf8")).trim().split(/\s+/).slice(0, 2).join(" ");
  const options = { directory: fixture.output, version, revision, signer: "test-maintainer", signingKey, keys: async () => [publicKey] };
  return { ...fixture, options, run: () => prepareLocalRelease(options), verify: () => verifyLocalRelease(options) };
}

test("locally signs the complete release and verifies its real SSH signature", async context => {
  const fixture = await localFixture(context);
  assert.equal((await fixture.run()).status, "verified");
  assert.equal((await fixture.verify()).status, "verified");
  const sums = await readFile(path.join(fixture.output, "SHA256SUMS"), "utf8");
  assert.ok(sums.includes("local-release-provenance.json"));
  assert.ok(sums.includes("release-signing-key.pub"));
  assert.ok(!sums.includes("SHA256SUMS.sig"));
  assert.equal((await fixture.run()).status, "verified");
});

test("rejects a locally signed release when a payload has changed", async context => {
  const fixture = await localFixture(context);
  await fixture.run();
  await writeFile(path.join(fixture.output, "ceres-container.tar.gz"), "replaced container");
  await assert.rejects(fixture.verify(), /Release checksum differs/);
  await assert.rejects(fixture.run(), /Release checksum differs/);
});

test("requires the signer key to match the independently retrieved GitHub key", async context => {
  const fixture = await localFixture(context);
  await assert.rejects(prepareLocalRelease({ ...fixture.options, keys: async () => [] }), /does not belong/);
  assert.ok(!(await readdir(fixture.output)).includes("SHA256SUMS.sig"));
  await fixture.run();
  await assert.rejects(verifyLocalRelease({ ...fixture.options, keys: async () => [] }), /does not belong/);
});

test("rejects stale hardware evidence before creating a local signature", async context => {
  const fixture = await localFixture(context);
  const filename = path.join(fixture.output, "native-hardware-qualification.json");
  const hardware = JSON.parse(await readFile(filename, "utf8"));
  hardware.platforms["linux-arm64"].archive_sha256 = "f".repeat(64);
  await writeFile(filename, JSON.stringify(hardware));
  await assert.rejects(fixture.run(), /hardware qualification differs/);
  assert.ok(!(await readdir(fixture.output)).includes("SHA256SUMS.sig"));
});
