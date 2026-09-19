import { normalisePairingCode } from "../../shared/pairing-code.js";

export function receiverCodeFromQr(text: string, origin: string): string | null {
  const rawCode = normalisePairingCode(text);
  if (rawCode) return rawCode;
  try {
    const url = new URL(text);
    if (url.origin !== origin) return null;
    const code = url.pathname === "/bridge/" ? url.searchParams.get("code")
      : url.searchParams.get("mode") === "bridge" ? url.pathname.match(/^\/j\/([^/]+)$/)?.[1] : null;
    return code ? normalisePairingCode(code) : null;
  } catch { return null; }
}

export async function scanReceiverCode(video: HTMLVideoElement, signal: AbortSignal): Promise<string | null> {
  if (!video.videoWidth || !video.videoHeight) throw new Error("Enable the camera before scanning a receiver code");
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = Math.round(640 * video.videoHeight / video.videoWidth);
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  let abort: (() => void) | undefined;
  try {
    if (signal.aborted) return null;
    worker = new Worker(new URL("./qr.worker.ts", import.meta.url), { type: "module" });
    return await new Promise<string | null>((resolve, reject) => {
      abort = () => resolve(null);
      signal.addEventListener("abort", abort, { once: true });
      const capture = () => {
        if (signal.aborted) { resolve(null); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        worker!.postMessage(frame, [frame.data.buffer]);
      };
      worker!.onmessage = (event: MessageEvent<string | null>) => {
        const code = event.data && receiverCodeFromQr(event.data, location.origin);
        if (code) resolve(code);
        else timer = setTimeout(capture, 200);
      };
      worker!.onerror = () => reject(new Error("QR scanning is unavailable. Enter the receiver code instead."));
      capture();
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
    worker?.terminate();
    canvas.width = canvas.height = 0;
  }
}
