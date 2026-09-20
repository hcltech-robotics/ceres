import { LOCAL_VOICE_COMMAND_MAX_AGE_MS } from "./local-voice-command-timing.js";

interface LocalVoiceCommandUtterance {
  utteranceId: number;
  capturedAtMs: number;
  context?: string;
}

interface LocalVoiceCommandAudio extends LocalVoiceCommandUtterance {
  samples: Float32Array;
  sampleRate: number;
}

export interface LocalVoiceCommandRequest extends LocalVoiceCommandAudio {
  requestId: number;
}

/** Keeps one inference and the latest complete retry without retaining old speech. */
export class LocalVoiceCommandQueue {
  private lastUtteranceId = 0;
  private nextRequestId = 1;
  private capturing: LocalVoiceCommandUtterance | null = null;
  private pending: LocalVoiceCommandAudio | null = null;
  private active: LocalVoiceCommandRequest | null = null;

  start(utteranceId: number, capturedAtMs: number, context?: string) {
    if (!Number.isSafeInteger(utteranceId) || utteranceId <= this.lastUtteranceId) return;
    this.lastUtteranceId = utteranceId;
    this.capturing = { utteranceId, capturedAtMs, context };
  }

  cancel(utteranceId: number) {
    if (this.capturing?.utteranceId === utteranceId) this.capturing = null;
  }

  capture(utteranceId: number, samples: Float32Array, sampleRate: number, now: number) {
    const utterance = this.capturing;
    if (!utterance || utterance.utteranceId !== utteranceId) return;
    this.capturing = null;
    if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || !this.fresh(utterance, now)) return;
    this.pending = { ...utterance, samples, sampleRate };
  }

  next(now: number): LocalVoiceCommandRequest | null {
    if (this.active) return null;
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.fresh(pending, now)) return null;
    this.active = { ...pending, requestId: this.nextRequestId++ };
    return this.active;
  }

  complete(requestId: number, now: number) {
    if (!this.active || this.active.requestId !== requestId) return null;
    const request = this.active;
    this.active = null;
    return { request, fresh: this.fresh(request, now) };
  }

  abandon(requestId: number) {
    if (this.active?.requestId !== requestId) return false;
    this.active = null;
    return true;
  }

  clear() {
    this.capturing = null;
    this.pending = null;
    this.active = null;
  }

  private fresh(utterance: LocalVoiceCommandUtterance, now: number) {
    const ageMs = now - utterance.capturedAtMs;
    return ageMs >= 0 && ageMs < LOCAL_VOICE_COMMAND_MAX_AGE_MS;
  }
}
