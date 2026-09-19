import { Check, ChevronDown, createIcons } from "lucide";

export function captureSafetyMarkup(id = "capture-safety-note") {
  return `<details id="${id}" class="capture-safety-note">
    <summary>Safety and headset visibility</summary>
    <div class="capture-safety-note-body">
      <p><strong>Flashing or flickering imagery can provoke photosensitive symptoms.</strong> Stop immediately and remove the headset after any seizure, loss of awareness, involuntary movement, altered vision, severe dizziness or disorientation.</p>
      <p><strong>The headset obstructs normal vision.</strong> Passthrough can lag, distort depth or omit hazards. Remove the headset before walking, changing position or checking the surrounding area.</p>
      <a href="/documentation/safety/" target="_blank" rel="noopener noreferrer">Read the full safety guidance</a>
    </div>
  </details>`;
}

export function installCaptureSetup(root: HTMLElement, bridge: boolean) {
  const column = root.querySelector<HTMLElement>(".join-column")!;
  const setup = document.createElement("section");
  setup.className = "capture-setup";
  setup.setAttribute("aria-label", `${bridge ? "Bridge" : "Duet"} capture setup`);
  const steps = [
    ["pairing", bridge ? "Pair receiver" : "Pair capture director", bridge ? "Enter the receiver code or scan its QR code." : "Enter a join code, scan an invitation or select an account invitation."],
    ["camera", "Camera and audio", bridge ? "Camera video is optional. Enable it for a preview alongside depth and motion." : "Grant access and confirm the outward camera preview. Voice control stays available."],
    ...bridge ? [] : [["task", "Assigned task", "Review the task supplied by the capture director."]],
    ["xr", "Open XR", bridge ? "Send depth, motion and any enabled camera video." : "Enter immersive capture when the session is ready."],
  ];
  setup.innerHTML = `${captureSafetyMarkup()}<ol class="capture-setup-steps">${steps.map(([id, title, detail], i) => `
    <li class="capture-setup-step" data-capture-step="${id}" data-state="available" data-collapsed="false">
      <button class="capture-step-summary" type="button" aria-expanded="true" aria-controls="capture-step-${id}">
        <span class="capture-step-number" aria-hidden="true"><span class="capture-step-number-value">${i + 1}</span><i data-lucide="check"></i></span>
        <span class="capture-step-content"><strong>${title}</strong><span>${detail}</span></span>
        <span class="capture-step-state">Available</span><i class="capture-step-toggle-icon" data-lucide="chevron-down" aria-hidden="true"></i>
      </button>
      <div class="capture-step-action" id="capture-step-${id}"></div>
    </li>`).join("")}</ol>`;
  column.querySelector(".join-heading")!.after(setup);
  const move = (id: string, selectors: string[]) => {
    const target = setup.querySelector(`#capture-step-${id}`)!;
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) target.append(node);
    }
  };
  move("pairing", [".join-key-area", "#bridge-receiver", "#bridge-forget"]);
  move("camera", ["#prepare-camera", ".launch-audio-preferences"]);
  if (bridge) {
    const camera = root.querySelector("#prepare-camera")!;
    const actions = document.createElement("div");
    actions.className = "capture-camera-actions";
    camera.replaceWith(actions);
    actions.append(camera, root.querySelector("#bridge-audio")!);
  }
  if (!bridge) move("task", ["#task-setup", "#take-review"]);
  move("xr", ["#prepare-prompts", ".capture-launch-actions"]);
  column.querySelector<HTMLElement>(".join-checklist")!.classList.add("sr-only");
  createIcons({ icons: { Check, ChevronDown }, root: setup });
  setup.querySelectorAll<HTMLElement>("[data-capture-step]").forEach(step => {
    step.querySelector<HTMLButtonElement>(".capture-step-summary")!.addEventListener("click", () => {
      const collapsed = step.dataset.collapsed !== "true";
      step.dataset.collapsed = String(collapsed);
      step.querySelector("button")!.setAttribute("aria-expanded", String(!collapsed));
    });
  });
}

export function renderCaptureSetup(root: HTMLElement, paired: boolean, camera: boolean, active: boolean) {
  for (const step of root.querySelectorAll<HTMLElement>("[data-capture-step]")) {
    const key = step.dataset.captureStep;
    const complete = key === "pairing" ? paired : key === "camera" ? camera : key === "xr" ? active : false;
    const available = key !== "xr" || !root.querySelector<HTMLButtonElement>("#enter-xr")!.disabled;
    const state = complete ? "complete" : !available ? "locked" : (key === "pairing" && !paired) || (key === "camera" && paired && !camera) || key === "xr" ? "active" : "available";
    if (step.dataset.state === state) continue;
    step.dataset.state = state;
    step.querySelector(".capture-step-state")!.textContent = complete ? "Complete" : state === "active" ? "Current" : available ? "Available" : "Waiting";
  }
}
