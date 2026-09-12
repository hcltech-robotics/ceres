import type { Episode } from "../shared/protocol.js";

export type EpisodeBlockState = "empty" | "unannotated" | "passed" | "failed" | "writing";

export interface EpisodeBlockPresentation {
  cycleLabel: string;
  taskLabel: string;
  state: EpisodeBlockState;
  uploaded: boolean;
  detail: string;
}

const padEpisodeIndex = (value: number) => String(Math.max(0, value)).padStart(2, "0");

export function episodeBlockPresentation(
  episode: Episode,
  taskIndex: number,
  _relatedAttempts: readonly Episode[],
): EpisodeBlockPresentation {
  const base = {
    cycleLabel: `C${padEpisodeIndex(episode.cycle)}`,
    taskLabel: `T${padEpisodeIndex(taskIndex + 1)}`,
    uploaded: episode.huggingFaceUpload?.state === "completed",
  };
  const uploadDetail = episode.huggingFaceUpload
    ? ` Uploaded to Hugging Face ${episode.huggingFaceUpload.repository}@${episode.huggingFaceUpload.branch}.`
    : "";
  if (!Number.isSafeInteger(episode.frameCount) || episode.frameCount <= 0) {
    return { ...base, state: "empty", detail: `No durable sensor frames. Not exportable.${uploadDetail}` };
  }
  if (episode.outcome === "recording" || episode.integrity === "pending") {
    return { ...base, state: "writing", detail: `Recording with ${episode.frameCount} durable sensor frames.${uploadDetail}` };
  }
  if (episode.annotation === "fail"
    || episode.outcome === "failed"
    || episode.outcome === "retry"
    || episode.outcome === "stopped"
    || episode.integrity === "interrupted") {
    return { ...base, state: "failed", detail: `Failed episode with ${episode.frameCount} durable sensor frames.${uploadDetail}` };
  }
  if (episode.annotation === "pass" || episode.outcome === "successful") {
    return { ...base, state: "passed", detail: `Passed episode with ${episode.frameCount} durable sensor frames.${uploadDetail}` };
  }
  return { ...base, state: "unannotated", detail: `Unannotated episode with ${episode.frameCount} durable sensor frames.${uploadDetail}` };
}
