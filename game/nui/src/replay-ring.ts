// Minimum cluster length the muxer is configured with. Keyframes arrive at least this often, and a new cluster only
// starts on a keyframe, so every finalized cluster is at least this long.
export const CLUSTER_SECONDS = 1;

type Write = { position: number; data: Uint8Array };
type Cluster = { position: number; timestamp: number };

// Rolling window over an append-only WebM byte stream.
//
// Every write is kept together with the byte offset of each finalized cluster. Matroska clusters begin on
// keyframes, so a clip cut at a cluster boundary plays on its own once the file header is put in front of it.
export class ReplayRing {
  #header: Uint8Array[] = [];
  #writes: Write[] = [];
  #clusters: Cluster[] = [];
  #maxSeconds: number;

  constructor(maxSeconds: number) {
    this.#maxSeconds = maxSeconds;
  }

  addHeader(data: Uint8Array): void {
    this.#header.push(data);
  }

  addWrite(position: number, data: Uint8Array): void {
    this.#writes.push({ position, data });
  }

  // Called when a cluster is finalized, i.e. when the next one starts.
  addCluster(position: number, timestamp: number): void {
    this.#clusters.push({ position, timestamp });

    // Keep one cluster at or before the horizon so the buffer never holds less than `maxSeconds`.
    const horizon = timestamp - this.#maxSeconds;
    while (this.#clusters.length > 1 && this.#clusters[1].timestamp <= horizon) this.#clusters.shift();

    const keepFrom = this.#clusters[0].position;
    while (this.#writes.length > 1 && this.#writes[1].position <= keepFrom) this.#writes.shift();
  }

  // File header + everything from a keyframe cluster through to the cluster that is still being written, so the clip
  // covers at least `seconds` (and less than `seconds` + CLUSTER_SECONDS more). Null until one cluster is finalized.
  clip(seconds: number): Uint8Array[] | null {
    const newest = this.#clusters[this.#clusters.length - 1];
    if (!newest) return null;

    // The open cluster starts at least CLUSTER_SECONDS after the newest finalized one, which counts toward the clip.
    let start = this.#clusters[0];
    for (const cluster of this.#clusters) {
      if (cluster.timestamp <= newest.timestamp + CLUSTER_SECONDS - seconds) start = cluster;
    }

    const tail = this.#writes
      .filter((write) => write.position + write.data.byteLength > start.position)
      .map((write) => write.data.subarray(Math.max(0, start.position - write.position)));

    return [...this.#header, ...tail];
  }
}
