# LookyLooky — notes for Claude Code

LookyLooky is a single-container network camera relay. It pulls RTSP/HTTP IP
cameras with FFmpeg and plays them in browsers at low latency over WebCodecs.
The browser viewer/dashboard is called **Claudifer**, and the page message bus
is **noodleman**. The owner runs it in **Docker Desktop on Windows 11**. The
viewers are iPads (including an **iPad 6th gen on iPadOS 17**), desktop
Chrome/Edge, and a game-master screen built on the camera wall. The owner is
new to Docker: explain Docker steps plainly and give exact commands.

## Commands

| What | Command |
|---|---|
| Set up / update everything on Windows (idempotent) | `powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1 [-ConfigFrom <folder>] [-SkipTests]` |
| Real instance: start / rebuild | `docker compose up -d --build` |
| Real instance: logs | `docker compose logs -f` |
| Throwaway dev instance (ports 18080/18443, test pattern only) | `npm run dev:up` / `npm run dev:down` |
| Browser tests (against the dev instance) | `npm ci && npx playwright install chromium && npm test` |
| Run the server without Docker (needs ffmpeg on PATH) | `LOOKY_DATA_DIR=./data node server/index.js` |

**Never run `test/*.js` against the real instance** (ports 8080/8443). The
tests create cameras and layouts. Use `docker-compose.dev.yml`.

Per-machine settings (LAN IP for the certificate, time zone, admin password)
live in `docker-compose.override.yml`. It is git-ignored, and
`scripts/dev-setup.ps1` writes it.

## Layout

```
server/index.js           HTTP :8080 + HTTPS :8443 (HTTPS port also answers plain HTTP with a redirect), static, boot/seed
server/stream-session.js  one FFmpeg per camera variant: 3 pipes (fMP4 video copy, fMP4 Opus, raw mu-law PCM),
                          GOP cache for live-edge join, per-viewer GOP-aware backpressure (1013 kick), restart/backoff,
                          stall watchdog, make-before-break daily recycle, UDP→TCP fallback, slow-probe retry
server/fmp4.js            streaming fragmented-MP4 parser (avcC/hvcC → WebCodecs description, dOps)
server/protocol.js        binary wire protocol — MUST match public/js/camera/webcodecsClient.js
server/ws-server.js       /cameras/stream: subscribe {cameraId, quality, audio:'opus'|'pcm'|'none', audioEnabled}, thumbs, audio gating
server/mjpeg.js           thumbnails/MJPEG/snapshots decoded from the running session's fMP4 (no extra camera connection)
server/cameras.js         camera list/status, sessions, keep-warm, recycle, stray reaping, probing
server/api.js             REST API (see README)    server/config.js  persistence, defaults, XML/JSON import parsers
server/sources.js         FFmpeg input args per URL type, HTTP session-cookie login, friendly error messages
server/recordings.js  onvif.js  scan.js  probe.js  tls.js (local CA)  legacy-proxy.js (camera-proxy endpoints)
public/js/camera/         viewer.js (CameraGrid/CameraPane: tiers, budget, zoom, quality, per-pane audio),
                          webcodecsClient.js, audioWorkletProcessor.js — see public/js/camera/README.md
public/js/widgets/camera-wall.js   the wall widget (story mode via noodleman, or fixed layout)
public/js/noodleman.js    message bus (+ postMessage / BroadcastChannel bridges)
public/js/compat.js       Fullscreen shim (iPad prefixed, iPhone emulated), capability detection, HTTPS redirect, banner
public/cameras.html  camera-view.html  wall.html  setup.html  index.html  camera-1.html
public/styles/camera-viewer.css    full-page styles; camera-wall.css is the SAME rules scoped under .claudifer-wall —
                                   change both together
config/                   first-boot seed. Real cameras.xml / camera-layouts.xml contain camera passwords: git-ignored,
                          never commit them. Only *.example.xml are tracked.
test/e2e.js               browser smoke test     test/features.js  multi-audio, zoom, quality, per-pane speakers
```

## Rules

- **Naming:** the system is LookyLooky, the viewer/dashboard is Claudifer,
  and the bus is noodleman. Do not introduce any other product or
  predecessor names in code, comments, docs, CSS classes, globals or storage
  keys.
- **No secrets in git:** `git grep` for camera hostnames/passwords before
  pushing. Real configs come from the owner's local `config/`.
- **Two-sided protocol:** a change to a binary message touches both
  `server/protocol.js` and `webcodecsClient.js`, with the layout comment in
  each.
- **`.ps1` scripts must run on Windows PowerShell 5.1:**
  - no `??`, `?.` or ternaries;
  - ASCII only;
  - native-command stderr redirection only inside the `Capture` / `ExitCode`
    helpers (5.1 turns it into terminating errors).
- **Git workflow:** branch and open a pull request. The owner merges. Do not
  push to `main` directly.
- **Theme:** orange accent `#f2711c` (`--accent`) on the dark palette.

## Things that look wrong but are deliberate (don't "fix" them)

- **No `-fflags +nobuffer` on inputs or the MJPEG decoder.** It throws away
  the packets read while probing; the first is the keyframe, which costs a
  whole GOP (1–4 s, measured 2 s) on every start. The probe burst it avoids
  is absorbed by the client's catch-up re-anchor and latency guard.
- **Opus and video come out of separate pipes.** One muxer interleaving both
  adds latency whenever one stream stalls.
- **Timestamps are re-based onto the server's monotonic clock per pipeline.**
  That makes restarts and the make-before-break recycle seamless for the
  client's playout clock.
- **`prefer-hardware` is probed with `isConfigSupported` first.** Chromium
  treats it as *required*; without the probe, PCs with no hardware decoder
  fail every configure. Chunks are held during the probe so the first
  keyframe isn't lost.
- **`CameraGrid.destroyAll()` keeps the grid's listeners; `destroy()`
  removes them.** The dashboard reuses the grid after `destroyAll()` on every
  layout switch.
- **Safari before 26 (iPad 6th gen) has `VideoDecoder` but no
  `AudioDecoder`.** Such clients subscribe with `audio:'pcm'` and get 16 kHz
  mu-law. Don't gate the video tier on `AudioDecoder`.
- **The audio unlock listens to `touchend`/`pointerup`.** iOS does not count
  `touchstart` as activation.
- **RTSP over UDP falls back to TCP automatically.** Docker Desktop's bridged
  network blocks the UDP return path, and host networking isn't an option on
  Windows.
- **Zoom state is stored as fractions of the pane**, so resizes keep the
  region. It resets whenever a pane changes position (featured swap,
  drag-drop, wall main change, fullscreen focus).
- **Quality precedence:** decoder overload, then pane HQ/LQ button, then
  view override, then server policy (default `'sub'`, substreams only).
- **Audio:**
  - One focused pane follows the master mute/volume.
  - Pane speakers add more, at master volume, ignoring the master mute.
  - Master mute clears pane speakers.
  - Clicking the focused pane's speaker off calls `onFocalMuteRequest`
    (= master mute).
  - Pane speakers are not persisted.

## Verified in a Linux cloud session (Docker Engine, not Docker Desktop)

- **Docker build:** the Dockerfile builds unchanged (`node:22-alpine`,
  FFmpeg 8.1.3, Node 22). `test/e2e.js` 13/13 and `test/features.js` 22/22
  pass against the dev compose instance.
- **`%21` in RTSP passwords (cam-29 to cam-34):** FFmpeg URL-decodes the
  credentials itself, for both Digest and Basic auth (checked against a fake
  RTSP server expecting `pa!ss` from `pa%21ss`). Don't decode them in
  `sources.js`: that would break passwords containing a literal `%`.
- **The owner's real config imports:** 35 cameras, 7 layouts. cam-28 has only
  a `main` variant.
- **UDP→TCP fallback fires** (`no picture over UDP — switching this stream to
  TCP` for Lobby1). The camera itself was unreachable from the cloud.
- **`scripts/dev-setup.ps1` parses** (PowerShell 7 parser) and is ASCII only.
  It has not been executed on Windows.

Reading `/api/cameras`: `status: running` means *enabled*, not *connected*.
Streams start on demand, and `lastError` only shows while a stream is
retrying (someone is watching it). To check a camera, open it, or fetch
`/stream/<id>/snapshot` (504 with a reason after 12 s if it can't connect).

## Not verified yet (do these first on the owner's hardware)

1. **Docker Desktop on Windows:** the first `docker compose up --build`
   there, and `scripts/dev-setup.ps1` run end to end on Windows PowerShell
   5.1.
2. **Real cameras:** never connected.
   - Most are Dahua-style `/cam/realmonitor` URLs; cam-10 and cam-26 use
     `/video/livemedia`.
   - cam-29 to cam-34 (`%21` passwords): FFmpeg decodes them (above). If
     login still fails, the password itself is wrong.
   - Lobby1 is a UniFi Protect stream (`192.168.1.6:7447`) configured as
     UDP. Check that the TCP retry plays.
3. **A real iPad 6th gen:** PCM audio, pinch zoom, the HQ/LQ and speaker
   buttons on tap, the certificate install flow. Tests ran in headless
   Chromium with `AudioDecoder` removed to simulate it.
4. **Load with 35 cameras:** CPU and RAM per FFmpeg, and how many
   simultaneous RTSP sessions each camera model allows.

## Backlog / ideas

- **The old game-master console was not ported.** It needs the rest of its
  original platform. The wall only implements its camera contract:
  `current-objective` / `current-objective-request` on noodleman. Ask the
  owner before taking that on.
- **The original PNG icon and favicon were never supplied.** SVG
  placeholders are in `public/images/`.
- **No CI.** A GitHub Actions workflow could run the dev compose + both test
  files on Ubuntu.
- **`probeAll` re-probes unprobed (usually offline) cameras every watchdog
  interval.** Consider a backoff per camera.
- **No LICENSE file.** Ask the owner.
