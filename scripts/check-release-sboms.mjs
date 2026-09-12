import { readFileSync } from "node:fs";

const directory = process.argv[2] ?? "release";
for (const [file, required] of [
  ["ceres-source.spdx.json", ["pkg:npm/express@", "pkg:cargo/parquet@", "pkg:pypi/aiohttp@", "pkg:pypi/foxglove-sdk@"]],
  ["ceres-container.spdx.json", ["pkg:npm/express@", "pkg:cargo/parquet@"]],
]) {
  const bytes = readFileSync(`${directory}/${file}`);
  if (bytes.length > 16 * 1024 * 1024) throw new Error(`${file} exceeds the attestation size limit`);
  const packages = JSON.parse(bytes).packages ?? [];
  const identifiers = packages.flatMap(item => (item.externalRefs ?? []).map(ref => ref.referenceLocator));
  for (const prefix of required) {
    if (!identifiers.some(identifier => identifier.startsWith(prefix))) throw new Error(`Missing ${prefix} in ${file}`);
  }
  for (const item of packages) {
    if (/posthog|@clerk\/|@opentelemetry\/|@vercel\/otel/iu.test(item.name)) throw new Error(`Excluded package in ${file}: ${item.name}`);
  }
  console.log(`${file}: ${packages.length} packages with all required dependency families`);
}
