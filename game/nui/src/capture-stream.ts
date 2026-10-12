import { CaptureStreamActions } from './types';
import { captureSessionCoordinator } from './capture-session-coordinator';
import { GameMediaSource } from './game-media-source';
import { CHUNK_SIZE, createUploadWritable } from './stream-writable';
import { Output, WebMOutputFormat, StreamTarget, MediaStreamVideoTrackSource, QUALITY_MEDIUM } from 'mediabunny';

type CaptureStreamHttpRequest = {
  action: CaptureStreamActions;
  captureId?: string;
  uploadToken: string;
  serverEndpoint: string;
  callbackUrl?: never;
  finalizeCallbackUrl?: never;
  maxWidth?: number;
  maxHeight?: number;
  duration?: number;
};

type CaptureStreamNuiRequest = {
  action: CaptureStreamActions;
  captureId?: string;
  uploadToken: string;
  serverEndpoint?: never;
  callbackUrl: string;
  finalizeCallbackUrl: string;
  maxWidth?: number;
  maxHeight?: number;
  duration?: number;
};

type CaptureStreamRequest = CaptureStreamHttpRequest | CaptureStreamNuiRequest;

export class CaptureStream {
  #gameMediaSource = new GameMediaSource();
  #output: Output | null = null;
  #videoSource: MediaStreamVideoTrackSource | null = null;
  #mediaStream: MediaStream | null = null;
  #durationTimeout: ReturnType<typeof setTimeout> | null = null;
  #captureId: string | null = null;
  #leaseId: string | null = null;
  #stopping = false;

  start() {
    window.addEventListener('message', async (event) => {
      const data = event.data as CaptureStreamRequest;

      if (data.action === CaptureStreamActions.Start) {
        try {
          await this.stream(data);
        } catch (error) {
          console.error('[screencapture] failed to start video capture:', error);
        }
      }

      if (data.action === CaptureStreamActions.Stop) {
        if (data.captureId && this.#captureId && data.captureId !== this.#captureId) {
          return;
        }

        await this.stop();
      }
    });

    window.addEventListener('resize', () => {
      this.#gameMediaSource.resize();
    });
  }

  async stream(request: CaptureStreamRequest) {
    if (this.#output || this.#gameMediaSource.active || this.#mediaStream) {
      console.error('[screencapture] video capture is already active');
      return;
    }

    const leaseId = request.captureId ?? 'capture-stream';
    if (!captureSessionCoordinator.acquire('recording', leaseId)) {
      console.error('[screencapture] another video capture session is already active');
      return;
    }

    this.#captureId = request.captureId ?? null;
    this.#leaseId = leaseId;
    this.#stopping = false;

    try {
      this.#output = new Output({
        format: new WebMOutputFormat({ appendOnly: true }),
        target: new StreamTarget(createUploadWritable(request), { chunked: true, chunkSize: CHUNK_SIZE }),
      });

      this.#mediaStream = await this.#gameMediaSource.start({
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight,
        frameRate: 30,
      });
      const videoTrack = this.#mediaStream.getVideoTracks()[0];

      this.#videoSource = new MediaStreamVideoTrackSource(videoTrack, {
        codec: 'vp9',
        bitrate: QUALITY_MEDIUM,
      });

      this.#videoSource.errorPromise.catch((err) => {
        console.error('[screencapture] video encoder error:', err);
      });

      this.#output.addVideoTrack(this.#videoSource);
      await this.#output.start();

      if (request.duration && request.duration > 0) {
        this.#durationTimeout = setTimeout(() => {
          this.stop().catch((err) => {
            console.error('[screencapture] error stopping stream after duration timeout:', err);
          });
        }, request.duration * 1000);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this.#stopping) return;
    this.#stopping = true;

    if (this.#durationTimeout) {
      clearTimeout(this.#durationTimeout);
      this.#durationTimeout = null;
    }

    this.#gameMediaSource.stop();

    if (this.#videoSource) {
      this.#videoSource.close();
    }

    // Flush remaining encoded frames
    if (this.#output && this.#output.state === 'started') {
      try {
        await this.#output.finalize();
      } catch (err) {
        console.error('[screencapture] finalize error:', err);
      }
    }

    this.#output = null;
    this.#videoSource = null;
    this.#mediaStream = null;
    this.#captureId = null;

    if (this.#leaseId) {
      captureSessionCoordinator.release('recording', this.#leaseId);
      this.#leaseId = null;
    }

    this.#stopping = false;
  }
}
