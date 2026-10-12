import type { StreamTargetChunk } from 'mediabunny';

// 1mb fivem constraint
export const CHUNK_SIZE = 800 * 1024;

type UploadWritableOptions = {
  uploadToken: string;
  serverEndpoint?: string;
  callbackUrl?: string;
  finalizeCallbackUrl?: string;
};

async function assertCallbackResponse(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${context} failed: ${response.status}`);
  }

  const result = await response.json().catch(() => true);
  if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
    throw new Error(`${context} failed: ${result.error ?? 'Unknown error'}`);
  }
}

function createHttpWritableStream(uploadToken: string, serverEndpoint: string): WritableStream<StreamTargetChunk> {
  return new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      const response = await fetch(`${serverEndpoint}/stream-chunk/${uploadToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk.data,
      });

      if (!response.ok) {
        throw new Error(`Chunk upload failed: ${response.status}`);
      }
    },

    async close() {
      await fetch(`${serverEndpoint}/stream-finalize/${uploadToken}`, {
        method: 'POST',
      });
    },
  });
}

function createNuiWritableStream(
  uploadToken: string,
  callbackUrl: string,
  finalizeCallbackUrl: string,
): WritableStream<StreamTargetChunk> {
  return new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      const bytes = chunk.data instanceof ArrayBuffer
        ? new Uint8Array(chunk.data)
        : new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);

      const BATCH = 8192;
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += BATCH) {
        const end = Math.min(i + BATCH, bytes.length);
        parts.push(String.fromCharCode(...bytes.subarray(i, end)));
      }
      const base64Data = btoa(parts.join(''));

      const response = await fetch(callbackUrl, {
        method: 'POST',
        body: JSON.stringify({ token: uploadToken, data: base64Data }),
        headers: { 'Content-Type': 'application/json' },
      });

      await assertCallbackResponse(response, 'NUI chunk callback');
    },

    async close() {
      const response = await fetch(finalizeCallbackUrl, {
        method: 'POST',
        body: JSON.stringify({ token: uploadToken }),
        headers: { 'Content-Type': 'application/json' },
      });

      await assertCallbackResponse(response, 'NUI finalize callback');
    },
  });
}

// Chunks go to the server over HTTP, or through the client script when the `nui` protocol is configured.
export function createUploadWritable(options: UploadWritableOptions): WritableStream<StreamTargetChunk> {
  const { uploadToken, serverEndpoint, callbackUrl, finalizeCallbackUrl } = options;

  return callbackUrl
    ? createNuiWritableStream(uploadToken, callbackUrl, finalizeCallbackUrl!)
    : createHttpWritableStream(uploadToken, serverEndpoint!);
}
