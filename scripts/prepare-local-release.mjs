import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { platforms } from "./collect-native-release.mjs";
import { proofFile, validateChecksums, validateIdentity } from "./publish-public-release.mjs";

const repository = "hcltech-robotics/ceres";
const namespace = "ceres-release";
const keyText = text => text.trim().split(/\s+/).slice(0, 2).join(" ");
const json = async filename => JSON.parse(await readFile(filename, "utf8"));

export async function releaseFiles(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid release filename: ${name}`);
    const filename = path.join(directory, name);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release asset is not a regular file: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    files.push({ name, path: filename, sha256: hash.digest("hex"), ...(name === "SHA256SUMS" ? { bytes: await readFile(filename) } : {}) });
  }
  return files;
}

export async function githubKeys(signer, fetcher = fetch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(signer)) throw new Error("Invalid GitHub signer account");
  const response = await fetcher(`https://api.github.com/users/${signer}/keys`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub signer key lookup failed with HTTP ${response.status}`);
  return (await response.json()).map(item => keyText(item.key));
}

function ssh(args, input, executable = "ssh-keygen") {
  const result = spawnSync(executable, args, { input, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`SSH release signature failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

export async function validateLocalPayload(directory, version, revision) {
  validateIdentity({ version, revision, tag: `v${version}` });
  const files = await releaseFiles(directory);
  const names = new Set(files.map(file => file.name));
  for (const name of [`ceres-${version}-source.tar.gz`, `ceres-${version}-runtime.tar.gz`, "ceres-container.tar.gz",
    "ceres-source.spdx.json", "ceres-container.spdx.json", "python-environment.json", "native-packages.json", "native-hardware-qualification.json"]) {
    if (!names.has(name)) throw new Error(`Required release asset is missing: ${name}`);
  }
  if (![...names].some(name => /^ceres_bridge-[0-9].*\.whl$/.test(name))
    || ![...names].some(name => /^ceres_bridge-[0-9].*\.tar\.gz$/.test(name))) throw new Error("Python receiver wheel and source distribution are required");
  const native = await json(path.join(directory, "native-packages.json"));
  if (native.schema !== "ceres-native-release" || native.version !== 1 || native.release_version !== version || native.source_revision !== revision
    || native.packages.length !== platforms.length || new Set(native.packages.map(item => item.platform)).size !== platforms.length) {
    throw new Error("Native release identity differs");
  }
  const hardware = await json(path.join(directory, "native-hardware-qualification.json"));
  if (hardware.status !== "passed") throw new Error("NVIDIA hardware qualification has not passed");
  for (const platform of platforms) {
    const entry = native.packages.find(item => item.platform === platform);
    if (!entry) throw new Error(`Native platform is missing: ${platform}`);
    const archive = files.find(file => file.name === entry.archive);
    if (!archive || archive.sha256 !== entry.sha256 || hardware.platforms?.[platform]?.archive_sha256 !== archive.sha256) {
      throw new Error(`Native archive or hardware qualification differs: ${platform}`);
    }
    for (const property of ["manifest", "sbom", "verification", "build_inputs"]) {
      if (!names.has(entry[property])) throw new Error(`Native ${property} is missing: ${platform}`);
    }
  }
  return files;
}

export async function verifyLocalRelease({ directory, signer, keys = githubKeys, sshExecutable }) {
  const provenance = await json(path.join(directory, "local-release-provenance.json"));
  if (provenance.schema !== "ceres-local-release-provenance" || provenance.version !== 1 || provenance.repository !== repository
    || provenance.signer !== signer || provenance.ssh_namespace !== namespace) throw new Error("Local release signing identity differs");
  const publicKey = keyText(await readFile(path.join(directory, "release-signing-key.pub"), "utf8"));
  if (!(await keys(signer)).includes(publicKey)) throw new Error("Release signing key does not belong to the expected GitHub account");
  const temporary = await mkdtemp(path.join(tmpdir(), "ceres-release-signature-"));
  try {
    const allowed = path.join(temporary, "allowed-signers");
    await writeFile(allowed, `github.com/${signer} namespaces="${namespace}" ${publicKey}\n`);
    ssh(["-Y", "verify", "-f", allowed, "-I", `github.com/${signer}`, "-n", namespace, "-s", path.join(directory, "SHA256SUMS.sig")],
      await readFile(path.join(directory, "SHA256SUMS")), sshExecutable);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const files = await validateLocalPayload(directory, provenance.release_version, provenance.source_revision);
  validateChecksums(files);
  return { status: "verified", signer, source_revision: provenance.source_revision, assets: files.length };
}

export async function prepareLocalRelease({ directory, version, revision, signer, signingKey, keys = githubKeys, sshExecutable }) {
  const files = await validateLocalPayload(directory, version, revision);
  const publicKey = keyText(await readFile(`${signingKey}.pub`, "utf8"));
  if (!(await keys(signer)).includes(publicKey)) throw new Error("Signing key does not belong to the expected GitHub account");
  const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(publicKey.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "")}`;
  const provenance = {
    schema: "ceres-local-release-provenance", version: 1, repository, release_version: version, source_revision: revision,
    assembly: "maintainer-local", signer, key_source: `https://api.github.com/users/${signer}/keys`,
    key_fingerprint: fingerprint, ssh_namespace: namespace,
  };
  const publicKeyPath = path.join(directory, "release-signing-key.pub");
  const provenancePath = path.join(directory, "local-release-provenance.json");
  if (files.some(file => file.name === "local-release-provenance.json")
    && JSON.stringify(await json(provenancePath)) !== JSON.stringify(provenance)) throw new Error("Existing local signing provenance differs");
  if (files.some(file => file.name === "release-signing-key.pub")
    && keyText(await readFile(publicKeyPath, "utf8")) !== publicKey) throw new Error("Existing release signing key differs");
  if (files.some(file => file.name === "SHA256SUMS.sig")) return verifyLocalRelease({ directory, signer, keys, sshExecutable });
  if (!files.some(file => file.name === "release-signing-key.pub")) await writeFile(publicKeyPath, `${publicKey}\n`, { flag: "wx" });
  if (!files.some(file => file.name === "local-release-provenance.json")) await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
  const payloads = (await releaseFiles(directory)).filter(file => file.name !== "SHA256SUMS" && !proofFile(file.name));
  await writeFile(path.join(directory, "SHA256SUMS"), payloads.map(file => `${file.sha256}  ${file.name}\n`).join(""));
  ssh(["-Y", "sign", "-f", signingKey, "-n", namespace, path.join(directory, "SHA256SUMS")], undefined, sshExecutable);
  return verifyLocalRelease({ directory, signer, keys, sshExecutable });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination, ...args] = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!["prepare", "verify"].includes(command) || !destination || !args.includes("--signer")) {
    throw new Error("Usage: prepare-local-release.mjs prepare|verify DIRECTORY --signer ACCOUNT [--signing-key PRIVATE_KEY]");
  }
  const common = { directory: path.resolve(destination), signer: option("--signer"), sshExecutable: process.env.CERES_SSH_KEYGEN };
  const result = command === "verify" ? await verifyLocalRelease(common) : await prepareLocalRelease({
    ...common, version: JSON.parse(await readFile("package.json", "utf8")).version, revision: process.env.GITHUB_SHA,
    signingKey: args.includes("--signing-key") ? path.resolve(option("--signing-key")) : (() => { throw new Error("--signing-key is required"); })(),
  });
  console.log(`Local release ${result.status}: ${result.assets} assets signed by ${result.signer}`);
}
