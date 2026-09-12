import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 45_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:14318",
    browserName: "chromium",
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
    permissions: ["camera", "microphone"],
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "node dist-server/ceres-server.cjs",
    url: "http://127.0.0.1:14318/api/health",
    env: { PORT: "14318", CERES_BIND_HOST: "127.0.0.1", CERES_DATA_DIR: "test-results/server-data", CERES_SPEECH_ENABLED: "0" },
    reuseExistingServer: false,
  },
});
