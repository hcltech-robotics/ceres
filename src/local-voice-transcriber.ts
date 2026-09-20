import type { Stream, Transcriber } from "@moonshine-ai/moonshine-wasm";

type UtteranceStream = Pick<Stream, "start" | "addAudio" | "stop" | "transcribe" | "close">;
type UtteranceTranscriber = Pick<Transcriber, "createStream"> | { createStream(): UtteranceStream };

/** Completes one bounded utterance without reusing text from a previous attempt. */
export function transcribeLocalVoiceUtterance(transcriber: UtteranceTranscriber, samples: Float32Array, sampleRate: number) {
  const stream = transcriber.createStream();
  try {
    stream.start();
    stream.addAudio(samples, sampleRate);
    // stop() forces final decoding. The following read returns its cached result,
    // so only final text can trigger actions such as trail on or trail off.
    stream.stop();
    return stream.transcribe().lines.filter(line => line.isComplete).map(line => line.text).join(" ");
  } finally {
    stream.close();
  }
}
