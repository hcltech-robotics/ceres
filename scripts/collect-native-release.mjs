import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateIdentity } from "./publish-public-release.mjs";

export const platforms = ["windows-x64", "linux-x64", "linux-arm64"];
async function fileHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
const json = async filename => JSON.parse(await readFile(filename, "utf8"));

export async function collectNativePackages({ input, output, version, revision }) {
  validateIdentity({ tag: `v${version}`, revision, version });
  const prefix = `ceres-native-${revision}-`;
  const directories = await readdir(input);
  if (directories.length !== platforms.length || platforms.some(platform => !directories.includes(`${prefix}${platform}`))) {
    throw new Error("Release requires exactly the three native package artefacts from its source revision");
  }
  const copies = [];
  const packages = [];
  for (const platform of platforms) {
    const directory = path.join(input, `${prefix}${platform}`);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Native artefact must be an ordinary directory");
    const base = `ceres-viewer-${version}-${platform}`;
    const archive = `${base}.${platform === "windows-x64" ? "zip" : "tar.gz"}`;
    const names = [archive, `${archive}.sha256`, `${archive}.manifest.json`, `${archive}.spdx.json`, `${base}.verification.json`, "workflow-inputs.json"];
    const actual = await readdir(directory);
    if (actual.length !== names.length || names.some(name => !actual.includes(name))) throw new Error(`Native package inventory differs: ${platform}`);
    for (const name of names) {
      const stat = await lstat(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Native package contains a non-regular file: ${name}`);
    }
    const sha256 = await fileHash(path.join(directory, archive));
    if ((await readFile(path.join(directory, `${archive}.sha256`), "utf8")).trim() !== `${sha256}  ${archive}`) {
      throw new Error(`Native archive checksum differs: ${platform}`);
    }
    const manifest = await json(path.join(directory, `${archive}.manifest.json`));
    const verification = await json(path.join(directory, `${base}.verification.json`));
    const inputs = await json(path.join(directory, "workflow-inputs.json"));
    for (const [label, document, schema] of [
      ["manifest", manifest, "ceres-viewer-package"],
      ["verification", verification, "ceres-viewer-package-verification"],
      ["build inputs", inputs, "ceres-native-build-inputs"],
    ]) {
      if (document.schema !== schema || document.version !== 1 || document.platform !== platform
        || document.release_version !== version || document.source_revision !== revision) {
        throw new Error(`Native ${label} identity differs: ${platform}`);
      }
    }
    if (verification.passed !== true || verification.archive_sha256 !== sha256) throw new Error(`Native package has no matching successful verification: ${platform}`);
    const sbom = await json(path.join(directory, `${archive}.spdx.json`));
    if (sbom.spdxVersion !== "SPDX-2.3" || sbom.SPDXID !== "SPDXRef-DOCUMENT" || !Array.isArray(sbom.packages) || !sbom.packages.length) {
      throw new Error(`Native SPDX inventory is missing: ${platform}`);
    }
    for (const name of names) copies.push({ source: path.join(directory, name), name: name === "workflow-inputs.json" ? `${base}.inputs.json` : name });
    packages.push({ platform, archive, sha256, manifest: `${archive}.manifest.json`, sbom: `${archive}.spdx.json`, verification: `${base}.verification.json`, build_inputs: `${base}.inputs.json` });
  }
  // All source identities and hashes are checked before the release directory changes.
  await mkdir(output, { recursive: true });
  const existing = new Set(await readdir(output));
  if (copies.some(file => existing.has(file.name)) || existing.has("native-packages.json")) throw new Error("Native release files already exist");
  for (const file of copies) await copyFile(file.source, path.join(output, file.name));
  const result = { schema: "ceres-native-release", version: 1, release_version: version, source_revision: revision, packages };
  await writeFile(path.join(output, "native-packages.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  const result = await collectNativePackages({ input: process.argv[2] ?? "native-artifacts", output: process.argv[3] ?? "release", version, revision: process.env.GITHUB_SHA });
  console.log(`Collected ${result.packages.length} native downloads for CERES ${version}`);
}
