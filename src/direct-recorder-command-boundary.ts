import type { Episode } from "../shared/protocol.js";

export type DirectRecorderCommandAction =
  | "recording-arming"
  | "recording-recover-arming"
  | "recording-stopping"
  | "recording-recover-stopping";

export type DirectRecorderCommandResult =
  | { type: "recording-accepted"; episodeId: string }
  | { type: "recording-rejected"; episodeId: string; error: string }
  | { type: "recording-finalised"; episodeId: string; error?: string };

export class DirectRecorderCommandBoundary {
  private activeEpisodeId: string | null = null;
  private starting: { episodeId: string; promise: Promise<DirectRecorderCommandResult> } | null = null;
  private finalising: { episodeId: string; promise: Promise<DirectRecorderCommandResult> } | null = null;
  private readonly finalised = new Map<string, Extract<DirectRecorderCommandResult, { type: "recording-finalised" }>>();

  constructor(
    private readonly start: (episodeId: string, episode?: Episode) => Promise<{ accepted: boolean; error?: string }>,
    private readonly finalise: (episodeId: string) => Promise<{ error?: string }>,
  ) {}

  apply(action: DirectRecorderCommandAction, episodeId: string, episode?: Episode): Promise<DirectRecorderCommandResult> {
    return action === "recording-arming" || action === "recording-recover-arming"
      ? this.startEpisode(episodeId, episode)
      : this.finaliseEpisode(episodeId);
  }

  private startEpisode(episodeId: string, episode?: Episode): Promise<DirectRecorderCommandResult> {
    if (this.finalised.has(episodeId)) {
      return Promise.resolve({
        type: "recording-rejected",
        episodeId,
        error: "The demonstrator recorder has already finalised this episode",
      });
    }
    if (this.activeEpisodeId === episodeId) return Promise.resolve({ type: "recording-accepted", episodeId });
    if (this.activeEpisodeId) {
      return Promise.resolve({
        type: "recording-rejected",
        episodeId,
        error: `The demonstrator recorder is already running episode ${this.activeEpisodeId}`,
      });
    }
    if (this.starting) {
      return this.starting.episodeId === episodeId
        ? this.starting.promise
        : Promise.resolve({
          type: "recording-rejected",
          episodeId,
          error: `The demonstrator recorder is already arming episode ${this.starting.episodeId}`,
        });
    }
    const promise: Promise<DirectRecorderCommandResult> = this.start(episodeId, episode)
      .then((result) => {
        if (!result.accepted) {
          return {
            type: "recording-rejected" as const,
            episodeId,
            error: result.error || "The demonstrator recorder did not arm",
          };
        }
        this.activeEpisodeId = episodeId;
        return { type: "recording-accepted" as const, episodeId };
      })
      .catch((error) => ({
        type: "recording-rejected" as const,
        episodeId,
        error: directRecorderError(error, "The demonstrator recorder could not start"),
      }));
    this.starting = { episodeId, promise };
    void promise.then(
      () => { if (this.starting?.promise === promise) this.starting = null; },
      () => { if (this.starting?.promise === promise) this.starting = null; },
    );
    return promise;
  }

  private finaliseEpisode(episodeId: string): Promise<DirectRecorderCommandResult> {
    const completed = this.finalised.get(episodeId);
    if (completed) return Promise.resolve(completed);
    if (this.finalising) {
      return this.finalising.episodeId === episodeId
        ? this.finalising.promise
        : Promise.resolve({
          type: "recording-finalised",
          episodeId,
          error: `The demonstrator recorder is already finalising episode ${this.finalising.episodeId}`,
        });
    }
    const promise: Promise<DirectRecorderCommandResult> = (async () => {
      if (this.starting?.episodeId === episodeId) {
        const started = await this.starting.promise;
        if (started.type !== "recording-accepted") {
          return { type: "recording-finalised", episodeId, error: started.error };
        }
      }
      if (this.activeEpisodeId !== episodeId) {
        return {
          type: "recording-finalised",
          episodeId,
          error: "The demonstrator recorder has no matching active episode to finalise",
        };
      }
      try {
        const result = await this.finalise(episodeId);
        this.activeEpisodeId = null;
        return { type: "recording-finalised", episodeId, ...(result.error ? { error: result.error } : {}) };
      } catch (error) {
        this.activeEpisodeId = null;
        return {
          type: "recording-finalised",
          episodeId,
          error: directRecorderError(error, "The demonstrator recorder could not finalise"),
        };
      }
    })();
    this.finalising = { episodeId, promise };
    void promise.then((result) => {
      if (result.type === "recording-finalised") {
        this.finalised.set(episodeId, result);
        if (this.finalised.size > 8) this.finalised.delete(this.finalised.keys().next().value!);
      }
      if (this.finalising?.promise === promise) this.finalising = null;
    }, () => {
      if (this.finalising?.promise === promise) this.finalising = null;
    });
    return promise;
  }
}

export function directRecorderError(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
