import { expect, test } from "@playwright/test";

for (const [name, route] of [["director", "/monitor/"], ["Solo", "/launch/capture/?mode=solo"], ["capture", "/launch/capture/"], ["Bridge", "/bridge/"]]) {
  test(`${name} starts with local assets and no external connections`, async ({ page, context, baseURL }) => {
    const external: string[] = [];
    const failures: string[] = [];
    page.on("pageerror", error => failures.push(error.message));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (!["data:", "blob:"].includes(url.protocol) && url.origin !== baseURL) {
        external.push(url.origin);
        await route.abort();
      } else await route.continue();
    });
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url());
      if (url.host !== new URL(baseURL!).host) { external.push(url.origin); socket.close(); }
      else socket.connectToServer();
    });
    await context.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection;
      const settings: RTCConfiguration[] = [];
      Object.assign(window, { __ceresIceSettings: settings });
      window.RTCPeerConnection = class extends NativePeer {
        constructor(configuration?: RTCConfiguration) {
          settings.push(configuration ?? {});
          super(configuration);
        }
      };
    });
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
    await expect(page.locator("#app")).not.toBeEmpty();
    await expect(page.locator("#app")).not.toContainText("failed to load", { ignoreCase: true });
    if (name === "director") {
      await page.getByRole("button", { name: "Roll a fresh local invitation" }).click();
      await expect(page.locator("#pairing-invitation-link")).toHaveValue(/\/j\/[A-Z2-9]{8}$/);
      const link = await page.locator("#pairing-invitation-link").inputValue();
      expect(new URL(link).origin).toBe(baseURL);
      const demonstrator = await context.newPage();
      demonstrator.on("pageerror", error => failures.push(error.message));
      await demonstrator.goto(link);
      await expect(demonstrator).toHaveURL(/\/launch\/capture\//);
      await expect(demonstrator.locator(".site-header")).toBeVisible();
      await expect(page.locator("#hf-account-action")).toBeHidden();
    } else {
      await expect(page.locator(".site-header, .capture-shell, .solo-shell, .bridge-shell").first()).toBeVisible();
    }
    await page.waitForTimeout(1200);
    expect(failures).toEqual([]);
    expect(external).toEqual([]);
    const settings = await page.evaluate(() => (window as unknown as { __ceresIceSettings: RTCConfiguration[] }).__ceresIceSettings);
    expect(settings.every(configuration => !configuration.iceServers?.length)).toBe(true);
  });
}

test("public routes link to external documentation and exclude platform routes", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "https://ceres.cam/documentation/");
  for (const route of ["/account", "/documentation/", "/api/account/session", "/api/observability"]) {
    expect((await request.get(route)).status()).toBe(404);
  }
});
