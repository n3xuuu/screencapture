import { captureSessionCoordinator } from './capture-session-coordinator';
import { GameMediaSource } from './game-media-source';
import { CLUSTER_SECONDS, ReplayRing } from './replay-ring';
import { CHUNK_SIZE, createUploadWritable } from './stream-writable';
import { ReplayActions } from './types';
import { MediaStreamVideoTrackSource, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import type { StreamTargetChunk } from 'mediabunny';

const LEASE_ID = 'replay-buffer';
// Bitrate follows resolution and frame rate: 1280x720 at 20fps is roughly 1.3 Mbit/s.
const BITS_PER_PIXEL = 0.07;

type ReplayStartRequest = {
  action: ReplayActions.Start;
  bufferSeconds?: number;
  maxWidth?: number;
  maxHeight?: number;
  frameRate?: number;
  indicator?: boolean;
};

type ReplayStopRequest = { action: ReplayActions.Stop };

type ReplaySaveRequest = {
  action: ReplayActions.Save;
  seconds: number;
  uploadToken: string;
  serverEndpoint?: string;
  callbackUrl?: string;
  finalizeCallbackUrl?: string;
};

// Keeps the last `bufferSeconds` of the game view in memory. Nothing leaves the client until a save is requested.
export class ReplayBuffer {
  #gameMediaSource = new GameMediaSource();
  #ring: ReplayRing | null = null;
  #output: Output | null = null;
  #videoSource: MediaStreamVideoTrackSource | null = null;
  #indicator: HTMLDivElement | null = null;

  start() {
    window.addEventListener('message', (event) => {
      const data = event.data as ReplayStartRequest | ReplayStopRequest | ReplaySaveRequest;

      if (data.action === ReplayActions.Start) {
        this.begin(data).catch((error) => console.error('[screencapture] failed to start replay buffer:', error));
      }

      if (data.action === ReplayActions.Stop) {
        void this.stop();
      }

      if (data.action === ReplayActions.Save) {
        this.save(data).catch((error) => console.error('[screencapture] failed to save replay:', error));
      }
    });
  }

  private async begin(request: ReplayStartRequest) {
    // Already running: stop it first to change the options.
    if (this.#output) return;

    // ponytail: the buffer holds the one capture lease, so it excludes recording and live. Pause/resume it around them if admins need both.
    if (!captureSessionCoordinator.acquire('replay', LEASE_ID)) {
      console.error('[screencapture] another video capture session is already active');
      return;
    }

    const ring = new ReplayRing(request.bufferSeconds ?? 30);
    const frameRate = request.frameRate ?? 20;

    try {
      this.#ring = ring;
      this.#output = new Output({
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

      const mediaStream = await this.#gameMediaSource.start({
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight,
        frameRate,
        throttleRender: true,
      });
      const videoTrack = mediaStream.getVideoTracks()[0];
      const { width, height } = this.#gameMediaSource.size;

      this.#videoSource = new MediaStreamVideoTrackSource(videoTrack, {
        codec: 'vp9',
        bitrate: Math.round(width * height * frameRate * BITS_PER_PIXEL),
        // Clusters start on keyframes, so this sets how finely a clip can be cut.
        keyFrameInterval: CLUSTER_SECONDS,
      });

      this.#videoSource.errorPromise.catch((error) => {
        console.error('[screencapture] replay buffer encoder error:', error);
        void this.stop();
      });

      this.#output.addVideoTrack(this.#videoSource);
      await this.#output.start();

      if (request.indicator !== false) this.showIndicator();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async save(request: ReplaySaveRequest) {
    const parts = this.#ring?.clip(request.seconds);
    if (!parts) {
      console.error('[screencapture] replay buffer has no footage to save yet');
      return;
    }

    const clip = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      clip.set(part, offset);
      offset += part.byteLength;
    }

    const writer = createUploadWritable(request).getWriter();
    for (let position = 0; position < clip.byteLength; position += CHUNK_SIZE) {
      await writer.write({ type: 'write', data: clip.subarray(position, position + CHUNK_SIZE), position });
    }
    await writer.close();
  }

  async stop() {
    const output = this.#output;

    this.#gameMediaSource.stop();
    this.#videoSource?.close();
    this.#indicator?.remove();

    this.#output = null;
    this.#videoSource = null;
    this.#indicator = null;
    this.#ring = null;

    // The buffered bytes are not needed after a stop, so skip the flush that finalize() would do.
    if (output && output.state !== 'canceled' && output.state !== 'finalized') {
      await output.cancel().catch((error) => console.error('[screencapture] replay buffer cancel error:', error));
    }

    captureSessionCoordinator.release('replay', LEASE_ID);
  }

  private showIndicator() {
    this.#indicator = document.createElement('div');
    this.#indicator.className = 'live-stream-indicator';
    this.#indicator.dataset.state = 'live';
    this.#indicator.setAttribute('role', 'status');
    this.#indicator.textContent = 'REPLAY BUFFER / VIDEO ONLY';
    document.body.append(this.#indicator);
  }
}
