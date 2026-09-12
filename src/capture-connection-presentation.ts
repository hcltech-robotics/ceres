import type { CaptureStatus } from "../shared/protocol.js";

export type CaptureConnectionStatus = Pick<CaptureStatus, "headsetModel"> & {
  questBrowser?: boolean;
  sensorSource?: string;
};

export interface CaptureConnectionPresentation {
  label: "NO DEVICE" | "HMD CONNECTED" | "BROWSER CONNECTED";
  detail: string;
}

const questModelPattern = /(?:^|\s)(?:meta\s+)?quest(?:\s|$)/i;

function isQuestCapture(status: CaptureConnectionStatus) {
  if (status.sensorSource === "synthetic" || status.sensorSource === "iwer") return false;
  if (typeof status.questBrowser === "boolean") return status.questBrowser;
  return questModelPattern.test(status.headsetModel ?? "");
}

function connectionDetail(status: CaptureConnectionStatus) {
  const model = status.headsetModel?.trim() ?? "";
  const source = status.sensorSource?.trim().replace(/-/g, " ").toUpperCase() ?? "";
  return [model, source].filter(Boolean).join(" / ");
}

export function captureConnectionPresentation(
  connected: boolean,
  status: CaptureConnectionStatus,
): CaptureConnectionPresentation {
  if (!connected) return { label: "NO DEVICE", detail: "" };
  return {
    label: isQuestCapture(status) ? "HMD CONNECTED" : "BROWSER CONNECTED",
    detail: connectionDetail(status),
  };
}
