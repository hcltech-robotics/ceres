import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "node_modules", "@ffmpeg", "core", "dist", "esm");
const destinationRoot = path.join(projectRoot, "public", "vendor", "ffmpeg-core");
const legacyDestinationRoot = path.join(projectRoot, "public", "vendor", "ffmpeg-core-mt");
const requiredFiles = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

rmSync(destinationRoot, { force: true, recursive: true });
rmSync(legacyDestinationRoot, { force: true, recursive: true });
mkdirSync(destinationRoot, { recursive: true });
let totalBytes = 0;
for (const file of requiredFiles) {
  const source = path.join(sourceRoot, file);
  const destination = path.join(destinationRoot, file);
  const sourceStats = statSync(source, { throwIfNoEntry: false });
  if (!sourceStats?.isFile()) throw new Error(`Missing ffmpeg.wasm single-thread asset: ${source}`);
  copyFileSync(source, destination);
  totalBytes += sourceStats.size;
}

console.log(`Prepared ffmpeg.wasm single-thread monitor assets: ${totalBytes} bytes`);
