import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function boundaryFixture(context: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await copyFile(new URL("../scripts/check-public-boundary.mjs", import.meta.url), path.join(root, "scripts/check-public-boundary.mjs"));
  await writeFile(path.join(root, "package-lock.json"), '{"packages":{}}');
  return {
    async write(file: string, content: string) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    },
    remove(file: string) { return rm(path.join(root, file)); },
    run(...args: string[]) {
      return spawnSync(process.execPath, ["scripts/check-public-boundary.mjs", ...args], { cwd: root, encoding: "utf8" });
    },
  };
}

test("native product docs pass while private docs and local model assets fail", async context => {
  const fixture = await boundaryFixture(context);
  await fixture.write("native/viewer/docs/packaging.md", "# Packaging\n\nPortable viewer packages.\n");
  await fixture.write("native/viewer/src/mano.cpp", "// Optional local model support.\n");
  await fixture.write("native/viewer/build-native/CMakeCache.txt", "Local build output.\n");
  await fixture.write("src/dataset-replay-zstd.ts", "export const compressors = {};\n");
  const accepted = fixture.run();
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const file of [
    "docs/private.md", "native/lerobot-exporter/docs/private.md", "native/viewer/docs/private/note.md",
    "native/viewer/AGENTS.md", "native/viewer/import-provenance.json", "native/viewer/assets/local/mano-left.bin",
    "native/viewer/MANO_RIGHT.pkl", "native/viewer/artifacts/recording.json", "native/viewer/secret.key",
    "src/dataset-replay-app.ts", "src/private/dataset-replay-zstd.ts",
    ".github/workflows/native-viewer-hardware.yml", ".github/scripts/run-native-qualification.py",
  ]) {
    await fixture.write(file, "private material\n");
    const rejected = fixture.run();
    assert.notEqual(rejected.status, 0, file);
    assert.ok(rejected.stderr.includes(`Excluded source: ${file}`), rejected.stderr);
    await fixture.remove(file);
  }
});

test("source maps permit only the shared Parquet helper from the replay source family", async context => {
  const fixture = await boundaryFixture(context);
  const file = "dist/assets/monitor.js.map";
  await fixture.write(file, JSON.stringify({ sources: ["../../src/dataset-replay-zstd.ts"] }));
  const accepted = fixture.run();
  assert.equal(accepted.status, 0, accepted.stderr);
  await fixture.write(file, JSON.stringify({ sources: ["../../src/dataset-replay-app.ts"] }));
  const rejected = fixture.run();
  assert.notEqual(rejected.status, 0);
  assert.ok(rejected.stderr.includes(`Excluded source map entry: ${file}`), rejected.stderr);
});

test("export manifests cannot classify native build products as public source", async context => {
  const fixture = await boundaryFixture(context);
  const file = "native/viewer/build-native/CMakeCache.txt";
  const content = "Local build output.\n";
  await fixture.write(file, content);
  const files = { [file]: { sha256: createHash("sha256").update(content).digest("hex") } };
  await fixture.write("EXPORT-MANIFEST.json", JSON.stringify({
    version: 2, files, treeDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  }));
  const rejected = fixture.run();
  assert.notEqual(rejected.status, 0);
  assert.ok(rejected.stderr.includes(`Excluded export source: ${file}`), rejected.stderr);
});

test("credentials in native source and build scripts are rejected", async context => {
  const fixture = await boundaryFixture(context);
  const token = "ghp_" + "a".repeat(36);
  for (const name of ["main.c", "main.cc", "main.cpp", "main.cxx", "kernel.cu", "kernel.cuh", "types.h", "types.hh", "types.hpp", "types.hxx", "main.rs", "build.cmake", "config.hpp.in", "verify.py", "package.ps1", "module.psm1", "package.sh", "package.bash", "build.cmd", "build.bat", "Cargo.lock"]) {
    const file = `native/viewer/${name}`;
    await fixture.write(file, token);
    const rejected = fixture.run();
    assert.notEqual(rejected.status, 0, file);
    assert.ok(rejected.stderr.includes(`Credential material: ${file}`), rejected.stderr);
    await fixture.remove(file);
  }
});

test("local edits build independently while release verification rejects source drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ceres-boundary-"));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  try {
    await mkdir(path.join(root, "scripts"));
    await copyFile(new URL("../scripts/check-public-boundary.mjs", import.meta.url), path.join(root, "scripts/check-public-boundary.mjs"));
    await writeFile(path.join(root, "package-lock.json"), '{"packages":{}}');
    const files = { "core.ts": { sha256: createHash("sha256").update("original").digest("hex") } };
    await writeFile(path.join(root, "EXPORT-MANIFEST.json"), JSON.stringify({
      version: 2, files, treeDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    }));
    await writeFile(path.join(root, "core.ts"), "export const revised = true;\n");
    const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/check-public-boundary.mjs", ...args], { cwd: root, encoding: "utf8" });
    const local = run();
    assert.equal(local.status, 0, local.stderr);
    const release = run("--verify-export");
    assert.notEqual(release.status, 0);
    assert.match(release.stderr, /Source differs from export manifest: core\.ts/);
    await mkdir(path.join(root, "infrastructure"));
    await writeFile(path.join(root, "infrastructure/private.ts"), "export const hosted = true;\n");
    const excluded = run();
    assert.notEqual(excluded.status, 0);
    assert.match(excluded.stderr, /Excluded source: infrastructure\/private\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
