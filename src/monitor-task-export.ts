import type { Episode, SessionSnapshot } from "../shared/protocol.js";
import { episodeExportTimeline } from "../shared/lerobot-export.js";

export interface AutomaticCaptureExport {
  key: string;
  episode: Episode;
  taskId?: string;
}

function taskExportKey(episodeId: string, index: number) {
  const key = `${episodeId}-task-${index + 1}`;
  if (key.length <= 128) return key;
  // Keep long source identifiers distinguishable without exceeding OPFS contracts.
  let hash = 0xcbf29ce484222325n;
  for (const character of key) hash = BigInt.asUintN(64, (hash ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n);
  return `${key.slice(0, 111)}-${hash.toString(16).padStart(16, "0")}`;
}

/** A task is complete only after its final rep's reset, when retry can no longer change it. */
export function automaticCaptureExports(snapshot: SessionSnapshot, cadence: "cycle" | "task"): AutomaticCaptureExport[] {
  const completed = [...snapshot.episodes, ...snapshot.attempts];
  if (cadence === "cycle") return completed
    .filter((episode) => episode.integrity === "valid" && Boolean(episode.endedAt) && episode.frameCount > 0)
    .map((episode) => ({ key: episode.id, episode }));
  const recordings = [...completed, snapshot.currentEpisode, snapshot.pendingEpisode].filter((value): value is Episode => Boolean(value));
  return recordings.flatMap((episode) => {
    const tasks = [...new Set((episode.segments ?? []).map((segment) => segment.taskId))];
    return tasks.flatMap((taskId) => {
      const segments = episode.segments!.filter((segment) => segment.taskId === taskId && segment.outcome !== "retry");
      if (!segments.length || segments.some((segment) => segment.outcome === "recording" || !segment.endedAt)) return [];
      const taskIndex = snapshot.configuration.tasks.findIndex((task) => task.id === taskId);
      const finalised = completed.some((entry) => entry.id === episode.id && entry.integrity === "valid");
      const pastTask = snapshot.run.cycle > episode.cycle
        || (snapshot.run.cycle === episode.cycle && taskIndex >= 0 && snapshot.run.activeTaskIndex > taskIndex);
      if (!finalised && !pastTask) return [];
      return [{ key: taskExportKey(episode.id, tasks.indexOf(taskId)), episode, taskId }];
    });
  });
}

/** Retain a task's reps while reading the complete, durably finalised cycle and media. */
export function taskExportCheckpoint(candidate: AutomaticCaptureExport, source: Episode): Episode | null {
  if (source.id !== candidate.episode.id || !candidate.taskId || source.integrity !== "valid"
    || !source.endedAt || source.outcome === "recording" || !Number.isFinite(Date.parse(source.endedAt))
    || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate.key)
    || !Number.isSafeInteger(source.firstRecorderSequence) || source.firstRecorderSequence! < 0
    || !Number.isSafeInteger(source.lastRecorderSequence) || source.lastRecorderSequence! < source.firstRecorderSequence!) return null;
  const segments = source.segments ?? [];
  const target = segments.filter((segment) => segment.taskId === candidate.taskId);
  const last = target.filter((segment) => segment.outcome !== "retry").at(-1);
  if (!last || segments.some((segment) => segment.outcome === "recording" || !segment.endedAt
    || !Number.isSafeInteger(segment.startSourceTimestampUs) || segment.startSourceTimestampUs! < 0
    || !Number.isSafeInteger(segment.endSourceTimestampUs) || segment.endSourceTimestampUs! < segment.startSourceTimestampUs!)) return null;
  const projection: Episode = {
    ...structuredClone(source), id: candidate.key,
    taskId: candidate.taskId, taskLabel: last.taskLabel, taskDescription: last.taskDescription,
    segments: segments.map((segment) => ({
      ...structuredClone(segment),
      outcome: segment.taskId === candidate.taskId ? segment.outcome : "retry" as const,
    })),
  };
  try {
    // Full raw counts and sequence bounds preserve terminal media and frame offsets.
    // The timeline removes non-target tasks and genuine retry attempts at export time.
    episodeExportTimeline(source);
    episodeExportTimeline(projection);
  } catch { return null; }
  return projection;
}
