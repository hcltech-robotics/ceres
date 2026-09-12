export interface BridgeCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  side: "right" | "left" | "unknown";
  width: number;
  height: number;
}
