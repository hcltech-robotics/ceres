import { isRepetitionTask, type SessionSnapshot } from "../shared/protocol.js";


export type DemonstratorAudioCue =
  | "pause-countdown"
  | "pause-start"
  | "task-countdown"
  | "run-start"
  | "run-stop"
  | "task-end"
  | "cycle-end"
  | "hands-missing"
  | "hands-too-fast";

const COUNTDOWN_SECONDS = 3;
const HAND_ALERT_MAX_MS = 5_000;
const REPEATING_ALERT_INTERVAL_MS = 1_000;

export class DemonstratorAudioCueScheduler {
  private pauseDeadlineMs: number | null = null;
  private pauseCountdownSecond: number | null = null;
  private taskKey = "";
  private taskCountdownSecond: number | null = null;
  private handsMissingSinceMs: number | null = null;
  private lastHandsMissingCueAtMs: number | null = null;
  private lastFastHandsCueAtMs: number | null = null;

  observeRunTransition(previous: SessionSnapshot | null, next: SessionSnapshot): DemonstratorAudioCue[] {
    if (!previous) return [];
    const cues: DemonstratorAudioCue[] = [];
    if (previous.run.status !== "running" && next.run.status === "running") cues.push("run-start");
    if (previous.run.status === "running" && next.run.status !== "running") cues.push("run-stop");
    if (previous.run.phase !== "cycle-pause" && next.run.phase === "cycle-pause") cues.push("cycle-end");
    return cues;
  }

  observePauseCountdown(snapshot: SessionSnapshot | null, nowMs: number): DemonstratorAudioCue[] {
    const run = snapshot?.run;
    if (!run
      || (run.phase !== "post-task-pause" && run.phase !== "task-pause" && run.phase !== "cycle-pause")
      || run.resetDeadlineMs === null) {
      this.pauseDeadlineMs = null;
      this.pauseCountdownSecond = null;
      return [];
    }
    if (this.pauseDeadlineMs !== run.resetDeadlineMs) {
      this.pauseDeadlineMs = run.resetDeadlineMs;
      this.pauseCountdownSecond = null;
    }
    const remainingSeconds = Math.ceil((run.resetDeadlineMs - nowMs) / 1_000);
    if (remainingSeconds < 1 || remainingSeconds > COUNTDOWN_SECONDS || remainingSeconds === this.pauseCountdownSecond) return [];
    this.pauseCountdownSecond = remainingSeconds;
    return [remainingSeconds === 1 ? "pause-start" : "pause-countdown"];
  }

  observeTimedTaskCountdown(snapshot: SessionSnapshot | null, nowMs: number): DemonstratorAudioCue[] {
    const run = snapshot?.run;
    const task = snapshot?.configuration.tasks[run?.activeTaskIndex ?? -1];
    if (!run
      || !task
      || !isRepetitionTask(task)
      || task.type !== "timed"
      || run.status !== "running"
      || run.phase !== "active-task"
      || run.recordingState !== "recording"
      || run.takeStartedAtMs === null) {
      this.taskKey = "";
      this.taskCountdownSecond = null;
      return [];
    }
    const key = `${run.cycle}:${run.activeTaskIndex}:${run.repetition}:${run.take}:${run.takeStartedAtMs}`;
    if (key !== this.taskKey) {
      this.taskKey = key;
      this.taskCountdownSecond = null;
    }
    const elapsedMs = run.takeElapsedMs + Math.max(0, nowMs - run.takeStartedAtMs);
    const remainingSeconds = Math.ceil((task.durationS * 1_000 - elapsedMs) / 1_000);
    if (remainingSeconds < 1 || remainingSeconds > COUNTDOWN_SECONDS || remainingSeconds === this.taskCountdownSecond) return [];
    this.taskCountdownSecond = remainingSeconds;
    return ["task-countdown"];
  }

  observeHands(leftTracked: boolean, rightTracked: boolean, nowMs: number): DemonstratorAudioCue[] {
    if (leftTracked || rightTracked) {
      this.handsMissingSinceMs = null;
      this.lastHandsMissingCueAtMs = null;
      return [];
    }
    this.handsMissingSinceMs ??= nowMs;
    const elapsedMs = nowMs - this.handsMissingSinceMs;
    if (elapsedMs >= HAND_ALERT_MAX_MS) return [];
    if (this.lastHandsMissingCueAtMs !== null && nowMs - this.lastHandsMissingCueAtMs < REPEATING_ALERT_INTERVAL_MS) return [];
    this.lastHandsMissingCueAtMs = nowMs;
    return ["hands-missing"];
  }

  /**
   * Stands the hand-loss cues down while a controller is deliberately held for
   * menu work, so the cues restart from silence once the hands return.
   */
  suspendHandCues() {
    this.handsMissingSinceMs = null;
    this.lastHandsMissingCueAtMs = null;
  }

  observeFastHands(tooFast: boolean, nowMs: number): DemonstratorAudioCue[] {
    if (!tooFast) {
      this.lastFastHandsCueAtMs = null;
      return [];
    }
    if (this.lastFastHandsCueAtMs !== null && nowMs - this.lastFastHandsCueAtMs < REPEATING_ALERT_INTERVAL_MS) return [];
    this.lastFastHandsCueAtMs = nowMs;
    return ["hands-too-fast"];
  }

  reset() {
    this.pauseDeadlineMs = null;
    this.pauseCountdownSecond = null;
    this.taskKey = "";
    this.taskCountdownSecond = null;
    this.handsMissingSinceMs = null;
    this.lastHandsMissingCueAtMs = null;
    this.lastFastHandsCueAtMs = null;
  }
}

export class DemonstratorAudioCuePlayer {
  private context: AudioContext | null = null;

  prepare() {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") {
      void this.context.resume().catch((error) => {      });
    }
  }

  play(cues: readonly DemonstratorAudioCue[], urgency = 0) {
    if (cues.length === 0) return;
    this.prepare();
    const context = this.context;
    if (!context || context.state !== "running") return;
    for (const cue of cues) this.playCue(context, cue, urgency);
  }

  dispose() {
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  private playCue(context: AudioContext, cue: DemonstratorAudioCue, urgency: number) {
    const startAt = context.currentTime + .01;
    if (cue === "pause-countdown") return this.tone(context, 520, startAt, .09, .045);
    if (cue === "pause-start") return this.tone(context, 760, startAt, .28, .055);
    if (cue === "task-countdown") return this.chime(context, startAt, .026);
    if (cue === "run-start") return this.sequence(context, [620, 620, 620], startAt, .065, .045);
    if (cue === "run-stop") return this.sequence(context, [700, 560, 420], startAt, .085, .045);
    if (cue === "task-end") return this.sequence(context, [360, 680], startAt, .13, .035);
    if (cue === "cycle-end") return this.sequence(context, [330, 620, 620, 330, 620], startAt, .12, .04, .24);
    if (cue === "hands-missing") return this.missingHands(context, startAt, urgency);
    this.fastHands(context, startAt);
  }

  private sequence(
    context: AudioContext,
    frequencies: readonly number[],
    startAt: number,
    duration: number,
    gain: number,
    finalDuration = duration,
  ) {
    frequencies.forEach((frequency, index) => {
      this.tone(context, frequency, startAt + index * (duration + .055), index === frequencies.length - 1 ? finalDuration : duration, gain);
    });
  }

  private chime(context: AudioContext, startAt: number, gain: number) {
    this.tone(context, 680, startAt, .12, gain, "sine");
    this.tone(context, 1_020, startAt + .045, .17, gain * .72, "sine");
  }

  private missingHands(context: AudioContext, startAt: number, urgency: number) {
    const gain = .025 + Math.min(1, urgency) * .055;
    this.echo(context, 340, startAt, .28, gain);
    this.tone(context, 480, startAt + .48, .075, gain * .8);
  }

  private fastHands(context: AudioContext, startAt: number) {
    this.echo(context, 1_020, startAt, .12, .05);
    this.echo(context, 1_260, startAt + .25, .12, .05);
  }

  private echo(context: AudioContext, frequency: number, startAt: number, duration: number, gain: number) {
    this.tone(context, frequency, startAt, duration, gain);
    this.tone(context, frequency, startAt + .085, duration * .62, gain * .42);
    this.tone(context, frequency, startAt + .16, duration * .38, gain * .2);
  }

  private tone(
    context: AudioContext,
    frequency: number,
    startAt: number,
    duration: number,
    gainValue: number,
    type: OscillatorType = "triangle",
  ) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(gainValue, startAt + .012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + .02);
  }
}
