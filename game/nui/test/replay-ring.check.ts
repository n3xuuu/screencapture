// Run: node game/nui/test/replay-ring.check.ts   (Node 23.6+ strips types natively)
import assert from 'node:assert/strict';
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny';
import type { StreamTargetChunk } from 'mediabunny';
import { CLUSTER_SECONDS, ReplayRing } from '../src/replay-ring.ts';

const FPS = 20;
const SECONDS = 20;
const BUFFER_SECONDS = 8;

// Same wiring as ReplayBuffer, but fed with synthetic packets (a keyframe every second).
const ring = new ReplayRing(BUFFER_SECONDS);
const output = new Output({
  format: new WebMOutputFormat({
    appendOnly: true,
    minimumClusterDuration: CLUSTER_SECONDS,
    onEbmlHeader: (data) => ring.addHeader(data),
    onSegmentHeader: (data) => ring.addHeader(data),
    onCluster: (_data, position, timestamp) => ring.addCluster(position, timestamp),
  }),
  target: new StreamTarget(
    new WritableStream<StreamTargetChunk>({ write: (chunk) => ring.addWrite(chunk.position, chunk.data) }),
  ),
});
const source = new EncodedVideoPacketSource('vp9');
output.addVideoTrack(source);
await output.start();

const meta = { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 1280, codedHeight: 720 } };
for (let i = 0; i < FPS * SECONDS; i++) {
  const key = i % FPS === 0;
  const data = new Uint8Array(key ? 4000 : 400).fill(i % 251);
  await source.add(new EncodedPacket(data, key ? 'key' : 'delta', i / FPS, 1 / FPS), i === 0 ? meta : undefined);
}
// Deliberately not finalized: the newest cluster is still open, exactly like a live buffer.
await new Promise((resolve) => setTimeout(resolve, 20));

async function readClip(seconds: number) {
  const parts = ring.clip(seconds);
  assert.ok(parts, 'clip should exist');

  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  const track = await new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }).getPrimaryVideoTrack();
  assert.ok(track, 'clip should contain a video track');

  const packets: EncodedPacket[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  return { packets, size: bytes.byteLength };
}

const lastTimestamp = (SECONDS * FPS - 1) / FPS;

for (const seconds of [1, 3, 5]) {
  const { packets } = await readClip(seconds);
  const span = lastTimestamp - packets[0].timestamp;

  assert.equal(packets[0].type, 'key', `${seconds}s clip must start on a keyframe`);
  assert.equal(packets.at(-1)!.timestamp, lastTimestamp, `${seconds}s clip must include the still-open cluster`);
  assert.ok(span >= seconds, `${seconds}s clip is too short (${span}s)`);
  assert.ok(span < seconds + 2, `${seconds}s clip carries too much extra (${span}s)`);
}

// Asking for more than the buffer holds returns the whole buffer, which was trimmed to ~BUFFER_SECONDS.
const everything = await readClip(1000);
const held = lastTimestamp - everything.packets[0].timestamp;
assert.ok(held >= BUFFER_SECONDS && held < BUFFER_SECONDS + 3, `buffer holds ${held}s, expected ~${BUFFER_SECONDS}s`);
assert.ok(everything.size < 8 * FPS * 4000, 'buffer bytes should be bounded');

console.log(`ok: clips start on keyframes, include the live tail, buffer trimmed to ${held}s`);
