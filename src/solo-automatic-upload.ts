import { isExportableEpisode } from "../shared/lerobot-export.js";
import type {
  Episode,
  SessionSnapshot,
  SoloHuggingFaceSaveCadence,
} from "../shared/protocol.js";

function belongsToCompletedRun(episode: Episode, runStartedAtMs: number | null) {
  if (!episode.endedAt || runStartedAtMs === null) return false;
  const endedAtMs = Date.parse(episode.endedAt);
  return Number.isFinite(endedAtMs) && endedAtMs >= runStartedAtMs;
}

function cadenceBoundaryReached(
  episode: Episode,
  snapshot: SessionSnapshot,
  cadence: SoloHuggingFaceSaveCadence,
) {
  if (cadence === "run") {
    return snapshot.run.status === "complete" && snapshot.run.recordingState === "idle";
  }
  return snapshot.run.status === "complete"
    || episode.cycle < snapshot.run.cycle
    || (
      snapshot.run.phase === "cycle-pause"
      && snapshot.run.recordingState === "idle"
      && episode.cycle === snapshot.run.cycle
    );
}

function submittedUploadEpisodeIds(snapshot: SessionSnapshot) {
  return new Set(snapshot.jobs.flatMap((job) => (
    job.type === "upload" && job.browserRecovery?.destination === "hugging-face"
      ? job.browserRecovery.episodeIds
      : []
  )));
}

/**
 * Returns durable current-run episodes that have reached the selected
 * automatic Hugging Face upload boundary and have not already been submitted.
 */
export function soloAutomaticUploadEpisodeIds(
  snapshot: SessionSnapshot,
  cadence: SoloHuggingFaceSaveCadence,
): string[] {
  const submitted = submittedUploadEpisodeIds(snapshot);
  return [...snapshot.episodes, ...snapshot.attempts]
    .filter((episode) => (
      episode.integrity === "valid"
      && isExportableEpisode(episode)
      && !episode.huggingFaceUpload
      && !submitted.has(episode.id)
      && belongsToCompletedRun(episode, snapshot.run.startedAtMs)
      && cadenceBoundaryReached(episode, snapshot, cadence)
    ))
    .map((episode) => episode.id)
    .sort();
}

export function soloAutomaticUploadKey(
  snapshot: SessionSnapshot,
  cadence: SoloHuggingFaceSaveCadence,
  episodeIds: readonly string[],
) {
  if (episodeIds.length === 0 || snapshot.run.startedAtMs === null) return null;
  return `${snapshot.sessionId}:${snapshot.run.startedAtMs}:${cadence}:${episodeIds.join(",")}`;
}

/**
 * Returns durable episodes that still need the run-level
 * Hugging Face upload selected by Solo setup.
 */
export function soloRunUploadEpisodeIds(snapshot: SessionSnapshot): string[] {
  return soloAutomaticUploadEpisodeIds(snapshot, "run");
}

export function soloRunUploadKey(snapshot: SessionSnapshot, episodeIds: readonly string[]) {
  if (episodeIds.length === 0 || snapshot.run.endedAtMs === null) return null;
  return `${snapshot.sessionId}:${snapshot.run.endedAtMs}:${episodeIds.join(",")}`;
}
