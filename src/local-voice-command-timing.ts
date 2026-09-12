export const LOCAL_VOICE_COMMAND_MIN_UTTERANCE_SECONDS = 1;
export const LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_BASE_MS = 30_000;
export const LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_MAX_MS = 120_000;

export function localVoiceCommandMinimumUtteranceFrames(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return Math.ceil(sampleRate * LOCAL_VOICE_COMMAND_MIN_UTTERANCE_SECONDS);
}

export function localVoiceCommandInitialisationRetryDelay(attempt: number) {
  const boundedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.min(2, Math.floor(attempt)))
    : 0;
  return Math.min(
    LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_MAX_MS,
    LOCAL_VOICE_COMMAND_INITIALISATION_RETRY_BASE_MS * (2 ** boundedAttempt),
  );
}
