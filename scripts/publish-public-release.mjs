import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "hcltech-robotics/ceres";
export const proofFile = name => name.endsWith(".sigstore.json") || name === "SHA256SUMS.sig";

export function validateIdentity({ tag, revision, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || tag !== `v${version}`) {
    throw new Error("Release tag must match the package version");
  }
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Release revision must be a full commit");
}

export function validateChecksums(files) {
  const manifest = files.find(file => file.name === "SHA256SUMS");
  if (!manifest) throw new Error("Release checksums are missing");
  const entries = new Map();
  for (const line of manifest.bytes.toString("utf8").trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error("Invalid or duplicate release checksum");
    entries.set(match[2], match[1]);
  }
  const expected = files.filter(file => file.name !== "SHA256SUMS" && !proofFile(file.name));
  if (entries.size !== expected.length) throw new Error("Release checksum inventory differs");
  for (const file of expected) {
    if (entries.get(file.name) !== file.sha256) throw new Error(`Release checksum differs: ${file.name}`);
  }
}

export async function preflightRelease({ api, tag, revision, version, files }) {
  validateIdentity({ tag, revision, version });
  await api.verifyTag(tag, revision);
  const release = await api.findRelease(tag);
  if (!release) return { published: false };
  if (release.tag_name !== tag || (release.draft && release.target_commitish !== revision)) {
    throw new Error("Existing release targets a different source revision");
  }
  if (release.draft) return { published: false };
  const assets = await api.listAssets(release.id);
  // The qualification job's checksum file covers only its own outputs. The final
  // combined manifest and signatures are verified by the release publisher.
  for (const file of files.filter(item => item.name !== "SHA256SUMS" && !proofFile(item.name))) {
    const asset = assets.find(item => item.name === file.name);
    if (!asset || await api.assetDigest(asset) !== file.sha256) throw new Error(`Published release payload differs: ${file.name}`);
  }
  return { published: true };
}

// The checksum manifest is the draft's immutable payload identity. Only proofs
// generated after that manifest may be refreshed when a failed signing job resumes.
export async function publishRelease({ api, tag, revision, version, notes, files }) {
  validateIdentity({ tag, revision, version });
  if (!files.length || new Set(files.map(file => file.name)).size !== files.length
    || files.some(file => !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(file.name))) {
    throw new Error("Release asset names must be unique regular filenames");
  }
  validateChecksums(files);
  await api.verifyTag(tag, revision);
  let release = await api.findRelease(tag);
  if (!release) release = await api.createDraft({ tag, revision, version, notes });
  if (release.tag_name !== tag || (release.draft && release.target_commitish !== revision)) {
    throw new Error("Existing release targets a different source revision");
  }
  let assets = await api.listAssets(release.id);
  const byName = new Map(assets.map(asset => [asset.name, asset]));
  if (byName.size !== assets.length || assets.some(asset => !files.some(file => file.name === asset.name))) {
    throw new Error("Existing release contains an unexpected or duplicate asset");
  }
  const manifest = files.find(file => file.name === "SHA256SUMS");
  if (assets.length && !byName.has("SHA256SUMS")) throw new Error("Existing draft has no payload identity");
  if (byName.has("SHA256SUMS") && await api.assetDigest(byName.get("SHA256SUMS")) !== manifest.sha256) {
    throw new Error("Existing release has different qualified payloads");
  }
  const uploads = [];
  const replacements = [];
  // Validate every existing payload before changing any draft asset.
  for (const file of files) {
    const existing = byName.get(file.name);
    if (!existing) {
      if (!release.draft) throw new Error(`Published release is missing ${file.name}`);
      uploads.push(file);
      continue;
    }
    if (await api.assetDigest(existing) === file.sha256) continue;
    if (!proofFile(file.name)) throw new Error(`Existing release asset differs: ${file.name}`);
    if (release.draft) replacements.push({ existing, file });
  }
  if (!release.draft) return { status: "already-published", tag, assets: assets.length };
  uploads.sort((left, right) => Number(right.name === "SHA256SUMS") - Number(left.name === "SHA256SUMS")
    || left.name.localeCompare(right.name));
  for (const file of uploads) await api.uploadAsset(release.id, file);
  for (const { existing, file } of replacements) {
    await api.deleteAsset(existing.id);
    await api.uploadAsset(release.id, file);
  }
  assets = await api.listAssets(release.id);
  if (assets.length !== files.length || new Set(assets.map(asset => asset.name)).size !== files.length) {
    throw new Error("Uploaded release inventory differs");
  }
  for (const file of files) {
    const asset = assets.find(item => item.name === file.name);
    if (!asset || asset.state !== "uploaded" || await api.assetDigest(asset) !== file.sha256) {
      throw new Error(`Uploaded release asset failed verification: ${file.name}`);
    }
  }
  await api.publishDraft(release.id);
  return { status: "published", tag, assets: assets.length };
}

export function githubApi(token, fetcher = fetch) {
  if (!token) throw new Error("GH_TOKEN is required");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const base = `https://api.github.com/repos/${repository}`;
  async function request(endpoint, options = {}, missing = false) {
    const response = await fetcher(`${base}${endpoint}`, { ...options, headers: { ...headers, ...options.headers } });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub release request failed with HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  return {
    async verifyTag(tag, revision) {
      const reference = await request(`/git/ref/tags/${encodeURIComponent(tag)}`);
      let object = reference.object;
      for (let depth = 0; object?.type === "tag" && depth < 5; depth++) object = (await request(`/git/tags/${object.sha}`)).object;
      if (object?.type !== "commit" || object.sha !== revision) throw new Error("Published tag differs from the qualified revision");
      const comparison = await request(`/compare/${revision}...main`);
      if (comparison.merge_base_commit?.sha !== revision) throw new Error("Release revision is not on public main");
    },
    findRelease: tag => request(`/releases/tags/${encodeURIComponent(tag)}`, {}, true),
    createDraft: ({ tag, revision, version, notes }) => request("/releases", {
      method: "POST", body: JSON.stringify({ tag_name: tag, target_commitish: revision, name: `CERES ${version}`, body: notes, draft: true, prerelease: version.includes("-") }),
    }),
    async listAssets(id) {
      const assets = [];
      for (let page = 1; ; page++) {
        const current = await request(`/releases/${id}/assets?per_page=100&page=${page}`);
        assets.push(...current);
        if (current.length < 100) return assets;
      }
    },
    async assetDigest(asset) {
      if (/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) return asset.digest.slice(7);
      const response = await fetcher(`${base}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: "application/octet-stream" } });
      if (!response.ok) throw new Error(`Release asset download failed with HTTP ${response.status}`);
      const hash = createHash("sha256");
      for await (const chunk of response.body) hash.update(chunk);
      return hash.digest("hex");
    },
    async uploadAsset(id, file) {
      const size = file.bytes?.length ?? (await lstat(file.path)).size;
      const response = await fetcher(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
        body: file.bytes ?? createReadStream(file.path), duplex: "half",
      });
      if (!response.ok) throw new Error(`Release asset upload failed with HTTP ${response.status}: ${file.name}`);
      return response.json();
    },
    deleteAsset: id => request(`/releases/assets/${id}`, { method: "DELETE" }),
    publishDraft: id => request(`/releases/${id}`, { method: "PATCH", body: JSON.stringify({ draft: false }) }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_REPOSITORY !== repository) throw new Error("Only the public CERES repository publishes downloads");
  const directory = path.resolve(process.argv[2] ?? "release");
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release asset is not a regular file: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    files.push({ name, path: filename, sha256: hash.digest("hex"), ...(name === "SHA256SUMS" ? { bytes: await readFile(filename) } : {}) });
  }
  const options = { api: githubApi(process.env.GH_TOKEN), files, version, tag: process.env.GITHUB_REF_NAME, revision: process.env.GITHUB_SHA };
  if (process.argv.includes("--preflight")) {
    const result = await preflightRelease(options);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${result.published}\n`);
    console.log(result.published ? "Existing published payloads match the qualified artefacts" : "Release is ready for draft assembly");
  } else {
    const result = await publishRelease({ ...options, notes: await readFile("RELEASE.md", "utf8") });
    console.log(`Release ${result.tag}: ${result.status}, ${result.assets} verified assets`);
  }
}
