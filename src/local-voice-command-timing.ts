export const LOCAL_VOICE_COMMAND_MAX_AGE_MS = 4_000;
export const LOCAL_VOICE_COMMAND_INFERENCE_TIMEOUT_MS = 5_000;
export const LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_BASE_MS = 30_000;
export const LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_MAX_MS = 120_000;

export function localVoiceCommandInitialisationRetryDelay(attempt: number) {
  const boundedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.min(2, Math.floor(attempt)))
    : 0;
  return Math.min(
    LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_MAX_MS,
    LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_BASE_MS * (2 ** boundedAttempt),
  );
}
