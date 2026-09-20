import { LocalVoiceCommandSegmenter } from "./local-voice-command-audio.js";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class LocalVoiceCaptureProcessor extends AudioWorkletProcessor {
  private readonly segmenter = new LocalVoiceCommandSegmenter(sampleRate, (message) => {
    if (message.type === "audio") this.port.postMessage(message, [message.samples.buffer]);
    else this.port.postMessage(message);
  });

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (output) for (const channel of output) channel.fill(0);
    if (input) this.segmenter.process(input);
    return true;
  }
}

registerProcessor("ceres-local-voice-capture", LocalVoiceCaptureProcessor);
