export type LocalVoiceCommandAudioMessage =
  | { type: "speech-start"; utteranceId: number }
  | { type: "speech-cancel"; utteranceId: number }
  | { type: "audio"; utteranceId: number; samples: Float32Array; sampleRate: number };

const MINIMUM_ONSET_POWER = 0.000004;
const MINIMUM_CONTINUATION_POWER = 0.000001;
const ONSET_NOISE_RATIO = 4;
const CONTINUATION_NOISE_RATIO = 2;

/**
 * Separates short commands using a background-relative energy gate. Analysis
 * frames and audio storage are reused, with one transferable allocation when
 * an utterance ends. The pre-roll retains quiet consonants before onset.
 */
export class LocalVoiceCommandSegmenter {
  private readonly analysis: Float32Array;
  private readonly preRoll: Float32Array;
  private readonly utterance: Float32Array;
  private readonly onsetFrames: number;
  private readonly minimumSpeechFrames: number;
  private readonly endSilenceFrames: number;
  private readonly rearmFrames: number;
  private readonly highPassCoefficient: number;
  private analysisLength = 0;
  private analysisPower = 0;
  private analysisPeak = 0;
  private previousInput = 0;
  private previousFiltered = 0;
  private preRollPosition = 0;
  private preRollLength = 0;
  private utteranceLength = 0;
  private nextUtteranceId = 1;
  private activeUtteranceId: number | null = null;
  private noisePower = 0.00000025;
  private continuationPower = MINIMUM_CONTINUATION_POWER;
  private candidateFrames = 0;
  private voicedFrames = 0;
  private silenceFrames = 0;
  private minimumVoicedPower = Number.POSITIVE_INFINITY;
  private maximumVoicedPower = 0;
  private waitingForQuiet = false;
  private quietFrames = 0;

  constructor(
    readonly sampleRate: number,
    private readonly onMessage: (message: LocalVoiceCommandAudioMessage) => void,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
      throw new RangeError("Voice audio requires a sample rate between 8000 and 192000 Hz");
    }
    this.analysis = new Float32Array(Math.round(sampleRate * 0.01));
    this.preRoll = new Float32Array(Math.round(sampleRate * 0.2));
    this.utterance = new Float32Array(Math.round(sampleRate * 3));
    this.onsetFrames = Math.round(sampleRate * 0.03);
    this.minimumSpeechFrames = Math.round(sampleRate * 0.07);
    this.endSilenceFrames = Math.round(sampleRate * 0.28);
    this.rearmFrames = Math.round(sampleRate * 0.12);
    this.highPassCoefficient = Math.exp(-2 * Math.PI * 80 / sampleRate);
  }

  process(samples: Float32Array) {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      this.analysis[this.analysisLength] = sample;
      this.analysisLength += 1;
      // Remove DC and low rumble only for detection. Recognition keeps raw PCM.
      const filtered = this.highPassCoefficient * (this.previousFiltered + sample - this.previousInput);
      this.previousInput = sample;
      this.previousFiltered = filtered;
      this.analysisPower += filtered * filtered;
      this.analysisPeak = Math.max(this.analysisPeak, Math.abs(filtered));
      if (this.analysisLength !== this.analysis.length) continue;
      this.processFrame(this.analysisPower / this.analysisLength);
      this.analysisLength = 0;
      this.analysisPower = 0;
      this.analysisPeak = 0;
    }
  }

  private processFrame(power: number) {
    for (let index = 0; index < this.analysis.length; index += 1) {
      this.preRoll[this.preRollPosition] = this.analysis[index];
      this.preRollPosition = (this.preRollPosition + 1) % this.preRoll.length;
    }
    this.preRollLength = Math.min(this.preRoll.length, this.preRollLength + this.analysis.length);

    const impulsive = this.analysisPeak * this.analysisPeak > power * 20;
    if (this.waitingForQuiet) {
      if (power < Math.max(MINIMUM_ONSET_POWER, this.noisePower * ONSET_NOISE_RATIO)) {
        this.quietFrames += this.analysis.length;
        this.updateNoisePower(power);
      } else {
        this.quietFrames = 0;
      }
      if (this.quietFrames >= this.rearmFrames) {
        this.waitingForQuiet = false;
        this.quietFrames = 0;
      }
      return;
    }

    if (this.activeUtteranceId === null) {
      const aboveOnset = power >= Math.max(MINIMUM_ONSET_POWER, this.noisePower * ONSET_NOISE_RATIO);
      if (aboveOnset && !impulsive) {
        this.candidateFrames += this.analysis.length;
        if (this.candidateFrames >= this.onsetFrames) this.startUtterance(power);
      } else {
        this.candidateFrames = 0;
        if (!impulsive) this.updateNoisePower(power);
      }
      return;
    }

    const available = this.utterance.length - this.utteranceLength;
    const copied = Math.min(this.analysis.length, available);
    for (let index = 0; index < copied; index += 1) {
      this.utterance[this.utteranceLength + index] = this.analysis[index];
    }
    this.utteranceLength += copied;
    if (power >= this.continuationPower && !impulsive) {
      this.voicedFrames += this.analysis.length;
      this.silenceFrames = 0;
      this.minimumVoicedPower = Math.min(this.minimumVoicedPower, power);
      this.maximumVoicedPower = Math.max(this.maximumVoicedPower, power);
    } else {
      this.silenceFrames += this.analysis.length;
      if (!impulsive) this.updateNoisePower(power);
    }

    if (this.silenceFrames >= this.endSilenceFrames) this.finishUtterance(false);
    else if (this.utteranceLength === this.utterance.length) this.finishUtterance(true);
  }

  private startUtterance(power: number) {
    const start = (this.preRollPosition - this.preRollLength + this.preRoll.length) % this.preRoll.length;
    for (let index = 0; index < this.preRollLength; index += 1) {
      this.utterance[index] = this.preRoll[(start + index) % this.preRoll.length];
    }
    this.utteranceLength = this.preRollLength;
    this.continuationPower = Math.max(MINIMUM_CONTINUATION_POWER, this.noisePower * CONTINUATION_NOISE_RATIO);
    this.voicedFrames = this.candidateFrames;
    this.silenceFrames = 0;
    this.minimumVoicedPower = power;
    this.maximumVoicedPower = power;
    this.activeUtteranceId = this.nextUtteranceId;
    this.nextUtteranceId += 1;
    this.candidateFrames = 0;
    this.onMessage({ type: "speech-start", utteranceId: this.activeUtteranceId });
  }

  private finishUtterance(atMaximumLength: boolean) {
    const utteranceId = this.activeUtteranceId!;
    // A continuously elevated, unmodulated signal is a changed noise floor.
    // It must settle before another onset rather than creating repeated jobs.
    const stationaryNoise = atMaximumLength && this.maximumVoicedPower < this.minimumVoicedPower * 2;
    if (stationaryNoise) this.noisePower = Math.max(this.noisePower, this.minimumVoicedPower);
    const samples = this.voicedFrames >= this.minimumSpeechFrames && !stationaryNoise
      ? this.utterance.slice(0, this.utteranceLength)
      : null;
    this.activeUtteranceId = null;
    this.utteranceLength = 0;
    this.voicedFrames = 0;
    this.silenceFrames = 0;
    this.waitingForQuiet = atMaximumLength;
    this.quietFrames = 0;
    if (samples) this.onMessage({ type: "audio", utteranceId, samples, sampleRate: this.sampleRate });
    else this.onMessage({ type: "speech-cancel", utteranceId });
  }

  private updateNoisePower(power: number) {
    const adaptation = power < this.noisePower ? 0.15 : 0.04;
    this.noisePower += (power - this.noisePower) * adaptation;
  }
}
