export type EpisodeSequenceCursor = Readonly<{
  cycle: number;
  taskIndex: number;
  repetition: number;
}>;

export function episodeDisplayCycles(entries: readonly EpisodeSequenceCursor[]) {
  let offset = 0;
  let previous: { sourceCycle: number; displayCycle: number; taskIndex: number; repetition: number } | null = null;
  return entries.map((entry) => {
    if (previous
      && entry.cycle <= previous.sourceCycle
      && entry.taskIndex <= previous.taskIndex
      && entry.repetition <= previous.repetition) {
      offset = previous.displayCycle;
    }
    const displayCycle = entry.cycle + offset;
    previous = {
      sourceCycle: entry.cycle,
      displayCycle,
      taskIndex: entry.taskIndex,
      repetition: entry.repetition,
    };
    return displayCycle;
  });
}
