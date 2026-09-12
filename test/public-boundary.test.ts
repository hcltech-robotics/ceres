import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
