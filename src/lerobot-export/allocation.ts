export interface MonitorEpisodeAllocation {
  episodeIndex: number;
  globalFrameIndex: number;
  nextGlobalFrameIndex: number | undefined;
}

export function resolveMonitorEpisodeAllocation(input: {
  episodeIndexBase: number | undefined;
  completedEpisodes: number;
  globalFrameIndexCursor: number | undefined;
  manifestEpisodeIndex: number;
  manifestGlobalFrameIndex: number;
  frameCount: number;
}): MonitorEpisodeAllocation {
  const episodeIndex = input.episodeIndexBase === undefined
    ? input.manifestEpisodeIndex
    : input.episodeIndexBase + input.completedEpisodes;
  const globalFrameIndex = input.globalFrameIndexCursor ?? input.manifestGlobalFrameIndex;
  const nextGlobalFrameIndex = input.globalFrameIndexCursor === undefined
    ? undefined
    : globalFrameIndex + input.frameCount;
  if (
    !Number.isSafeInteger(episodeIndex)
    || episodeIndex < 0
    || !Number.isSafeInteger(globalFrameIndex)
    || globalFrameIndex < 0
    || !Number.isSafeInteger(input.frameCount)
    || input.frameCount < 0
    || (
      nextGlobalFrameIndex !== undefined
      && !Number.isSafeInteger(nextGlobalFrameIndex)
    )
  ) {
    throw new Error("The LeRobot episode or frame allocation is too large to export safely");
  }
  return {
    episodeIndex,
    globalFrameIndex,
    nextGlobalFrameIndex,
  };
}
