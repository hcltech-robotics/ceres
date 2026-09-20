import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const usage = "Usage: node scripts/prepare-voice-models.mjs [--check] [--directory DIRECTORY]";
const preparationHint = "Run npm run models:prepare to prepare the local voice model files.";

export function validateVoiceModelManifest(manifest) {
  if (!manifest || typeof manifest !== "object"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.modelId ?? "")
    || !/^[a-f0-9]{40}$/.test(manifest.revision ?? "")
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Invalid local voice model manifest identity or file list");
  }
  const paths = new Set();
  for (const file of manifest.files) {
    const parts = typeof file?.path === "string" ? file.path.split("/") : [];
    if (parts.length === 0 || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") || paths.has(file.path.toLowerCase())) {
      throw new Error("Invalid or duplicate file in local voice model manifest");
    }
    paths.add(file.path.toLowerCase());
  }
  return manifest;
}

export async function readVoiceModelManifest(root = projectRoot) {
  return validateVoiceModelManifest(JSON.parse(await readFile(path.join(root, "shared/local-voice-model.json"), "utf8")));
}

async function requireOrdinaryParents(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    const stat = await lstat(current).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (stat?.isSymbolicLink()) throw new Error(`Local voice model path cannot traverse a link: ${current}`);
    if (path.dirname(current) === current) break;
  }
}

async function inspectFile(filename, expected) {
  await requireOrdinaryParents(filename);
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return "not a regular file";
    if (stat.size !== expected.bytes) return `expected ${expected.bytes} bytes, found ${stat.size}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex") === expected.sha256 ? null : "SHA-256 mismatch";
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing";
    throw error;
  }
}

export async function verifyVoiceModels({ directory, manifest }) {
  validateVoiceModelManifest(manifest);
  const results = [];
  for (const file of manifest.files) {
    const reason = await inspectFile(path.join(directory, manifest.modelId, file.path), file);
    results.push({ path: file.path, valid: reason === null, reason });
  }
  return results;
}

async function downloadFile({ filename, file, manifest, fetcher }) {
  const url = `https://huggingface.co/${manifest.modelId}/resolve/${manifest.revision}/${file.path}`;
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let response;
  try {
    await requireOrdinaryParents(filename);
    response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
    if (response.status !== 200 || !response.body) {
      throw new Error(`Download returned HTTP ${response.status}`);
    }
    await requireOrdinaryParents(filename);
    await mkdir(path.dirname(filename), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > file.bytes) {
          callback(new Error(`Size mismatch: expected ${file.bytes} bytes, received more`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const temporaryFile = await open(temporary, "wx");
    temporaryCreated = true;
    await pipeline(Readable.fromWeb(response.body), verifier, temporaryFile.createWriteStream());
    if (bytes !== file.bytes) throw new Error(`Size mismatch: expected ${file.bytes} bytes, received ${bytes}`);
    if (hash.digest("hex") !== file.sha256) throw new Error("SHA-256 mismatch");
    await requireOrdinaryParents(filename);
    await rename(temporary, filename);
  } catch (error) {
    throw new Error(`Could not prepare ${file.path}: ${error.message}. Check the connection and rerun npm run models:prepare.`, { cause: error });
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    if (temporaryCreated) await rm(temporary, { force: true });
  }
}

export async function prepareVoiceModels({
  directory = path.join(projectRoot, "public/models"),
  manifest,
  check = false,
  fetcher = globalThis.fetch,
  log = () => {},
}) {
  const results = await verifyVoiceModels({ directory, manifest });
  const invalid = results.filter(file => !file.valid);
  if (check && invalid.length > 0) {
    throw new Error(`Local voice model files are missing or invalid:\n${invalid.map(file => `- ${file.path}: ${file.reason}`).join("\n")}\n${preparationHint}`);
  }
  let downloaded = 0;
  if (!check) {
    for (const result of invalid) {
      const file = manifest.files.find(entry => entry.path === result.path);
      log(`Preparing local voice model: ${file.path} (${file.bytes} bytes)`);
      await downloadFile({ filename: path.join(directory, manifest.modelId, file.path), file, manifest, fetcher });
      downloaded += 1;
    }
  }
  return {
    modelId: manifest.modelId,
    revision: manifest.revision,
    directory,
    downloaded,
    reused: manifest.files.length - downloaded,
    bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
  };
}

export function parseVoiceModelArguments(args, root = projectRoot) {
  let directory = "public/models";
  let directoryProvided = false;
  let check = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") check = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--directory" && !directoryProvided && args[index + 1] && !args[index + 1].startsWith("-")) {
      directory = args[++index];
      directoryProvided = true;
    } else {
      throw new Error(`Invalid argument: ${argument}\n${usage}`);
    }
  }
  return { directory: path.resolve(root, directory), check, help };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseVoiceModelArguments(args);
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await prepareVoiceModels({ ...options, manifest: await readVoiceModelManifest(), log: console.log });
  console.log(`Local voice model verified: ${result.downloaded} downloaded, ${result.reused} reused (${result.bytes} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
