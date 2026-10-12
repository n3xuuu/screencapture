// Players whose NUI has been told to keep a replay buffer. The footage itself stays on the client until saved.
export const replaySources = new Set<number>();

export function registerReplayHandlers(): void {
  on('playerDropped', () => {
    replaySources.delete(global.source);
  });
}
