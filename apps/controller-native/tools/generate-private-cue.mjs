import { writeFileSync } from "node:fs";

// A short, deterministic pulse that can be pitch-shifted into private game information. Keeping
// the source local avoids a network fetch and makes the app useful in a genuinely offline room.
const sampleRate = 22_050;
const durationSeconds = 0.16;
const sampleCount = Math.round(sampleRate * durationSeconds);
const dataBytes = sampleCount * 2;
const wav = Buffer.alloc(44 + dataBytes);

wav.write("RIFF", 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); // PCM
wav.writeUInt16LE(1, 22); // mono
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(dataBytes, 40);

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const progress = index / sampleCount;
  const envelope = Math.sin(Math.PI * progress) ** 2;
  const frequency = 520 + progress * 180;
  const fundamental = Math.sin(2 * Math.PI * frequency * time);
  const overtone = Math.sin(2 * Math.PI * frequency * 2 * time) * 0.18;
  const sample = Math.max(-1, Math.min(1, (fundamental + overtone) * envelope * 0.48));
  wav.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
}

writeFileSync(new URL("../assets/private-cue.wav", import.meta.url), wav);
