import jsQR from "jsqr";

self.onmessage = (event: MessageEvent<ImageData>) => {
  const frame = event.data;
  const found = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" });
  self.postMessage(found?.data ?? null);
};
