import "@fontsource-variable/geist";
import "./capture-loading.css";
import { mountCaptureLoading } from "./capture-loading.js";
import { cameraAccessCapability } from "./quest-camera.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("CERES capture root is missing");
const loading = mountCaptureLoading(root);
let dispose: (() => void) | undefined;

async function mount(target: URL) {
  if (!root) return;
  const application = target.pathname === "/bridge/"
    ? (await import("./bridge-runtime.js")).mountBridgeApplication
    : target.searchParams.get("mode") === "solo"
      ? (await import("./solo-runtime.js")).mountSoloApplication
      : (await import("./capture-runtime.js")).mountCaptureApplication;
  dispose?.();
  for (const key of Object.keys(root.dataset)) delete root.dataset[key];
  dispose = application(root);
}

if (!globalThis.isSecureContext) {
  loading.failInsecureOrigin(cameraAccessCapability().message ?? "Camera access requires HTTPS.");
} else {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("state")) {
      await (await import("./solo-hf-oauth.js")).restoreSoloHuggingFaceOauthReturnRoute();
    }
    await mount(new URL(location.href));
  } catch (error) { loading.fail(error); }
}

let switching = false;
root.addEventListener("ceres:capture-mode", event => {
  const target = (event as CustomEvent<{ target: string }>).detail?.target;
  if (!target) return;
  const url = new URL(target, location.href);
  if (url.origin !== location.origin || !["/bridge/", "/launch/capture/"].includes(url.pathname)) return;
  event.preventDefault();
  if (switching) return;
  switching = true;
  history.pushState(null, "", url);
  void mount(url).catch(error => loading.fail(error)).finally(() => { switching = false; });
});
window.addEventListener("popstate", () => {
  if (switching) return;
  switching = true;
  void mount(new URL(location.href)).catch(error => loading.fail(error)).finally(() => { switching = false; });
});
