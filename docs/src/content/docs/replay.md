---
title: Instant Replay
description: Keep a rolling buffer of a player's game view and save the last few seconds on demand.
---

Instant replay keeps the last few seconds of a player's game view in the player's NUI memory. Nothing is sent anywhere until your server calls `saveReplay`, which cuts the most recent seconds out of the buffer and delivers them as a WebM file. Use it to review what a player was doing just before an event, for example a kill.

Replay is experimental, like [video capture](/video/). Clips are the same WebM (VP9) format, are delivered through the same chunked upload path, and end up in `screencapture/tmp/` or at a remote URL.

## Quick Start

```lua
-- Once, when the player is in game (use your framework's "player loaded" hook).
exports.screencapture:startReplayBuffer(source, { bufferSeconds = 30 })

-- Later, from your own kill handler. `killer` is the server id of the player to review.
local function reviewKill(killer)
    exports.screencapture:saveReplay(killer, { seconds = 5 }, function(result)
        if result.status ~= 'success' then
            print(('Replay failed: %s'):format(result.error))
            return
        end

        print(('Replay saved to %s'):format(result.filePath))
    end)
end
```

The clip ends when the player receives the request, so it shows the moments leading up to the call. Call `saveReplay` from a `SetTimeout` if you also want a few seconds after the event.

## `startReplayBuffer(source, options)`

Starts the buffer for a player and returns `true` if the request was sent. Calling it again for a player whose buffer is running does nothing. To change options, call `stopReplayBuffer` first.

| Field | Type | Default | Max | Description |
| --- | --- | --- | --- | --- |
| `bufferSeconds` | `number` | `30` | `120` | How much footage to keep. |
| `maxWidth` | `number` | `1280` | `1920` | Maximum capture width in pixels. |
| `maxHeight` | `number` | `720` | `1080` | Maximum capture height in pixels. |
| `frameRate` | `number` | `20` | `30` | Frames per second. |
| `indicator` | `boolean` | `true` | | Show a small `REPLAY BUFFER / VIDEO ONLY` indicator to the player. |

## `saveReplay(source, options, callback)`

Saves the most recent footage from a player's buffer and returns a `captureId`. The callback receives a [`VideoCaptureResult`](/video/#video-result) once the file is complete, or an error result if it could not be saved.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `seconds` | `number` | `10` | How much of the most recent footage to save. |
| `url` | `string` | | Upload the clip to this URL instead of keeping a local file. |
| `headers` | `object` | `{}` | HTTP headers for the upload. |
| `formField` | `string` | `'file'` | FormData field name for the upload. |
| `filename` | `string` | `'recording'` | Upload file name. `.webm` is appended. |

Without `url`, the result has a `filePath` in `screencapture/tmp/` and the caller is responsible for the file. With `url`, the temp file is deleted after the upload and the result has the remote `response`. Remote uploads use the same server identity headers and `screencapture_upload_identity_headers` opt-out as other uploads.

A save fails with an error result if the player has no buffer, another save for that player is still in progress, or the clip has not fully arrived after two minutes.

```lua
exports.screencapture:saveReplay(source, {
    seconds = 8,
    url = 'https://api.fivemanage.com/api/v3/file',
    headers = { ['Authorization'] = 'your-api-key' },
    filename = 'kill-review',
}, function(result)
    if result.status == 'success' then
        print(result.response.data.url)
    end
end)
```

## `stopReplayBuffer(source)` and `isReplayBufferActive(source)`

`stopReplayBuffer(source)` stops the buffer and discards its footage. `isReplayBufferActive(source)` returns whether a buffer was started for the player. Buffers are also cleared when the player drops.

## Clip Length

Clips are cut on keyframes, which the buffer creates once per second. A clip therefore covers at least `seconds` and up to one second more. The buffer itself holds `bufferSeconds` plus up to two seconds.

The first seconds after a buffer starts have nothing to save yet. Saving then returns what exists, or fails with a timeout error if no footage has been produced at all.

The clip keeps the buffer's timeline, so its first frame is not at 0 seconds. Players and ffmpeg handle this. If your tooling needs a zero-based timeline, remux the file with ffmpeg.

## Performance

The buffer runs a continuous realtime VP9 encode of the game view, so it has a cost for every player who has one running:

- The game view is redrawn at most `frameRate` times per second instead of on every animation frame.
- Memory is roughly the encoded bitrate times `bufferSeconds`. At the defaults (1280x720, 20 fps) that is about 1.3 Mbit/s, or around 5 MB for a 30 second buffer.
- Bitrate scales with resolution and frame rate, so `1920x1080` at `30` fps costs several times more than the defaults.

This has not been measured across hardware. Enable it for a few players first, watch client frame times, and lower `frameRate`, `maxWidth` and `maxHeight` before lowering anything else.

## Interaction With Other Captures

A player with a running buffer cannot start `startVideoCapture`, `startVideoCaptureUpload` or `startLiveStream`. Those calls fail with a message telling you to call `stopReplayBuffer` first. Stop the buffer, run the capture, then start the buffer again.

## Privacy

The buffer records only the game view, never the desktop or any audio. Footage stays in the player's NUI memory and leaves it only when `saveReplay` is called. The indicator is on by default; setting `indicator = false` hides it, so tell your players that replay buffering is active, the same way you would for any other anti-cheat tooling.
