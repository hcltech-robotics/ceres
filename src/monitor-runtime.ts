import "@fontsource-variable/geist";
import "./style.css";
import "./task-import.css";
import { bindDisposableAppLifecycle, type HotDisposeContext } from "./app-lifecycle.js";

import { MonitorApp } from "./monitor-app.js";



export function mountMonitorApplication() {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) {    throw new Error("CERES monitor root is missing");
  }

  const app = new MonitorApp();
  try {
    app.mount(root);
  } catch (error) {
    app.dispose();    throw error;
  }
  bindDisposableAppLifecycle(app, window, (import.meta as ImportMeta & { hot?: HotDisposeContext }).hot);
}
