import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalVoiceCommandSegmenter,
  type LocalVoiceCommandAudioMessage,
} from "../src/local-voice-command-audio.js";

type AudioMessage = Extract<LocalVoiceCommandAudioMessage, { type: "audio" }>;

function silence(sampleRate: number, seconds: number) {
  return new Float32Array(Math.round(sampleRate * seconds));
}

function tone(sampleRate: number, seconds: number, amplitude: number, frequency = 400) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, index) => (
    amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate)
  ));
}

function noise(sampleRate: number, seconds: number, amplitude: number) {
  let seed = 42;
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return amplitude * (seed / 0xffff_ffff * 2 - 1);
  });
}

function join(...parts: Float32Array[]) {
  const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return samples;
}

function feed(segmenter: LocalVoiceCommandSegmenter, samples: Float32Array, blocks = [128]) {
  let offset = 0;
  let block = 0;
  while (offset < samples.length) {
    const end = Math.min(samples.length, offset + blocks[block % blocks.length]);
    segmenter.process(samples.subarray(offset, end));
    offset = end;
    block += 1;
  }
}

function capture(sampleRate: number, samples: Float32Array, blocks?: number[]) {
  const events: LocalVoiceCommandAudioMessage[] = [];
  const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
  feed(segmenter, samples, blocks);
  return events;
}

function audio(events: LocalVoiceCommandAudioMessage[]) {
  return events.filter((event): event is AudioMessage => event.type === "audio");
}

for (const sampleRate of [16_000, 44_100, 48_000]) {
  test(`retains a quiet consonant before onset at ${sampleRate} Hz`, () => {
    const consonant = tone(sampleRate, 0.08, 0.0008, 2_300);
    const word = tone(sampleRate, 0.15, 0.035);
    const recording = join(silence(sampleRate, 0.5), consonant, word, silence(sampleRate, 0.4));
    const events = capture(sampleRate, recording);
    assert.deepEqual(events.map((event) => [event.type, event.utteranceId]), [["speech-start", 1], ["audio", 1]]);
    const [result] = audio(events);
    assert.equal(result.sampleRate, sampleRate);
    // The pre-roll starts 200 ms before the confirmed 30 ms onset.
    const recordingStart = Math.round(sampleRate * 0.41);
    assert.deepEqual(result.samples, recording.slice(recordingStart, recordingStart + result.samples.length));
    const consonantStart = Math.round(sampleRate * 0.09);
    assert.deepEqual(result.samples.slice(consonantStart, consonantStart + consonant.length), consonant);
  });

  test(`finishes a brief quiet word within 300 ms of silence at ${sampleRate} Hz`, () => {
    const events: LocalVoiceCommandAudioMessage[] = [];
    const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
    feed(segmenter, join(silence(sampleRate, 0.3), tone(sampleRate, 0.07, 0.0045)));
    assert.deepEqual(events.map((event) => event.type), ["speech-start"]);
    feed(segmenter, silence(sampleRate, 0.27));
    assert.equal(audio(events).length, 0);
    feed(segmenter, silence(sampleRate, 0.03));
    assert.equal(audio(events).length, 1);
    assert.ok(audio(events)[0].samples.length < sampleRate * 0.6);
  });

  test(`keeps boundaries independent of input block size at ${sampleRate} Hz`, () => {
    const recording = join(
      noise(sampleRate, 0.37, 0.0004),
      tone(sampleRate, 0.13, 0.02),
      silence(sampleRate, 0.32),
      tone(sampleRate, 0.11, 0.009),
      silence(sampleRate, 0.4),
    );
    assert.deepEqual(capture(sampleRate, recording, [128]), capture(sampleRate, recording, [1, 53, 256, 777, 2_048]));
  });

  test(`accepts an immediate repeat after a short pause at ${sampleRate} Hz`, () => {
    const recording = join(
      silence(sampleRate, 0.3),
      tone(sampleRate, 0.13, 0.02),
      silence(sampleRate, 0.3),
      tone(sampleRate, 0.13, 0.02),
      silence(sampleRate, 0.3),
    );
    const events = capture(sampleRate, recording);
    assert.deepEqual(events.map((event) => [event.type, event.utteranceId]), [
      ["speech-start", 1], ["audio", 1], ["speech-start", 2], ["audio", 2],
    ]);
  });

  test(`rejects clicks and cancels a short noise burst at ${sampleRate} Hz`, () => {
    const clicks = silence(sampleRate, 0.3);
    clicks[Math.round(sampleRate * 0.04)] = 1;
    clicks[Math.round(sampleRate * 0.14)] = -1;
    assert.deepEqual(capture(sampleRate, join(clicks, silence(sampleRate, 0.4))), []);
    const events = capture(sampleRate, join(silence(sampleRate, 0.3), tone(sampleRate, 0.04, 0.02), silence(sampleRate, 0.4)));
    assert.deepEqual(events.map((event) => [event.type, event.utteranceId]), [["speech-start", 1], ["speech-cancel", 1]]);
  });

  test(`adapts to sustained background noise without repeated recognition at ${sampleRate} Hz`, () => {
    const events: LocalVoiceCommandAudioMessage[] = [];
    const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
    feed(segmenter, noise(sampleRate, 10, 0.006));
    assert.deepEqual(events.map((event) => [event.type, event.utteranceId]), [["speech-start", 1], ["speech-cancel", 1]]);
    const background = noise(sampleRate, 0.14, 0.006);
    const word = tone(sampleRate, 0.14, 0.03);
    for (let index = 0; index < word.length; index += 1) word[index] += background[index];
    feed(segmenter, join(word, noise(sampleRate, 0.4, 0.006)));
    assert.equal(audio(events).length, 1);
    assert.equal(audio(events)[0].utteranceId, 2);
  });
}

test("captures a word that begins as the microphone starts", () => {
  const sampleRate = 16_000;
  const word = tone(sampleRate, 0.14, 0.025);
  const events = capture(sampleRate, join(word, silence(sampleRate, 0.4)));
  assert.equal(audio(events).length, 1);
  assert.deepEqual(audio(events)[0].samples.slice(0, word.length), word);
});

test("tracks gradually rising background noise without hiding the next word", () => {
  const sampleRate = 16_000;
  const events: LocalVoiceCommandAudioMessage[] = [];
  const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
  const background = noise(sampleRate, 5, 1);
  for (let index = 0; index < background.length; index += 1) {
    background[index] *= 0.0005 + 0.005 * index / background.length;
  }
  feed(segmenter, background);
  assert.deepEqual(events, []);
  feed(segmenter, join(tone(sampleRate, 0.12, 0.03), noise(sampleRate, 0.4, 0.006)));
  assert.equal(audio(events).length, 1);
});

test("caps long utterances at three seconds and waits for an acoustic break", () => {
  const sampleRate = 16_000;
  const events: LocalVoiceCommandAudioMessage[] = [];
  const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
  const sustained = tone(sampleRate, 10, 0.03);
  for (let index = 0; index < sustained.length; index += 1) {
    sustained[index] *= 0.65 + 0.35 * Math.sin(2 * Math.PI * 3 * index / sampleRate);
  }
  feed(segmenter, join(silence(sampleRate, 0.3), sustained));
  assert.equal(audio(events).length, 1);
  assert.equal(audio(events)[0].samples.length, sampleRate * 3);
  feed(segmenter, join(silence(sampleRate, 0.3), tone(sampleRate, 0.1, 0.025), silence(sampleRate, 0.4)));
  assert.equal(audio(events).length, 2);
  assert.equal(audio(events)[1].utteranceId, 2);
});

test("returned utterances remain independent while fixed capture storage is reused", () => {
  const sampleRate = 16_000;
  const events: LocalVoiceCommandAudioMessage[] = [];
  const segmenter = new LocalVoiceCommandSegmenter(sampleRate, (event) => events.push(event));
  const recording = join(silence(sampleRate, 0.3), tone(sampleRate, 0.12, 0.02), silence(sampleRate, 0.3));
  feed(segmenter, recording);
  const first = audio(events)[0].samples.slice();
  for (let repeat = 0; repeat < 50; repeat += 1) feed(segmenter, recording);
  assert.equal(audio(events).length, 51);
  assert.deepEqual(audio(events)[0].samples, first);
  assert.ok(audio(events).every((event) => event.samples.length <= sampleRate * 3));
  assert.equal(new Set(audio(events).map((event) => event.samples.buffer)).size, 51);
});

test("rejects sample rates that cannot safely size audio buffers", () => {
  for (const sampleRate of [0, -16_000, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) {
    assert.throws(() => new LocalVoiceCommandSegmenter(sampleRate, () => {}), RangeError);
  }
});
