# The browser decode pipeline (Claudifer viewer)

| File | What it is |
|---|---|
| `viewer.js` | `CameraGrid`, `CameraPane`: layouts, the full-motion budget, tier switching, zoom, stream quality |
| `webcodecsClient.js` | WebSocket + WebCodecs decode, the playout clock, audio |
| `audioWorkletProcessor.js` | Off-main-thread PCM FIFO for audio output |

The server side of the wire protocol is `server/protocol.js`. Keep the two in
step: every binary message's layout is documented in both.

## Render tiers

A pane runs as **full motion** (`WebCodecsClient`: H.264/HEVC decoded by
WebCodecs, plus audio) or as a **thumbnail** (`ThumbnailClient`: JPEG frames
over the same socket, no decoder). `maxFullMotionPanes` caps how many full-motion
panes a page runs. They are ranked focused pane first, then rendered size;
the rest become thumbnails. A tier change is bridged: the old picture stays up
until the new one has painted.

`new CameraGrid({ fullMotion: false })` is all-thumbnail. Pages use it when
the browser has no WebCodecs (a plain-HTTP page on a LAN address, or an old
browser).

## Latency

- **Playout:** decoded frames are scheduled against a clock anchored on the
  first chunk, with a `bufferMs` jitter buffer (default 150).
- **Live-edge join:** on subscribe, the server replays its cached GOP with
  `FLAG_CATCHUP`. Each such chunk re-anchors the clock, so playback starts at
  the newest frame.
- **Latency guard (`_guardLatency`):** every 2 s it takes the smallest "time
  until due" seen.
  - Far above `bufferMs`: latency has crept in, so the clock is pulled back.
  - Well below zero: frames arrive late, so the clock is pushed out by half a
    buffer.
- **Backlog shedding:** a decoder queue over 40 chunks drops input until the
  next keyframe. A pane under sustained pressure falls back to the substream.

## Audio

- **Opus:** decoded by `AudioDecoder` where it exists (Chrome, Edge, Firefox,
  Safari 26+).
- **PCM:** Safari before 26 (every iPad 6th gen) has `VideoDecoder` but no
  `AudioDecoder`. It subscribes with `audio:'pcm'` and receives 16 kHz G.711
  mu-law (`AUDIO_PCM`), which is decoded and resampled here.
- **Output:** both paths feed a persistent AudioWorklet → gain → the
  page-wide `AudioContext`.
- **Many at once:** any number of panes can be audible together; their
  graphs mix in the shared context (see `test/features.js`).
  - **Focused pane:** heard when the master is unmuted (`setFocusedCamera`).
  - **Pane speakers:** each pane's own speaker (`grid.setPaneAudio(id, on)`)
    adds that pane at the master volume, regardless of the master mute. An
    audible pane is pinned to full motion.
  - **Clearing:** `grid.clearPaneAudio()` switches every pane speaker off
    (hosts call it on master mute).
  - **Host hook:** `grid.onFocalMuteRequest` is called when the focused
    pane's own speaker is clicked off, so the host can mute its master.
- **Muted panes are not sent audio:** `setMuted()` tells the server.
- **iOS unlock:** happens on touchend/pointerup, and
  `navigator.audioSession.type = 'playback'` keeps the ringer switch from
  muting it.

## Zoom

- **Mouse:** the wheel zooms toward the cursor (trackpad pinch too).
- **Touch:** two fingers pinch about their midpoint.
- **Pan:** drag or one finger, once zoomed.
- **Storage:** zoom is kept as fractions of the pane, so a resize keeps the
  same region.
- **Reset:** the badge resets it. So does any change of position:
  featured-slot swaps, drag-drop, the wall putting a new camera in its main
  pane, and fullscreen single-camera focus.

## Stream quality

`main` is High and `sub` is Low. They are decided per pane in this order:

1. **Decoder overload:** forced Low.
2. **The pane's HQ/LQ button:** `grid.setPaneQuality(id, 'main'|'sub'|null)`,
   remembered per browser.
3. **The view override:** `grid.setQualityOverride('main'|'sub'|null)`.
4. **The server policy:** `grid.qualityPolicy` = `'sub'` (default) |
   `'fullscreen'` | `'large'` (≥ `mainMinWidth` device pixels) | `'main'`.

## No picture

Both clients report `onStatus('problem', { kind, since, text })` when the
server sends `STREAM_PROBLEM` (why there is no video: `network`,
`network-down`, `no-video`, `camera`, or `clear`). `since` is placed on this
device's clock from the age the server sends, so a skewed server clock
doesn't matter. They also report `'subscribed'` once connected to the server.

`CameraPane` turns that into a cover over the dimmed last frame
(`.stream-problem`, "No video since 2:03 AM") and removes it on the next
`'streaming'`. If the socket to the server stays closed for 10 s, the pane
shows its own cover ("Lost the connection to LookyLooky"), and `'subscribed'`
removes it. Thumbnail panes get `STREAM_PROBLEM` too: they receive no
`STREAM_ERROR`.

## Hardware decode

Chromium treats `hardwareAcceleration: 'prefer-hardware'` as a requirement,
so the client asks `isConfigSupported` once per codec. It uses
`no-preference` (software allowed) where hardware is not available. Chunks
that arrive during that check are held, so no keyframe is lost.
