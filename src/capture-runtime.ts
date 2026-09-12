import "@fontsource-variable/geist";
import "./style.css";
import "./capture-setup.css";
import { bindDisposableAppLifecycle, type HotDisposeContext } from "./app-lifecycle.js";
import { CaptureApp } from "./capture-app.js";

export function mountCaptureApplication(root: HTMLElement) {
  const app = new CaptureApp();
  try {
    app.mount(root);
  } catch (error) {
    app.dispose();
    throw error;
  }
  document.body.classList.remove("capture-loading-page");
  return bindDisposableAppLifecycle(app, window, (import.meta as ImportMeta & { hot?: HotDisposeContext }).hot);
}
