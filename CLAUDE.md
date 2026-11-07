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
server/sources.js         FFmpeg input args per URL type (incl. RTSP multicast + its fallback memory), HTTP session-cookie
                          login, friendly error messages
server/onvif.js           ONVIF discovery (stream URIs, multicast URIs and groups) and lookupMulticast for existing cameras
server/recordings.js  scan.js  probe.js  tls.js (local CA)  legacy-proxy.js (camera-proxy endpoints)
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
test/onvif.js             fake ONVIF camera: multicast discovery/lookup, FFmpeg args, fallback memory (no instance needed)
test/network.js           unreachable cameras: the TCP knock, STREAM_PROBLEM, wait-then-restart (no instance needed)
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
- **RTSP over UDP falls back to TCP automatically.** Bridged networks can
  block the UDP return path, and host networking isn't an option on
  Windows. (On the owner's Docker Desktop, Lobby1 did play over UDP; keep the
  fallback for the setups where it doesn't.)
- **Zoom state is stored as fractions of the pane**, so resizes keep the
  region. It resets whenever a pane changes position (featured swap,
  drag-drop, wall main change, fullscreen focus).
- **Quality precedence:** decoder overload, then pane HQ/LQ button, then
  view override, then server policy (default `'sub'`, substreams only).
- **Multicast falls back to unicast, and remembers it** (`sources.js`):
  - no picture within 8 s, or two stalls in 15 minutes (a switch without an
    IGMP querier) → unicast;
  - that stream then skips multicast for an hour; Recycle clears this;
  - `transport: 'multicast'` falls back to TCP; with the global `prefer`, a
    `udp` source falls back to UDP;
  - `multicastUrl` is only for cameras whose multicast RTSP address
    differs. Most negotiate multicast on the normal URL in SETUP.
  - Not when the camera doesn't answer on its RTSP port at all
    (`reachable()`): an unplugged camera is not a multicast failure. The
    UDP→TCP switch is skipped for the same reason.
  - The lookup never switches a stream whose group and port another stream
    also uses (the packets would arrive mixed). The global `prefer` setting
    doesn't check that; it's documented, not enforced.

  It never works on Docker Desktop, so the default stays TCP and multicast
  is opt-in.
- **No picture → a cover that says why, never a frozen frame** (owner's
  request after the 2026-11-06 LAN outage):
  - **Every FFmpeg start also knocks on the camera's port** (`probeHost`,
    3 s). On "unreachable" the FFmpeg is killed at once: FFmpeg itself takes
    up to 25 s to give up.
  - **An unreachable camera is waited for, not retried.** The session knocks
    every 5 s and starts FFmpeg only when the camera answers. That is not
    counted as restarts and never gives up while someone watches. Don't put
    it back on the restart backoff: that was the 30-second FFmpeg churn of
    the outage.
  - **"The camera network is down"** = no other camera playing and up to four
    other camera hosts unreachable (`cameraNetworkDown`, cached 10 s). A
    "refused" host counts as reachable.
  - **`STREAM_PROBLEM` (0x0A) is sent after `STREAM_ERROR`**, so old
    clients still get the text, and new ones ignore unknown types. It
    carries the problem's *age*, not a timestamp, so the client's clock
    places "since". It is re-sent after every failed start (`force`): a
    restart that got as far as the stream header told clients 'streaming'.
  - **"since" is when the picture was lost** (`lostAt`: last video, or the
    first failed start), kept across retries. An idle stop forgets it.
  - **The pane shows its own "Lost the connection to LookyLooky"** after
    10 s with the socket closed. Short reconnects are routine.
  - Overlay element ids use the `np-` prefix; `sp-` is the speaker button.
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

## Verified on the owner's Windows 11 laptop (2026-11-06, Docker Desktop)

- **`scripts/dev-setup.ps1` runs end to end on Windows PowerShell 5.1**
  after two fixes: `$PSScriptRoot` is empty in `param()` defaults on 5.1, and
  `npm`/`npx` must be called as `npm.cmd`/`npx.cmd` (`npm.ps1` re-parses the
  caller's command line). Build, start, `e2e.js` 13/13, `features.js` 22/22.
- **It would silently replace a LookyLooky started from another folder** of
  the same name (same project, container, volume, ports). It now stops and
  says so unless `-ReplaceExisting`.
- **All 35 real cameras play over unicast TCP** through Docker Desktop,
  including cam-10/cam-26 (`/video/livemedia`), cam-28 (main only) and
  cam-29 to cam-34 (`%21` passwords). Lobby1 plays over **UDP** (no TCP
  fallback was needed).
- **Load, all 35 streams running:** about 1.5 CPU cores and 760 MB for the
  whole container; each FFmpeg about 40 MB resident and 4% of one core
  (stream copy, no transcode).
- **A camera-network outage** (the laptop's LAN cable out from 2:00 AM ET):
  the previous build kept retrying every stream about every 30 s for 18
  hours (1,000+ restarts each) with "The camera did not answer in time". The
  owner saw stalled-looking panes and asked for a clear network error
  instead.

- **Multicast (branch `claude/new-session-iqef3y`):** checked against
  mediamtx serving RTP multicast:
  - LookyLooky on host networking gets the stream over multicast
    (`delivery: "multicast"`);
  - with multicast blocked (iptables), it switches to unicast after 8 s and
    the next cold start goes straight to unicast;
  - `test/onvif.js` covers discovery against a fake ONVIF camera.

- **Multicast with the owner's real cameras (2026-11-06, laptop wired onto
  the camera network, Docker Desktop):**
  - **ONVIF's multicast group is not what the cameras send to.** Dahua
    cameras report e.g. 224.1.0.0 (or 0.0.0.0) over ONVIF, then answer the
    RTSP SETUP with their web-page default, **224.1.2.4, same ports on every
    camera** (main 40000, sub 40016). That's why the lookup also asks RTSP
    (`multicastSetup` in `probe.js`) and flags shared groups
    (`sharedGroups`). Of 35: 18 share 224.1.2.4, a few more share other
    groups (one model sends main and sub to the same group and port), 5 have
    their own group, 1 answers 404 on ONVIF's multicast URL, 3 accept
    multicast but have no address set, UniFi Protect drops the connection.
  - **The LAN carries it:** FFmpeg on Windows, outside Docker, joined
    224.1.2.4 on the wired adapter (`udp://…?localaddr=`) and got the
    packets at once. FFmpeg's own RTSP multicast pull got nothing, because
    Windows joined on another adapter (multicast route metric tie with the
    Npcap loopback), and FFmpeg's RTSP client has no option to pick one.
  - **Docker Desktop:** `no picture over multicast — switching this stream to
    unicast` after 10 s, as expected.
  - Not yet seen: a stream actually playing over multicast through
    LookyLooky (needs a Linux host on the camera network), and IGMP
    querier behaviour on the owner's switches.

Reading `/api/cameras`: `status: running` means *enabled*, not *connected*.
Streams start on demand, and `lastError` only shows while a stream is
retrying (someone is watching it). To check a camera, open it, or fetch
`/stream/<id>/snapshot` (504 with a reason after 12 s if it can't connect).

## Verified on the pve5 VM (2026-11-07, Ubuntu 24.04, Docker Engine, host networking)

- **Multicast plays end to end**: substreams of cam-02 and cam-24 (Dahua)
  and cam-30 (Uniview) delivered `multicast`, each FFmpeg joined its own
  `229.1.2.x` group on the camera NIC. Needs the netplan route
  `229.0.0.0/8` on the camera interface (default route is the main LAN).
- The cameras now use one scheme, set on 2026-11-06: main
  `229.1.1.<last octet>:11111`, sub `229.1.2.<last octet>:22222`.
- **EE edge proxy in front** (`docker-compose.host.yml`, README "Linux host
  ..."): `http://looky.local` and `http://<IP>` redirect to https;
  `https://looky.local` and `https://<IP>` serve LookyLooky's own
  certificate (same CA as before); WebSocket upgrade, API auth, snapshots
  pass through; `looky.local` answers mDNS on the main LAN.
- **cam-32 / cam-33 (Uniview, H.265)** have SPS/PPS but no VPS in their SDP;
  they send all three in-band before each keyframe. Tagged hvc1, FFmpeg
  writes an empty hvcC and strips the in-band sets. Fixed in code
  (2026-11-07): such streams run as hev1 and the pipeline builds the hvcC
  from the first keyframe (`fmp4.js`, `test/hevc.js`). All four streams then
  played over multicast at 15 fps. Their short probe can fail ("unspecified
  size"); the long-probe retry now runs before the multicast fallback.
  Decoding in a real browser was not checked yet. Don't change camera codecs
  without the owner's OK.
- **Every camera delivers 15 fps** (measured 2026-11-07), except Lobby1 (30)
  and cam-18 (6). The 25 fps in the dev instance is its generated test
  pattern.

## Not verified yet (do these first on the owner's hardware)

1. **A real iPad 6th gen:** PCM audio, pinch zoom, the HQ/LQ and speaker
   buttons on tap, the certificate install flow. Tests ran in headless
   Chromium with `AudioDecoder` removed to simulate it.
2. **How many simultaneous RTSP sessions each camera model allows.**

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
