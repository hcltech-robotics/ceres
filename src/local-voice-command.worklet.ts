import { localVoiceCommandMinimumUtteranceFrames } from "./local-voice-command-timing.js";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class LocalVoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunks: Float32Array[] = [];
  private heardSpeech = false;
  private speechFrames = 0;
  private silenceFrames = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input) return true;
    const power = input.reduce((total, sample) => total + sample * sample, 0) / input.length;
    // Quest's outward-capture microphone is normally automatic-gain controlled.
    // Its spoken command level falls below the previous threshold, which meant no
    // utterance ever reached the local recogniser.
    const speaking = power >= 0.00005;
    if (!this.heardSpeech && !speaking) return true;
    this.heardSpeech ||= speaking;
    this.chunks.push(input.slice());
    this.speechFrames += input.length;
    this.silenceFrames = speaking ? 0 : this.silenceFrames + input.length;
    // Moonshine derives its output-token budget from whole seconds of audio.
    // A spoken command plus trailing silence must therefore reach one second,
    // otherwise the recogniser receives a zero-token budget and can never
    // produce a command.
    const minSpeechFrames = localVoiceCommandMinimumUtteranceFrames(sampleRate);
    const silenceFrames = Math.floor(sampleRate * 0.55);
    const maxSpeechFrames = Math.floor(sampleRate * 2.8);
    if (this.speechFrames < minSpeechFrames || (this.silenceFrames < silenceFrames && this.speechFrames < maxSpeechFrames)) return true;
    const samples = new Float32Array(this.speechFrames);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.port.postMessage({ samples, sampleRate }, [samples.buffer]);
    this.chunks.length = 0;
    this.heardSpeech = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    return true;
  }
}

registerProcessor("ceres-local-voice-capture", LocalVoiceCaptureProcessor);
