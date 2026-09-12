import "@fontsource-variable/geist";
import "./style.css";
import "./bridge/display.css";
import "./capture-setup.css";
import { bindDisposableAppLifecycle, type HotDisposeContext } from "./app-lifecycle.js";
import { CaptureApp } from "./capture-app.js";
import { BridgeSender } from "./bridge/sender.js";

export function mountBridgeApplication(root: HTMLElement) {
  // Solo and Bridge share CaptureApp, its IWSDK world and all XR presentation.
  // Solo's session controller and exporter are recording services and are not started here.
  const app = new CaptureApp({ bridge: new BridgeSender() });
  try {
    app.mount(root);
  } catch (error) {
    app.dispose();
    throw error;
  }
  document.body.classList.remove("capture-loading-page");
  return bindDisposableAppLifecycle(app, window, (import.meta as ImportMeta & { hot?: HotDisposeContext }).hot);
}
