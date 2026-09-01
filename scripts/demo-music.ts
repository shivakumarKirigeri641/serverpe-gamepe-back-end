/**
 * The demo's background music, synthesised rather than sourced.
 *
 * A file from a library would mean a licence to track, an attribution line to
 * keep, and a dependency that can be taken down — for ninety seconds of gentle
 * backing. This is generated from arithmetic, so it is ours outright, it is
 * exactly as long as the video, and changing the mood is changing a constant.
 *
 * The sound is a music box: a plucked fundamental with two quiet harmonics and
 * an exponential decay, over a soft pad and a root bass. Written to be pleasant
 * at low volume behind captions — nothing percussive, nothing that competes
 * with reading, and no note in the range where speech would sit if narration
 * is added later.
 */

import { writeFile } from 'node:fs/promises';

const RATE = 44100;

/** Equal temperament from A4=440. `n` is semitones from middle C. */
const note = (n: number): number => 440 * Math.pow(2, (n - 9) / 12);

/**
 * C major, four chords, the oldest progression there is.
 *
 * I–vi–IV–V resolves without ever feeling final, which is what a loop needs:
 * it can go round thirteen times without the ear asking it to stop.
 */
const CHORDS: number[][] = [
  [0, 4, 7], // C
  [-3, 0, 4], // Am
  [5, 9, 12], // F
  [7, 11, 14], // G
];

/** The melody, as scale degrees over each chord. Pentatonic: no wrong notes. */
const MELODY: number[][] = [
  [12, 16, 19, 16],
  [9, 12, 16, 12],
  [17, 21, 24, 21],
  [19, 23, 26, 19],
];

/**
 * A struck tone with harmonics and an exponential decay.
 *
 * The harmonics are what stop it sounding like a test signal: a pure sine reads
 * as electronic, and the 2nd and 3rd partials at a fraction of the fundamental
 * are roughly what a struck metal tine actually produces.
 */
function pluck(buf: Float32Array, startSample: number, freq: number, seconds: number, gain: number): void {
  const total = Math.floor(seconds * RATE);
  for (let i = 0; i < total; i += 1) {
    const idx = startSample + i;
    if (idx >= buf.length) return;

    const t = i / RATE;
    const decay = Math.exp(-t * 3.2);
    // A short attack, so the note arrives rather than clicking into existence.
    const attack = Math.min(1, t / 0.008);

    const w = 2 * Math.PI * freq * t;
    const sample =
      Math.sin(w) + 0.3 * Math.sin(2 * w) + 0.12 * Math.sin(3 * w) + 0.05 * Math.sin(4 * w);

    buf[idx] += sample * decay * attack * gain;
  }
}

/** A sustained, breathing chord underneath. Slow enough to be felt, not heard. */
function pad(buf: Float32Array, startSample: number, freqs: number[], seconds: number, gain: number): void {
  const total = Math.floor(seconds * RATE);
  for (let i = 0; i < total; i += 1) {
    const idx = startSample + i;
    if (idx >= buf.length) return;

    const t = i / RATE;
    const env = Math.min(t / 0.6, 1) * Math.min((seconds - t) / 0.6, 1);
    // A slow tremolo keeps a held chord from sounding like a dial tone.
    const breath = 1 + 0.06 * Math.sin(2 * Math.PI * 0.35 * t);

    let sample = 0;
    for (const f of freqs) sample += Math.sin(2 * Math.PI * f * t);

    buf[idx] += (sample / freqs.length) * Math.max(env, 0) * breath * gain;
  }
}

/**
 * Renders `seconds` of music to a 16-bit mono WAV.
 *
 * Mono on purpose: the video is watched on phones, most of them through one
 * speaker, and a stereo image nobody hears is bytes for nothing.
 */
export async function writeDemoMusic(path: string, seconds: number): Promise<void> {
  const length = Math.ceil(seconds * RATE);
  const buf = new Float32Array(length);

  const bpm = 76;
  const beat = 60 / bpm;
  const barLength = beat * 4;

  for (let bar = 0; bar * barLength < seconds; bar += 1) {
    const chord = CHORDS[bar % CHORDS.length]!;
    const line = MELODY[bar % MELODY.length]!;
    const start = Math.floor(bar * barLength * RATE);

    pad(buf, start, chord.map((n) => note(n) / 2), barLength, 0.10);
    pluck(buf, start, note(chord[0]! - 12) / 2, barLength, 0.18);

    line.forEach((n, i) => {
      // The last phrase of each bar is quieter — a small rise and fall, so a
      // loop played thirteen times has some shape to it.
      const gain = 0.16 * (i === line.length - 1 ? 0.7 : 1);
      pluck(buf, start + Math.floor(i * beat * RATE), note(n), beat * 1.9, gain);
    });
  }

  // Fade in over the title card, out under the end card.
  const fade = Math.floor(2.5 * RATE);
  for (let i = 0; i < fade; i += 1) {
    const g = i / fade;
    buf[i]! *= g;
    buf[length - 1 - i]! *= g;
  }

  // 16-bit PCM, with a soft limiter rather than a hard clip: arithmetic can
  // overshoot when a pluck lands on a pad peak, and clipping is audible.
  const data = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i += 1) {
    const x = Math.tanh(buf[i]! * 1.1);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  await writeFile(path, Buffer.concat([header, data]));
}
