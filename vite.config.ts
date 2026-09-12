import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";

const metadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const sourceIdentity = new URL("./SOURCE.json", import.meta.url);
const commit = process.env.CERES_BUILD_COMMIT ?? process.env.GITHUB_SHA
  ?? (existsSync(sourceIdentity) ? JSON.parse(readFileSync(sourceIdentity,"utf8")).commit : null);
const identity = {
  version: metadata.version, codename: metadata.releaseCodename,
  branch: null, commit, shortCommit: commit?.slice(0, 7) ?? null,
  channel: "release", display: metadata.version,
};
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const https = process.env.CERT_FILE && process.env.KEY_FILE
  ? { cert: readFileSync(process.env.CERT_FILE), key: readFileSync(process.env.KEY_FILE) } : undefined;

export default defineConfig({
  define: {
    __CERES_ALLOW_REMOTE_MODELS__: "false",
    __CERES_CAPTURE_BASE_URL__: JSON.stringify(""),
    __CERES_RELAY_URL__: JSON.stringify(""),
    __CERES_DEPLOYMENT_TARGET__: JSON.stringify("download"),
    __CERES_BROWSER_TESTS__: "false",
    __CERES_TEST_HEADLESS_RENDERING__: "false",
    __CERES_TEST_RECORDER_RATE_HZ__: "null",
    __CERES_BUILD_IDENTITY__: JSON.stringify(identity),
    __CERES_VERSION__: JSON.stringify(metadata.version),
  },
  plugins: [compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: false })],
  server: {
    host: "127.0.0.1", port: 8081, headers: isolationHeaders, https,
    proxy: Object.fromEntries(["/api", "/ws", "/invite-signal", "/j"].map(route => [route, {
      target: `${https ? "https" : "http"}://127.0.0.1:4317`, ws: true,
    }])),
  },
  build: {
    target: "esnext", manifest: true, sourcemap: true,
    rollupOptions: {
      input: Object.fromEntries(["index.html", "monitor/index.html", "launch/capture/index.html", "bridge/index.html"].map(file => [file, fileURLToPath(new URL(file, import.meta.url))])),
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@babylonjs/havok", "@ffmpeg/ffmpeg"] },
});
