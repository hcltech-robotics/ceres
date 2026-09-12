import "@fontsource-variable/geist";
import "./style.css";
import "./solo.css";
import "./task-import.css";
import "./capture-setup.css";
import { bindDisposableAppLifecycle, type HotDisposeContext } from "./app-lifecycle.js";
import { SoloApp } from "./solo-app.js";

export function mountSoloApplication(root: HTMLElement) {
  const app = new SoloApp();
  try {
    app.mount(root);
  } catch (error) {
    app.dispose();
    throw error;
  }
  document.body.classList.remove("capture-loading-page");
  return bindDisposableAppLifecycle(app, window, (import.meta as ImportMeta & { hot?: HotDisposeContext }).hot);
}
