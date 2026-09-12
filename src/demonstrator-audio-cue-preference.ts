const DEMONSTRATOR_AUDIO_CUE_PREFERENCE_KEY = "ceres.demonstrator-audio-cues";

interface PreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readDemonstratorAudioCuePreference(store: PreferenceStore | null | undefined): boolean {
  try {
    return store?.getItem(DEMONSTRATOR_AUDIO_CUE_PREFERENCE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeDemonstratorAudioCuePreference(
  store: PreferenceStore | null | undefined,
  enabled: boolean,
) {
  try {
    store?.setItem(DEMONSTRATOR_AUDIO_CUE_PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    // Audio cues remain usable when browser storage is unavailable.
  }
}
