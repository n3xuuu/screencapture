import { createServer } from './koa-router';
import './export';
import { UploadStore } from './upload-store';
import { LiveStreamStore } from './live-store';
import { checkForUpdates } from './version-checker';

export const uploadStore = new UploadStore();
export const liveStreamStore = new LiveStreamStore();

import { registerImageHandlers } from './image';
import { registerStreamHandlers } from './stream';
import { registerLiveStreamHandlers } from './live';
import { registerReplayHandlers } from './replay';

async function boot() {
  void checkForUpdates();
  createServer(uploadStore);
  registerImageHandlers();
  registerStreamHandlers();
  registerLiveStreamHandlers();
  registerReplayHandlers();
}

boot();
