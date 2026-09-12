import type { AsrStatusState } from "../shared/protocol.js";

export interface AsrGatewayOptions {
  endpoint?: string;
  healthEndpoint?: string;
  fetchImpl?: typeof fetch;
}

export class AsrGateway {
  private readonly endpoint: string;
  private readonly healthEndpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AsrGatewayOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.ASR_URL ?? "http://127.0.0.1:8123/transcribe";
    this.healthEndpoint = options.healthEndpoint ?? process.env.ASR_HEALTH_URL ?? new URL("/health", this.endpoint).toString();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async status(): Promise<AsrStatusState> {
    try {
      const response = await this.fetchImpl(this.healthEndpoint, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return "unavailable";
      const result = await response.json() as { ready?: unknown };
      if (typeof result.ready !== "boolean") return "error";
      return result.ready ? "ready" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async transcribe(dataBase64: string, mimeType: string): Promise<{ text: string; available: boolean }> {
    try {
      const audio = Buffer.from(dataBase64, "base64");
      if (audio.byteLength < 128) return { text: "", available: true };
      const form = new FormData();
      form.append("audio", new Blob([audio], { type: mimeType }), "voice.webm");
      const response = await this.fetchImpl(this.endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) return { text: "", available: false };
      const result = await response.json() as { text?: string };
      return { text: result.text?.trim() ?? "", available: true };
    } catch {
      return { text: "", available: false };
    }
  }
}
