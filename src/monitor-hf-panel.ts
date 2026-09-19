import type { AccountExportSession } from "../shared/export-destination.js";

export interface MonitorHfAccountInput {
  session: AccountExportSession | null;
  accountUrl: string;
  loading?: boolean;
}

export interface MonitorHfAccountPresentation {
  state: "loading" | "signed-out" | "ready";
  message: string;
  detail: string;
  huggingFaceUrl: string;
  ceresUrl: string;
  showCeresLogin: boolean;
}

export function monitorHfAccountPresentation(input: MonitorHfAccountInput): MonitorHfAccountPresentation {
  const origin = new URL(input.accountUrl);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password) {
    throw new Error("The CERES account URL is invalid");
  }
  const connect = new URL("/api/account/export/hugging-face", origin);
  const directSignIn = new URL("/sign-in/hugging-face", origin);
  const signIn = new URL("/sign-in", origin);
  signIn.searchParams.set("redirect_url", new URL("/account", origin).href);
  const ready = input.session?.signedIn === true && input.session.huggingFace.state === "ready";
  const username = input.session?.huggingFace.username?.trim();
  return {
    state: input.loading ? "loading" : ready ? "ready" : "signed-out",
    message: input.loading
      ? "Checking Hugging Face login"
      : ready
        ? username ? `Logged in as ${username}` : "Logged in to Hugging Face"
        : "Hugging Face is not logged in",
    detail: input.session?.signedIn
      ? "Connect Hugging Face to this CERES account."
      : "Log in directly or use the CERES account linked to your Hugging Face identity.",
    huggingFaceUrl: input.session?.signedIn ? connect.href : directSignIn.href,
    ceresUrl: signIn.href,
    showCeresLogin: !input.session?.signedIn,
  };
}

export function monitorHfAccountMarkup(): string {
  return `<section id="hf-account-panel" class="hf-account-panel" data-state="loading" aria-label="Hugging Face login">
    <p id="hf-account-state" role="status">Checking Hugging Face login</p>
    <p id="hf-account-note" hidden></p>
    <div class="hf-account-actions">
      <a id="hf-account-action" class="toolbar-button" target="_blank" rel="noopener noreferrer" hidden>Log in with Hugging Face</a>
      <a id="hf-ceres-action" class="toolbar-button" target="_blank" rel="noopener noreferrer" hidden>Log in to CERES</a>
    </div>
  </section>`;
}

export function renderMonitorHfAccount(root: ParentNode, input: MonitorHfAccountInput): void {
  const presentation = monitorHfAccountPresentation(input);
  const panel = root.querySelector<HTMLElement>("#hf-account-panel");
  const status = root.querySelector<HTMLElement>("#hf-account-state");
  const note = root.querySelector<HTMLElement>("#hf-account-note");
  const huggingFace = root.querySelector<HTMLAnchorElement>("#hf-account-action");
  const ceres = root.querySelector<HTMLAnchorElement>("#hf-ceres-action");
  const fields = root.querySelector<HTMLElement>("#hf-destination-fields");
  const exportPanel = root.querySelector<HTMLElement>("#export-panel-hugging-face");
  if (panel) panel.dataset.state = presentation.state;
  if (exportPanel) exportPanel.dataset.hfState = presentation.state;
  if (status) {
    status.textContent = presentation.message;
    status.className = presentation.state === "ready" ? "is-success" : "";
  }
  if (note) {
    note.textContent = presentation.detail;
    note.hidden = presentation.state !== "signed-out";
  }
  if (huggingFace) {
    huggingFace.href = presentation.huggingFaceUrl;
    huggingFace.textContent = "Log in with Hugging Face";
    huggingFace.hidden = presentation.state !== "signed-out";
  }
  if (ceres) {
    ceres.href = presentation.ceresUrl;
    ceres.hidden = presentation.state !== "signed-out" || !presentation.showCeresLogin;
  }
  if (fields) fields.hidden = presentation.state !== "ready";
}
