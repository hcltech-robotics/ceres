import model from "../shared/local-voice-model.json";
import {
  LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE,
  localVoiceCommandFailureKind,
  type LocalVoiceCommandFailure,
} from "./local-voice-command.js";

interface LocalVoiceModelFailure {
  detail: string;
  failure: LocalVoiceCommandFailure;
  retryable: boolean;
}

interface LocalVoiceModelRecoveryOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Confirms absent installation files separately from transient load failures. */
export class LocalVoiceModelRecovery {
  private missingAssets = false;

  get blocked() {
    return this.missingAssets;
  }

  async failure(
    error: unknown,
    allowRemoteModels: boolean,
    options: LocalVoiceModelRecoveryOptions = {},
  ): Promise<LocalVoiceModelFailure> {
    const diagnosticDetail = error instanceof Error ? error.message : "Local voice commands could not load";
    if (!this.missingAssets && !allowRemoteModels && await this.hasMissingAssets(options)) this.missingAssets = true;
    if (this.missingAssets) {
      return {
        detail: LOCAL_VOICE_MODEL_ASSETS_MISSING_MESSAGE,
        failure: { kind: "model-assets", diagnosticDetail },
        retryable: false,
      };
    }
    const kind = localVoiceCommandFailureKind(diagnosticDetail);
    return {
      detail: diagnosticDetail,
      // A failed fetch can produce the same Transformers exception as a 404.
      // Only confirmed missing resources stop retries or show repair guidance.
      failure: { kind: kind === "model-assets" ? "model-download" : kind, diagnosticDetail },
      retryable: true,
    };
  }

  private async hasMissingAssets(options: LocalVoiceModelRecoveryOptions) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    const request = options.fetch ?? globalThis.fetch;
    try {
      const statuses = await Promise.all(model.files.map(async file => {
        try {
          const response = await request(`/models/${model.modelId}/${file.path}`, {
            method: "HEAD",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          });
          return response.status;
        } catch {
          return 0;
        }
      }));
      return statuses.some(status => status === 404 || status === 410);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}
