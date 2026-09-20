export interface BridgeVideoStats {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  encodeMs: number;
  packetDelayMs: number;
  qp: number | null;
  limitation: string;
  codec: string;
  encoder: string;
  nackCount: number;
  pliCount: number;
}

type Counters = { timestamp: number; frames: number; bytes: number; encode: number; delay: number; packets: number; qp: number };
export const emptyVideoStats = (): BridgeVideoStats => ({ width: 0, height: 0, fps: 0, bitrate: 0,
  encodeMs: 0, packetDelayMs: 0, qp: null, limitation: "none", codec: "", encoder: "", nackCount: 0, pliCount: 0 });

/** Counter deltas describe the current interval, including after a peer restart. */
export class BridgeVideoStatsSampler {
  private previous = new Map<string, Counters>();

  sample(report: RTCStatsReport | undefined, paused = false): BridgeVideoStats {
    const next = new Map<string, Counters>();
    const result = emptyVideoStats();
    report?.forEach(stat => {
      if (stat.type !== "outbound-rtp" || stat.kind !== "video" || stat.isRemote) return;
      const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
      const current: Counters = { timestamp: stat.timestamp, frames: finite(stat.framesEncoded ?? stat.framesSent),
        bytes: finite(stat.bytesSent), encode: finite(stat.totalEncodeTime), delay: finite(stat.totalPacketSendDelay),
        packets: finite(stat.packetsSent), qp: finite(stat.qpSum) };
      const prior = this.previous.get(stat.id);
      next.set(stat.id, current);
      result.width = finite(stat.frameWidth);
      result.height = finite(stat.frameHeight);
      result.limitation = stat.qualityLimitationReason ?? "unknown";
      result.codec = report.get(stat.codecId)?.mimeType ?? "";
      result.encoder = stat.encoderImplementation ?? "";
      result.nackCount = finite(stat.nackCount);
      result.pliCount = finite(stat.pliCount);
      if (paused || !prior || current.timestamp <= prior.timestamp || current.frames < prior.frames || current.bytes < prior.bytes) return;
      const elapsed = current.timestamp - prior.timestamp;
      const frames = current.frames - prior.frames;
      const packets = current.packets - prior.packets;
      result.fps += frames * 1000 / elapsed;
      result.bitrate += (current.bytes - prior.bytes) * 8000 / elapsed;
      result.encodeMs = frames > 0 ? Math.max(0, current.encode - prior.encode) * 1000 / frames : 0;
      result.packetDelayMs = packets > 0 ? Math.max(0, current.delay - prior.delay) * 1000 / packets : 0;
      result.qp = frames > 0 && typeof stat.qpSum === "number" ? Math.max(0, current.qp - prior.qp) / frames : null;
    });
    this.previous = next;
    return result;
  }
}
