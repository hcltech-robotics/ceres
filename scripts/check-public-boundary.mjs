import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const verifyExport = process.argv.includes("--verify-export");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const excluded = /(?:^|\/)(?:infrastructure|documentation|user-facing-documentation|AGENTS\.md|\.vercel|\.wrangler|\.env(?:\..*)?)(?:\/|$)|(?:^|\/)(?:hosted-|account-export-client|account-upload-receipt|account-identity|browser-observability|browser-journeys|client-diagnostics|recording-workflow-observability|javascript-error-telemetry|posthog|site-navigation|user-documentation|arrival-app|dataset-replay)/i;
const viewerDocument = /^native\/viewer\/docs\/[A-Za-z0-9_-]+\.md$/;
const nativeGenerated = /^native\/(?:viewer|lerobot-exporter)\/(?:build[^/]*|cmake-build[^/]*|out|stage|deps|target|artifacts|release|\.cache|\.venv)(?:\/|$)/i;
const nativePrivate = /^native\/viewer\/(?:assets\/(?:local|mano)(?:\/|$)|import-provenance\.json$)|^native\/.*\.(?:mcap(?:\.partial)?|cmap(?:\.pending)?|pkl|npz|npy)$/i;
const privateNativeQualification = /^\.github\/(?:workflows\/native-viewer-hardware\.yml|scripts\/run-native-qualification\.py)$/i;
const isExcludedPath = file => (file !== "src/dataset-replay-zstd.ts" && excluded.test(file))
  || (file !== "native/lerobot-exporter/build.rs" && nativeGenerated.test(file)) || nativePrivate.test(file)
  || privateNativeQualification.test(file)
  || (/(?:^|\/)docs(?:\/|$)/i.test(file) && !viewerDocument.test(file))
  || /\.(?:pem|key|pfx|p12|pyc|har)$/i.test(file);
const forbiddenImports = /(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:posthog|hosted-|account-export-client|account-upload-receipt|browser-observability|javascript-error-telemetry)[^"']*["']/;
const forbiddenDependencies = /posthog|@vercel\/blob|@clerk\//i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|sk_live_[A-Za-z0-9]{20,})\b/;
const skip = new Set([".git", ".venv", "node_modules", "target", "pkg-scalar", "pkg-simd", "__pycache__", ".pytest_cache", "test-results", "playwright-report", "release", "data"]);
function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if ((skip.has(entry.name) && (entry.name !== "data" || prefix === "")) || entry.name.endsWith(".egg-info") || (prefix === "receiver" && entry.name === "build")) return [];
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Source contains a symbolic link: ${file}`);
    if (entry.isDirectory() && /^native\/(?:viewer|lerobot-exporter)\/(?:build[^/]*|cmake-build[^/]*)(?:\/|$)/i.test(file)) return [];
    return entry.isDirectory() ? files(path.join(directory, entry.name), file) : [file];
  });
}
const problems = [];
const inventory = files(root);
for (const file of inventory) {
  if (isExcludedPath(file)) problems.push(`Excluded source: ${file}`);
  if (!/\.(?:ts|js|mjs|cjs|json|map|html|css|yml|yaml|toml|md|cff|bib|txt|c|cc|cpp|cxx|cu|h|hh|hpp|hxx|cuh|rs|cmake|in|py|ps1|psm1|sh|bash|cmd|bat|lock)$/i.test(file)) continue;
  const content = readFileSync(path.join(root, file), "utf8");
  if (secret.test(content)) problems.push(`Credential material: ${file}`);
  if (file !== "scripts/check-public-boundary.mjs" && forbiddenImports.test(content)) problems.push(`Excluded import: ${file}`);
  if (file.endsWith(".map")) {
    const map = JSON.parse(content);
    for (const source of map.sources ?? []) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), source));
      const publicHelper = /^dist\/assets\/[^/]+\.map$/.test(file) && source === "../src/dataset-replay-zstd.ts";
      if (!publicHelper && isExcludedPath(source) && isExcludedPath(resolved)) problems.push(`Excluded source map entry: ${file}`);
    }
  }
}
const lock = JSON.parse(readFileSync(path.join(root,"package-lock.json"),"utf8"));
for (const name of Object.keys(lock.packages)) if (forbiddenDependencies.test(name)) problems.push(`Excluded dependency: ${name}`);
const manifestPath = path.join(root,"EXPORT-MANIFEST.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath,"utf8"));
  if (manifest.version !== 2 || hash(Buffer.from(JSON.stringify(manifest.files))) !== manifest.treeDigest) problems.push("Invalid export manifest");
  for (const [file, expected] of Object.entries(manifest.files ?? {})) {
    if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").includes("..")) throw new Error("Unsafe manifest path");
    if (isExcludedPath(file)) problems.push(`Excluded export source: ${file}`);
    const absolute = path.join(root,file);
    if (verifyExport && (!existsSync(absolute) || !lstatSync(absolute).isFile() || hash(readFileSync(absolute)) !== expected.sha256)) problems.push(`Source differs from export manifest: ${file}`);
    if (verifyExport && process.platform !== "win32" && expected.mode && existsSync(absolute)
      && ((lstatSync(absolute).mode & 0o111) ? "100755" : "100644") !== expected.mode) problems.push(`File mode differs from export manifest: ${file}`);
  }
  const generated = /^(?:dist\/|dist-server\/|third-party\/|public\/(?:wasm|ui|vendor)\/)/;
  for (const file of inventory) if (verifyExport && !["EXPORT-MANIFEST.json", "SOURCE.json"].includes(file) && !generated.test(file) && !manifest.files[file]) problems.push(`Unclassified public source: ${file}`);
} else if (verifyExport) problems.push("Export manifest is required for release verification");
if (problems.length) throw new Error([...new Set(problems)].join("\n"));
console.log(`Public source boundary passed for ${inventory.length} files`);
