import { isExportableEpisode } from "../shared/lerobot-export.js";
import type { CaptureJob, Episode, SessionSnapshot } from "../shared/protocol.js";
import type { SoloLocalExportDestination } from "./solo-local-export-destination.js";

function belongsToCompletedRun(episode: Episode, runStartedAtMs: number | null) {
  if (!episode.endedAt || runStartedAtMs === null) return false;
  const endedAtMs = Date.parse(episode.endedAt);
  return Number.isFinite(endedAtMs) && endedAtMs >= runStartedAtMs;
}

function submittedLocalEpisodeIds(jobs: readonly CaptureJob[]) {
  return new Set(jobs.flatMap((job) => (
    job.browserRecovery?.destination === "opfs" || job.browserRecovery?.destination === "folder"
      ? job.browserRecovery.episodeIds
      : []
  )));
}

export function soloAutomaticLocalExportEpisodeIds(snapshot: SessionSnapshot): string[] {
  if (
    snapshot.run.status !== "complete"
    || snapshot.run.recordingState !== "idle"
    || snapshot.currentEpisode !== null
    || snapshot.pendingEpisode !== null
  ) return [];
  const submitted = submittedLocalEpisodeIds(snapshot.jobs);
  return snapshot.episodes
    .filter((episode) => (
      episode.accepted
      && episode.integrity === "valid"
      && isExportableEpisode(episode)
      && belongsToCompletedRun(episode, snapshot.run.startedAtMs)
      && !submitted.has(episode.id)
    ))
    .map(({ id }) => id)
    .sort();
}

export function soloAutomaticLocalExportKey(
  snapshot: SessionSnapshot,
  destination: SoloLocalExportDestination,
  episodeIds: readonly string[],
) {
  if (episodeIds.length === 0 || snapshot.run.endedAtMs === null) return null;
  const destinationKey = destination.type === "folder"
    ? `folder:${destination.name}`
    : "browser";
  return `${snapshot.sessionId}:${snapshot.run.endedAtMs}:${destinationKey}:${episodeIds.join(",")}`;
}
