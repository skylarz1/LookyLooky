# LookyLooky

**A network camera relay in one Docker container.** It pulls RTSP and HTTP IP
cameras with FFmpeg and plays them in the browser at low latency: iPad and
iPhone Safari (including the iPad 6th gen), Chrome, Edge and Firefox. The
viewer and dashboard inside it are called **Claudifer**.

- **Dashboard:** live grid layouts, drag and drop, audio, recordings, network
  scan and ONVIF discovery, per-camera settings.
- **View-only board and camera wall:** for TVs, kiosks and iPads.
- **Zoom:** mouse wheel toward the cursor, pinch on touch screens.
- **Stream quality:** per pane, per view, or a server-wide policy.
- **MJPEG and snapshot URLs:** for other tools.
- **Built-in HTTPS:** a local certificate authority for LAN devices.

> **New to Docker on Windows?** Follow [docs/WINDOWS.md](docs/WINDOWS.md) step by step.

---

## Quick start

1. Put your cameras in `config/`:
   - **Cameras:** copy `config/cameras.example.xml` to `config/cameras.xml`
     and fill in your cameras.
   - **Layouts:** copy `config/camera-layouts.example.xml` to
     `config/camera-layouts.xml`. Optional.

   These are imported on the **first** boot only. After that, manage
   everything in the dashboard.
2. In `docker-compose.yml`, set `LOOKY_HOSTNAMES` to the LAN IP (and any
   DNS name) browsers will use to reach the machine. The HTTPS certificate is
   issued for exactly those names.
3. Start it:
   ```bash
   docker compose up -d --build
   ```
4. On each viewing device, open `https://<LAN IP>:8443/setup.html`. Install
   the certificate once and switch on trust for it (on iPad: Settings →
   General → About → Certificate Trust Settings).
5. Open `https://<LAN IP>:8443/`.

With no config at all, the first boot creates a **Test Pattern** camera, so
browsers can be checked before any real camera is added.

## Pages

| URL | What |
|---|---|
| `/` | Landing page, with View and Wall links for every layout |
| `/cameras.html[?layout=…&audio=…]` (`/dashboard`) | Dashboard: cameras, layouts, drag and drop, audio focus, fullscreen and keypad focus, recordings, network scan, ONVIF discovery, settings, recycle, import and export. The address bar follows the layout and the camera heard, so a copied link opens the same view |
| `/camera-view.html?layout=<id or name>[&quality=high\|low][&audio=…]` | Read-only board for wall displays and kiosks. Silent unless `audio` is given |
| `/wall.html?layout=<id or name>[&camera=<id>][&quality=high\|low][&audio=…]` | The camera wall: one 16:9 main pane over up to six previews, three to a row, or up to twelve, four to a row (two or three across on an upright phone). Tap a preview to put it up; audio follows the main pane |
| `/stats` | Statistics: server load, every stream and every viewer's delay (admin; see "Statistics and load testing") |
| `/setup.html` | Browser capability check and certificate install steps |
| `/camera-1.html?camera=<id>` | A single camera's raw stream drawn to a canvas (test page) |
| `/stream/<id>/mjpeg`, `/stream/<id>/snapshot` | MJPEG and JPEG for other tools (plain HTTP works) |
| `/cameras`, `/stream/<id>`, `/snapshot/<id>` | camera-proxy compatible endpoints |

`audio` works on all three pages:

- `none`: muted.
- `first`: the layout's first camera.
- `all`: every camera in the layout. The wall plays only its main pane.
- a camera id: that camera.

Without it, the dashboard and the wall remember the last choice in that
browser. Browsers allow sound only after a tap or click on the page, so until
then a **Tap for sound** button shows whenever something should be heard.

On an upright phone the view board stacks its cameras at 16:9, two across
with the large pane full width, and scrolls. The dashboard's header and
toolbar wrap instead of widening the page.

On an iPad (any window narrower than 1100 px, Split View and Stage Manager
included) the dashboard keeps the layout's real grid. The header and toolbar
are compact, and the camera list is a drawer that **☰** opens over the grid
(a tap outside closes it). Only a phone (600 px or less) gets one camera per
row. A tap on a pane selects it, puts it up in a featured layout, and shows
its controls for a few seconds. A double tap goes fullscreen, like a
double-click.

## Zoom

| Input | Action |
|---|---|
| Mouse wheel / trackpad pinch | Zoom toward the cursor, up to 8× |
| Drag (while zoomed) | Pan |
| iPad / phone: pinch | Zoom about the fingers |
| iPad / phone: one finger (while zoomed) | Pan; not zoomed, the page scrolls as normal |
| Click the `2.6× ⟲` badge | Reset |

A pane's zoom resets automatically when it changes position: it becomes the
main camera on the wall, it is swapped into a featured slot, it is dragged to
another slot, or it is focused fullscreen.

## Stream quality (High = main stream, Low = substream)

| Level | Where | What |
|---|---|---|
| Server policy | Settings → Streaming → "High quality (main stream) is used" | **Never**: substreams only (default) · **Only fullscreen / single-camera views** · **Fullscreen, and panes wider than the threshold** · **Always** |
| Per view | Dashboard toolbar **Quality: Auto / Low / High**, remembered per layout in each browser. View page and wall: `?quality=high` or `?quality=low` | Overrides the policy for every pane on that view |
| Per pane | Hover a pane (tap on iPad) → **HQ / LQ** button; **A** returns it to automatic | Overrides everything else for that camera, remembered per browser |

If a device's decoder can't keep up, the pane drops to Low on its own (the
variant tag turns amber). It retries High after 30 s of calm.

## Audio

- **Default: one camera at a time.** Click (or tap) a pane to make it the
  focused one; the top speaker button and volume slider control it. On the
  wall, the main camera is the focused one and the wall's speaker controls
  it.
- **Per-pane speakers add more cameras.** Hover a pane (tap on iPad) for its
  speaker button, bottom-left:
  - **Turn it on:** that camera plays as well as the focused one, at the
    volume slider's level, even while the top button is muted. Its button
    stays lit (filled orange) while on.
  - **Turn it off:** that camera stops. On the focused camera, the button
    does the same as the top mute button.
  - **Top mute button:** silences everything and switches every pane speaker
    off. Unmuting brings back only the focused camera.
  - **Thumbnail panes:** turning on a speaker makes the pane full live video
    (a thumbnail has no sound).
  - **View-only page:** it has no focused camera, so pane speakers are its
    audio.
  - **Not remembered:** pane speakers reset after a reload, so a screen never
    starts talking on its own.
- **iPad 6th gen and other Safari before 26:** they have no Opus decoder, so
  the server sends them PCM instead. Audio works the same.
- **Mixing:** every pane has its own audio graph, mixed by the browser.
  `test/features.js` checks with four cameras on four tones that exactly the
  expected cameras are heard, on both the Opus and the PCM (iPad) paths.
- **Muted panes are sent no audio at all**, so they cost no bandwidth.

## How the low latency is achieved

- **No re-encode.** H.264 and HEVC are copied from the camera untouched.
  Only cameras browsers cannot decode (MJPEG, MPEG-4) are converted to
  H.264, which happens automatically.
- **One fragment per frame.** FFmpeg writes fragmented MP4 with one fragment
  per frame, and video, Opus audio and PCM audio each go to their own pipe,
  so no stream waits on another.
- **Browser decoding with a short buffer.** WebCodecs decodes in the browser
  with a 150 ms jitter buffer (configurable).
- **Instant join at the live edge.** A viewer that joins late gets the cached
  GOP at once, flagged so it plays from the newest frame: first picture in
  milliseconds on a running stream.
- **Latency guard.** The client pulls its clock back if frames start queueing,
  so delay cannot creep up over hours.
- **Slow viewers are handled per viewer.** A slow viewer skips to the next
  keyframe. One that falls badly behind is dropped with code 1013 and comes
  back on the substream.
- **Thumbnails share the camera connection.** They decode the stream that is
  already running, so a camera with few RTSP slots is not asked for another
  connection.

## When a camera has no picture

A pane with no video never keeps showing its last frame as if it were live.
The frame is dimmed and covered with the reason and when the picture was lost
("No video since 2:03 AM", in the viewer's own time). The cover goes away by
itself with the next picture.

| Cover | Meaning |
|---|---|
| **Network error**: the camera can't be reached | Nothing answers on the camera's port (unplugged, powered off, wrong address) |
| **Network error**: no camera can be reached | No other camera answers either: the camera network itself is down (a cable out, a switch off) |
| **Network error**: lost the connection to LookyLooky | This device can't reach the server (for example an iPad off Wi-Fi) |
| **No video from camera** | The camera answers but sends nothing, or stopped sending |
| **Camera error** | The camera answered with an error: wrong password, wrong path, RTSP switched off, too many viewers |

**While a camera can't be reached, LookyLooky doesn't keep starting FFmpeg.**
It knocks on the camera's port every 5 seconds, and the stream starts again
within seconds of the camera answering. A camera that answers but fails keeps
the normal backoff.

The dashboard header also says when watched cameras can't be reached, and
`GET /api/cameras` carries a `problem` for each one: `{ kind, text, since }`.
The kinds are `network`, `network-down`, `no-video` and `camera`.

## Browser support

| Browser | Video | Audio |
|---|---|---|
| Chrome / Edge 94+ (desktop, Android) | WebCodecs, full motion | Opus |
| Safari 26+ (macOS, iOS, iPadOS) | WebCodecs | Opus |
| **Safari 16.4–18 (iPad 6th gen on iPadOS 17)** | WebCodecs | **PCM** |
| Firefox 130+ | WebCodecs | Opus |
| Plain HTTP on a LAN address, or older browsers | JPEG thumbnails (a banner says how to get full motion) | none |

WebCodecs only exists on secure pages, so viewers need HTTPS. Either install
LookyLooky's CA (`/setup.html`), or put it behind a reverse proxy that
already has a trusted certificate. On the machine running Docker,
`http://localhost:8080` already counts as secure.

**HTTP → HTTPS:**
- **On the HTTP port (8080):** pages redirect themselves to the HTTPS port
  (add `?insecure=1` to stay on HTTP, thumbnails only).
- **On the HTTPS port (8443):** a plain `http://` request is redirected to
  `https://` on the same host and port.
- **Remapped ports:** if Docker maps them to other numbers, set
  `LOOKY_PUBLIC_HTTPS_PORT` so the redirect goes to the right one.

**Other notes:**
- **HEVC cameras:** they play on Safari and on Chrome machines with hardware
  HEVC decode. For others, set the camera's **Video** to **Convert to H.264**,
  or switch its substream to H.264.
- **When WebCodecs can't decode but `<video>` can:** some PCs (a Windows 10
  Chrome on 2026-11-07) accept H.265 in WebCodecs, then fail every frame,
  while the same stream plays in a `<video>` element. After two such
  failures with no picture, the pane switches to a hidden `<video>` fed over
  Media Source Extensions and draws its frames on the same canvas. Every pane
  on the page follows, and the browser remembers it for a day. It costs about
  0.1 s of extra delay. `/stats` shows *<video> fallback* in the viewer's
  notes. `?decoder=mse` or `?decoder=webcodecs` in a page URL forces one.
  When a pane stays black, its notes also show the decoder's last error, and
  say so when the browser's `<video>` can't play the codec either.
- **iPhone:** it has no element fullscreen, so fullscreen is emulated.

## Configuration

Settings live in the dashboard (Settings → Streaming / System) and are stored
in `/data/settings.json`. Container options are environment variables:

| Variable | Default | |
|---|---|---|
| `LOOKY_HOSTNAMES` | — | Names and IPs for the HTTPS certificate, comma separated. **Set this.** |
| `LOOKY_HTTP_PORT` / `LOOKY_HTTPS_PORT` | 8080 / 8443 | Listen ports |
| `LOOKY_PUBLIC_HTTP_PORT` / `LOOKY_PUBLIC_HTTPS_PORT` | same | The ports browsers see, if Docker remaps them |
| `LOOKY_HTTPS` | 1 | `0` = HTTP only (TLS done by a reverse proxy) |
| `LOOKY_TLS_CERT` / `LOOKY_TLS_KEY` | — | Your own certificate instead of the generated one |
| `LOOKY_ADMIN_PASSWORD` / `LOOKY_ADMIN_USER` | — / admin | Basic auth on the dashboard, every write endpoint and camera details (which hold stream passwords). Viewing stays open. |
| `LOOKY_ALLOWED_ORIGINS` | `*` | Origins allowed to call the API and open the media socket |
| `LOOKY_DATA_DIR` | /data | cameras.json, layouts.json, settings.json, certs/, recordings/ |
| `LOOKY_SEED_DIR` | /seed | First-boot import folder |
| `LOOKY_DEMO` | 1 | `0` = no Test Pattern camera on an empty first boot |
| `TZ` | — | Time zone, for recording file names |

Pipeline settings (Settings → Streaming):
- **Keep warm** (none / substreams / everything): keeps camera connections
  open with no viewers, for instant panes.
- **Idle linger:** how long a stream stays up after its last viewer.
- **Stall restart:** how long without video before the pipeline is restarted.
- **Max restarts:** after this many, the camera shows `error` with the
  reason.
- **Recycle after:** a daily preventive restart, done by starting the new
  FFmpeg before stopping the old one.

**RTSP over UDP:** Docker's bridged network blocks UDP camera traffic coming
back in. A UDP stream that shows no picture within about 8 s switches itself
to TCP. To really use UDP, run with `network_mode: host` on Linux.

### Multicast

With RTSP multicast, a camera sends each stream **once** onto the network,
and every receiver (LookyLooky, an NVR, another relay) joins it. A camera
that several systems watch then encodes and sends one copy instead of one per
connection. LookyLooky on its own already shares one camera connection among
all of its viewers, so multicast pays off when **other** systems pull the
same cameras too.

- **Per camera:** Transport → *Multicast* (camera dialog, network scan).
- **For all RTSP cameras:** Settings → Streaming → *RTSP multicast* → *Try
  multicast for every RTSP camera*.
- **Addresses from ONVIF:**
  - ONVIF Discover shows each stream's multicast group, and fills in its
    multicast RTSP address when it differs from the unicast one.
  - For cameras already set up, use Settings → Streaming → *Look up
    multicast on all cameras (ONVIF)*. It asks each camera on port 80 with
    the login from its stream URL, and can switch the ones that offer it.
  - The lookup also asks each stream's RTSP server for multicast and
    reports the group and port it **really** sends to, or why it won't
    (404, 461, no multicast address set, no valid answer). ONVIF's group
    can't be relied on: Dahua cameras report one there and send to another.
  - API: `POST /api/multicast/lookup {"enable": true}`.
- **Give every camera its own multicast address first.** Dahua cameras all
  ship with group `224.1.2.4` and the same ports (main 40000, sub 40016), so
  two of them on multicast arrive **mixed** at every receiver. The lookup
  lists such streams under *Group shared with another stream* and never
  switches them; set a unique address in each camera's web page (Setup →
  Network → Multicast) and run it again. *Try multicast for every RTSP
  camera* does **not** check this, so don't use it until the lookup shows
  no shared groups.
- **cameras.xml:**
  - per source: `transport="multicast"` and an optional
    `multicast-url="rtsp://…"`;
  - for all cameras: `<camera-settings multicast="prefer">`.

**Multicast only reaches LookyLooky when its container is on the cameras'
network:** a Linux host with `network_mode: host` (see `docker-compose.yml`),
and switches that forward multicast. It never arrives on **Docker Desktop**
(its VM sits behind NAT) or a bridged network.

On a PC with several network adapters, the operating system joins the group
on the adapter its multicast route picks, which may not be the camera
network's. FFmpeg's RTSP client can't be told which one. On a Linux host,
add `ip route add 224.0.0.0/4 dev <camera-network interface>` if the
lookup's groups never arrive.

LookyLooky copes with that by itself:
- **No picture over multicast within about 8 s:** the stream switches to
  unicast (the source's own TCP/UDP setting). Not when the camera doesn't
  answer at all (unplugged, network down): that is reported as *The camera
  cannot be reached on the network* and retried, and multicast is tried
  again once it is back.
- **Stalls twice within 15 minutes while on multicast:** it also switches to
  unicast. This is the usual symptom of a switch with IGMP snooping but no
  IGMP querier.
- **Loses packets three times in a minute while on multicast:** it moves to
  unicast make-before-break, so viewers see no gap. Multicast is UDP, and a
  lost packet smears the picture until the next keyframe. On 2026-11-07 the
  Uniview groups (cam-30 to cam-34) lost packets on the way to the server
  while every Dahua group arrived whole. `/stats` counts the gaps.
- **Stay on multicast when packets are lost** (a checkbox under Multicast
  in the camera's settings): the stream keeps multicast through lost packets
  and stalls, and lives with the occasional smeared frame. It's for cameras
  that cope badly with extra unicast streams, such as the Temple cameras,
  where each fallback adds one more. A stream that gets no picture at all
  over multicast still falls back.
- **In every case,** that stream skips multicast for an hour.
- **Retry multicast** (Settings → Status, or on `/stats` for all streams or
  one stream) brings fallen-back streams back after you fix the network. A
  running stream swaps make-before-break, so no viewer is dropped. If
  multicast still gets no picture or keeps losing packets, the stream returns
  to unicast. Recycle Cameras retries multicast too, but drops every viewer.
- **Recordings** use multicast only once the live stream has proven it
  works.
- **Checking:** `/api/cameras` shows `delivery: "multicast"` or
  `"unicast"` for each running stream, and the log line says which.

`kill -HUP` on the server process re-reads cameras.json and layouts.json.

### Linux host with host networking, behind the EE edge proxy

This is how multicast works for real: the owner's VM on pve5 (VM 124,
192.168.1.124 on the main LAN, 192.168.4.124 on the camera LAN, no gateway on
the camera side). `docker-compose.host.yml` switches the container to host
networking and exports the server certificate for the proxy. In `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.host.yml:docker-compose.override.yml
```

- **Names, no port numbers:** the EE edge stack (repo
  `EE-Services-Dashboard-and-Proxy`, `compose.https.yaml` +
  `compose.lookylooky.yaml`) owns ports 80 and 443. Its
  `sites/lookylooky.caddy` lists the names (`looky.local` and the bare IP),
  sends `http://` to `https://`, and serves them with LookyLooky's own
  certificate, so a device that trusts LookyLooky's CA trusts the proxy too.
  Every name there must also be in `LOOKY_HOSTNAMES`. The edge stack
  announces the `*.local` names over mDNS.
- **Certificate:** with `LOOKY_TLS_EXPORT_DIR` set, LookyLooky copies
  `server.crt`, `server.key` and `ca.crt` (never the CA key) there at start,
  into the `lookylooky-tls` volume the proxy reads. The proxy reloads when
  they change.
- **Multicast joins on the camera LAN:** the VM routes the cameras' groups
  (`229.0.0.0/8`) out of the camera interface in netplan. Without that route
  the kernel joins on the default-route interface and nothing arrives.
- Ports 8080/8443 still answer directly, for tools and as a fallback.

## Statistics and load testing

**`/stats`** (admin, linked from the dashboard header) updates every 2 s:

- **Server:** host CPU, LookyLooky's and FFmpeg's CPU, the event-loop
  delay, memory, and each network interface in and out. Every frame for every
  viewer passes through the one event loop, so a rising loop delay turns into
  lag for everyone. Charts cover the last 30 minutes.
- **Streams:** state, multicast or unicast, frames per second and bitrate in
  from the camera, viewers, bitrate out, and each FFmpeg's CPU and memory.
- **Viewers:** every open pane.
  - **Queue:** what the server still has to send it, as a size and as time at
    the stream's bitrate. This is the lag the server adds.
  - **Reported by the pane** every 5 s: frames drawn and dropped, decoder
    backlog, and the median and 95th percentile delay from the server to the
    pane (**Arrival**) and to the screen (**Screen**). The delays use the
    server's clock (from a ping) with the stream's own input delay taken off,
    so camera clock drift doesn't count.

The JSON behind it is `/api/stats?viewers=1&history=1`; the `viewers` part
needs the admin password.

**Load tests** (run them from another machine than the server):

```bash
# Protocol-level viewers in bulk: 10 per camera on the substreams for 10 minutes
NODE_EXTRA_CA_CERTS=ca.crt LOOKY_ADMIN_PASSWORD=... node tools/loadtest.js --url https://looky.local --ip 192.168.1.124 --variant sub --per 10 --minutes 10
# Real headless Chromium boards of one layout, all panes pinned to the main streams
LOOKY_ADMIN_PASSWORD=... node tools/browserload.js --url https://looky.local --ip 192.168.1.124 --layout <id> --quality high --pages 4 --minutes 10
```

- `loadtest.js` prints a line every 10 s:
  - viewers connected, frames per second per viewer, and Mbit/s received;
  - lag p50, p95 and max, and the worst viewer;
  - stalls (a gap of more than three frame intervals) and closes;
  - the server's CPU, loop delay and bitrate out.
- At the end it prints the **lag trend** in ms per minute; anything clearly
  above 0 means lag is building up. It writes the details to a JSON file.
- `browserload.js` reports the same thing as the real browsers see it.
  Headless Chromium decodes in software and has no H.265 decoder, so H.265
  panes fail there even though they play in a real browser.

## Using it from another stack

1. **Same compose project.** Copy the `lookylooky` service and its volume
   into the other stack's `docker-compose.yml`. Other services reach it at
   `http://lookylooky:8080`.
2. **Behind a reverse proxy** (Traefik, Caddy, nginx):
   - Give it its own host name. A sub-path is not supported.
   - Forward WebSocket upgrades on `/cameras/stream`.
   - Set `LOOKY_HTTPS=0` if the proxy does TLS.
   - Turn off proxy buffering for `/stream/*/mjpeg` and `/api/scan`.
3. **Embed the wall** in an iframe and drive it over the `noodleman`
   message bus:
   ```js
   const wall = document.querySelector('iframe#wall').contentWindow;
   wall.postMessage({ noodleman: { topic: 'select-camera', value: { cameraId: 'cam-02' } } }, '*');
   wall.postMessage({ noodleman: { topic: 'wall-layout',  value: { layout: 'Lobby' } } }, '*');
   wall.postMessage({ noodleman: { topic: 'current-objective',
     value: { StoryID: 1, Objective: { ID: 7, CameraID: 'cam-02' } } } }, '*');
   ```
   The wall posts `current-objective-request` back to the parent when it
   loads.
4. **Or import the widget** into a page of the other app. Load
   `https://cams…/js/noodleman.js` and `https://cams…/styles/camera-wall.css`,
   then:
   ```js
   import CameraWall from 'https://cams.example.lan/js/widgets/camera-wall.js';
   new CameraWall({ id: 'wall', api: 'https://cams.example.lan', layout: 'default', quality: 'low' });
   ```
   - **Story mode:** publish `story-set`, `story`, `settings` and
     `current-objective` on `noodleman`, and set `noodleman.stories` /
     `noodleman.storyID`.
   - **Requirements:** the host page must be HTTPS too, and the wall's
     element needs a definite height.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/info`, `/api/stats`, `/api/health` | Server identity, buffer, decode budget and quality policy; live stats (`?viewers=1` adds every viewer, admin; `?history=1` the last 30 min) |
| GET / POST | `/api/cameras` | List (no credentials, with each watched camera's `problem`, see above); add. Each stream is tested first, and a failure returns 422 `STREAM_TEST_FAILED` with the reasons; send `force:true` to save anyway |
| GET / PUT / DELETE | `/api/cameras/:id` | Full definition (admin) / edit / remove |
| POST | `/api/cameras/:id/start` `stop` `restart` | |
| POST | `/api/cameras/batch` | Bulk add from the network scan. The response is a server-sent event stream (discover → test → add) |
| POST | `/api/cameras/recycle` | Every FFmpeg stops and every viewer reconnects |
| POST | `/api/multicast/retry` | Streams that fell back to unicast try multicast again without dropping viewers; body `{cameraId?, variant?}` narrows it (admin) |
| POST | `/api/cameras/import` | `{path}` inside the container, or `{files:[{name,content}]}` |
| GET | `/api/export` | Everything, as one JSON (importable) |
| GET / POST / PUT / DELETE | `/api/layouts`, `/api/layouts/:id` | |
| GET / PUT | `/api/camera-settings` (also `/api/settings`) | Merged on save, so unknown keys survive |
| GET / POST | `/api/recordings`, `/start`, `/stop`; `/api/recordings/file/:name` (GET with Range, `?dl=1`; DELETE) | One recording at a time. Video copied, AAC audio, plays in Safari |
| POST | `/api/discover` | ONVIF: profiles, resolutions, RTSP URLs, suggested main and sub |
| GET | `/api/scan?base=192.168.1&start=1&end=254` | Server-sent events: found / progress / done |
| WS | `/cameras/stream` | Media: see `server/protocol.js` and `public/js/camera/README.md` |

## Project layout

```
server/            Node server (only dependency: ws)
  index.js         HTTP + HTTPS (HTTPS port also redirects plain HTTP), static files, boot
  stream-session.js  one FFmpeg per camera stream, viewers, GOP cache, backpressure, recycle
  fmp4.js          fragmented-MP4 parser; completes H.265 configs from in-band parameter sets
  metrics.js       host, process and FFmpeg load for /api/stats
  protocol.js      binary wire protocol
  mjpeg.js         thumbnails / MJPEG / snapshots (decoded from the running stream)
  cameras.js       camera list, status, sessions, recycle
  api.js           REST API          recordings.js  recordings
  onvif.js         ONVIF discovery   scan.js        subnet scan
  sources.js       FFmpeg inputs, camera session login, error messages
  tls.js           local CA + server certificate
  legacy-proxy.js  camera-proxy compatible endpoints
public/            pages, the Claudifer viewer (js/camera), the wall widget, noodleman, styles
config/            first-boot seed (real files are git-ignored; *.example.xml are templates)
test/              e2e.js (browser smoke test), features.js (audio / zoom / quality), hevc.js, onvif.js
tools/             loadtest.js (many viewers), browserload.js (headless Chromium boards)
docs/WINDOWS.md    Docker Desktop on Windows 11, step by step
```

## Development

**Windows (Docker Desktop):** one idempotent script clones or updates the
repo, writes per-machine settings, starts LookyLooky, and runs the browser
tests against a throwaway copy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-setup.ps1 -ConfigFrom "<folder with your cameras.xml>"
```

**Any OS:**

```bash
npm ci && npx playwright install chromium
npm run dev:up        # throwaway instance on 18080/18443 (docker-compose.dev.yml)
npm test              # test/e2e.js + test/features.js against it
npm run dev:down
```

- **Never point the tests at the real instance.** They add cameras and
  layouts.
- **Per-machine settings** (LAN IP, time zone, admin password) go in
  `docker-compose.override.yml`. It is git-ignored, and Docker Compose merges
  it automatically.
- **Running without Docker:** `LOOKY_DATA_DIR=./data node server/index.js`
  (needs FFmpeg on PATH).

The tests use Playwright Chromium.
- **`e2e.js`:** the dashboard, view page and wall render live video; Opus
  audio; the iPad PCM audio path (by removing `AudioDecoder`); the
  thumbnail-only fallback (by removing WebCodecs).
- **`features.js`:** several cameras' audio at once (Opus and PCM), wheel and
  pinch zoom, zoom reset, every quality level, and per-pane speakers. It
  checks by tone analysis exactly which cameras are heard.

Notes for working on the code with Claude Code are in [CLAUDE.md](CLAUDE.md).
