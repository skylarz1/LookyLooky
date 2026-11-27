/**
 * Network errors without a camera:  node test/network.js
 * Needs no LookyLooky instance.  Checks the TCP knock that tells an
 * unreachable camera from one that answers, the STREAM_PROBLEM wire layout,
 * the "camera network is down" check, and that a stream whose camera is off
 * the network waits for it (no FFmpeg every 30 s) and restarts the moment it
 * answers.  Then what happens after lost packets (unicast fallback, held
 * frames, a keyframe asked of the camera) and the loss history.
 */
const net = require('net');
const path = require('path');
process.env.LOOKY_DATA_DIR = process.env.LOOKY_DATA_DIR || path.join(__dirname, 'out', 'network-data');
const sources = require('../server/sources');
const P = require('../server/protocol');
const { DEFAULT_SETTINGS, normaliseCamera } = require('../server/config');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const open = server.address().port;
  try {
    // --- the knock --------------------------------------------------------
    check('knock: listening port answers', await sources.probeHost(`rtsp://127.0.0.1:${open}/x`) === 'ok');
    const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    check('knock: closed port on a live host is "refused"', await sources.probeHost(`rtsp://127.0.0.1:${closed}/x`) === 'refused');
    const t0 = Date.now();
    const tn = await sources.probeHost('rtsp://user:pw@192.0.2.1/x', 1500);
    check('knock: TEST-NET host is "unreachable" within the timeout', tn === 'unreachable' && Date.now() - t0 < 2500, `${tn} after ${Date.now() - t0} ms`);
    check('knock: test pattern / file is not a network source', await sources.probeHost('test:640x360@25') === null && await sources.probeHost('/media/x.mp4') === null);
    check('knock: reachable() keeps its yes/no answer', await sources.reachable(`rtsp://127.0.0.1:${open}/x`) === true && await sources.reachable(`rtsp://127.0.0.1:${closed}/x`) === false);

    // --- wire layout ------------------------------------------------------
    const m = P.streamProblem(P.PROBLEM.NETWORK, Date.now() - 125000, 'The camera cannot be reached on the network');
    check('protocol: STREAM_PROBLEM header, kind, age in seconds, text',
      m[0] === 1 && m[1] === 0x0a && m[2] === 1 && m.readUInt32BE(3) === 125 && m.subarray(7).toString() === 'The camera cannot be reached on the network',
      m.subarray(0, 8).toString('hex'));
    const c = P.streamProblem(P.PROBLEM.CLEAR, 0, '');
    check('protocol: CLEAR is kind 0 with age 0', c.length === 7 && c[2] === 0 && c.readUInt32BE(3) === 0);

    // --- the camera network is down ---------------------------------------
    const { CameraManager } = require('../server/cameras');
    const mgr = (urls) => new CameraManager({ settings: DEFAULT_SETTINGS, cameras: urls.map((u, i) => ({ id: `c${i}`, name: `C${i}`, enabled: true, sources: [{ label: 'main', url: u }] })) });
    check('network: every other camera unreachable → down',
      await mgr(['rtsp://192.0.2.1/a', 'rtsp://192.0.2.2/a', 'rtsp://192.0.2.3/a']).cameraNetworkDown('c0') === true);
    check('network: another camera answers (even "refused") → not down',
      await mgr(['rtsp://192.0.2.1/a', 'rtsp://192.0.2.2/a', `rtsp://127.0.0.1:${closed}/a`]).cameraNetworkDown('c0') === false);
    check('network: no other network camera to ask → not down',
      await mgr(['rtsp://192.0.2.1/a', 'test:640x360@25']).cameraNetworkDown('c0') === false);

    // --- a stream whose camera is off the network --------------------------
    // The knock is stubbed (and stream-session.js loaded afresh to take it) so the
    // camera can "come back"; FFmpeg is stood in for by node, which exits at
    // once on FFmpeg's arguments, like FFmpeg failing to connect.
    let answer = 'unreachable';
    sources.probeHost = async () => answer;
    delete require.cache[require.resolve('../server/stream-session')]; // cameras.js loaded it with the real knock
    const { StreamSession } = require('../server/stream-session');
    const logs = [];
    const cam = { id: 'gone', name: 'Gone', enabled: true, sources: [{ label: 'main', type: 'rtsp', url: 'rtsp://192.0.2.9/x', transport: 'tcp' }] };
    const settings = { ...DEFAULT_SETTINGS, ffmpeg: { ...DEFAULT_SETTINGS.ffmpeg, path: process.execPath, restartDelayMs: 200 } };
    const fake = {
      store: { settings }, camera: () => cam, variantInfo: () => ({ hasAudio: false }), updateVariant() {},
      trackProcess() {}, untrackProcess() {}, keepWarm: () => false, onSessionLive() {}, onSessionFailed() {},
      cameraNetworkDown: async () => false,
    };
    const s = new StreamSession(fake, 'gone', 'main');
    const T0 = Date.now(); s.log = (msg) => { logs.push(msg); if (process.env.NET_DEBUG) console.log(Date.now() - T0, msg); };
    const got = [];
    const viewer = { configSent: false, send: (b) => got.push(Buffer.from(b)), sendConfig() {}, detach() {} };
    s.addClient(viewer);
    await sleep(2500);
    const problems = () => got.filter((b) => b[1] === 0x0a);
    const first = problems()[0];
    check('wait: unreachable camera → STREAM_PROBLEM "network" to the viewer',
      first && first[2] === P.PROBLEM.NETWORK && /cannot be reached/.test(first.subarray(7).toString()), first ? first.subarray(0, 8).toString('hex') : 'none');
    check('wait: STREAM_ERROR still sent first, for older clients',
      got.findIndex((b) => b[1] === 0x07) >= 0 && got.findIndex((b) => b[1] === 0x07) < got.findIndex((b) => b[1] === 0x0a));
    const spawnsBefore = logs.filter((l) => l.startsWith('spawn')).length;
    await sleep(6000);
    const spawnsWaiting = logs.filter((l) => l.startsWith('spawn')).length;
    check('wait: no FFmpeg is started while the camera does not answer', spawnsWaiting === spawnsBefore, `${spawnsBefore} → ${spawnsWaiting}; ${logs.join(' | ')}`);
    check('wait: not counted as restarts (never gives up)', s.state === 'backoff' && s.restarts.length === 0, `${s.state}, ${s.restarts.length}`);
    check('wait: the problem is not repeated every round', problems().length === 1, `${problems().length} sent`);
    answer = 'ok';
    await sleep(5600);
    check('wait: camera answers again → restarted at once', logs.some((l) => /answers again/.test(l)) && logs.filter((l) => l.startsWith('spawn')).length > spawnsWaiting,
      logs.slice(-3).join(' | '));
    await sleep(800);
    const after = problems().slice(1);
    check('wait: answering but no video → "no video" or "camera" reason, sent again',
      after.length >= 1 && [P.PROBLEM.NO_VIDEO, P.PROBLEM.CAMERA].includes(after[after.length - 1][2]),
      after.map((b) => `${b[2]}:${b.subarray(7).toString()}`).join(' | '));
    check('wait: "since" stays the time the picture was lost', s.problem && s.problem.since <= Date.now() - 13000, s.problem && `${Date.now() - s.problem.since} ms ago`);
    s._clearProblem();
    const last = problems().pop();
    check('clear: video back → STREAM_PROBLEM kind 0, and "since" forgotten', last[2] === P.PROBLEM.CLEAR && s.lostAt === 0 && s.problem === null);
    s.destroy();

    // --- multicast packet loss, with and without keepMulticast -------------
    const lossy = (keep) => {
      const c = { id: 'mc', name: 'Mc', enabled: true, sources: [{ label: 'sub', type: 'rtsp', url: 'rtsp://192.0.2.9/x', transport: 'multicast', ...(keep ? { keepMulticast: true } : {}) }] };
      const m = new StreamSession({ ...fake, camera: () => c }, 'mc', 'sub');
      m.log = () => {};
      let recycled = 0; m._recycle = () => { recycled++; };
      const p = { multicast: true }; m.active = p;
      m._onRtpLoss(p, 2); m._onRtpLoss(p, 2);
      return { recycled, gaps: m.stats.rtpGaps, off: m.noMulticastUntil > Date.now() };
    };
    const plain = lossy(false), kept = lossy(true);
    check('multicast loss: 3 gaps in a minute → unicast', plain.recycled === 1 && plain.off, JSON.stringify(plain));
    check('multicast loss: keepMulticast stays on multicast, still counts the gaps', kept.recycled === 0 && !kept.off && kept.gaps === 4, JSON.stringify(kept));

    // --- hold the picture after RTP loss ------------------------------------
    // Which of a run of frames reach a viewer when a loss warning comes
    // before frame `lossAt` ('K' keyframe, 'P' other, 66 ms apart; lower
    // case arrives with the frame before it, in a burst); `hold` = the setting.
    const held = (pattern, lossAt, hold = true) => {
      const realNow = Date.now; let clock = realNow();
      Date.now = () => clock;
      try { return heldAt(pattern, lossAt, hold, (f) => { if (f === f.toUpperCase()) clock += 66; }); } finally { Date.now = realNow; }
    };
    const heldAt = (pattern, lossAt, hold, tick) => {
      const c = { id: 'h', name: 'H', enabled: true, sources: [{ label: 'sub', type: 'rtsp', url: 'rtsp://192.0.2.9/x', transport: 'multicast', keepMulticast: true }] };
      const st = { ...settings, ffmpeg: { ...settings.ffmpeg, holdOnLoss: hold } };
      const m = new StreamSession({ ...fake, store: { settings: st }, camera: () => c }, 'h', 'sub');
      m.log = () => {};
      const p = { multicast: true }; m.active = p;
      m.videoConfigMsg = Buffer.alloc(1); m.state = 'live';
      const out = [];
      m.clients.add({ configSent: true, sendVideo: (msg, isKey) => out.push(isKey ? 'K' : 'P') });
      [...pattern].forEach((f, i) => {
        if (lossAt.includes(i)) m._onRtpLoss(p, 1);
        tick(f);
        m._onVideoSample(p, i * 66666, f.toUpperCase() === 'K', Buffer.alloc(8), null);
      });
      clearInterval(m.watchdog);
      return { out: out.join(''), stats: m.stats };
    };
    let h = held('KPPPPKPPP', [2]);
    check('hold: frames after a loss are held to the next keyframe', h.out === 'KPKPPP' && h.stats.lossHolds === 1 && h.stats.lossHeld === 3, JSON.stringify(h));
    h = held('KPPPPKPPPKPP', [5]);
    check('hold: a keyframe right after the warning is held too (the loss was in it)', h.out === 'KPPPPKPP', h.out);
    h = held('KPPPPpkpPPPKPP', [4]);
    check('hold: a keyframe in the burst after the warning is held too', h.out === 'KPPPKPP', h.out);
    h = held('KPPPPKPPPKPP', [2]);
    check('hold: a keyframe arriving on its own after the burst ends the hold', h.out === 'KPKPPPKPP', h.out);
    h = held('KPPPPKPPP', [2], false);
    check('hold: holdOnLoss false passes everything, still counts the gap', h.out === 'KPPPPKPPP' && h.stats.rtpGaps === 1 && h.stats.lossHolds === 0, JSON.stringify(h));
    h = held('KPPPKPPPKPP', [1, 6]);
    check('hold: a second loss after the hold ends starts another', h.out === 'KKPKPP' && h.stats.lossHolds === 2, JSON.stringify(h));
    // --- a keyframe asked of the camera after a loss ------------------------
    const asked = (watching, on = true) => {
      const c = { id: 'q', name: 'Q', enabled: true, sources: [{ label: 'sub', type: 'rtsp', url: 'rtsp://192.0.2.9/x', transport: 'multicast', keepMulticast: true }] };
      const reqs = []; let needed = null;
      const keyframes = { request: async (cam, src, opts) => { reqs.push(`${cam.id}/${src.label}`); needed = opts.needed; return 'sent'; }, error: () => null };
      const m = new StreamSession({ ...fake, store: { settings: { ...settings, ffmpeg: { ...settings.ffmpeg, keyframeOnLoss: on } } }, camera: () => c, keyframes }, 'q', 'sub');
      m.log = () => {};
      const p = { multicast: true }; m.active = p;
      if (watching) m.clients.add({});
      m._onRtpLoss(p, 1);
      clearInterval(m.watchdog);
      return { reqs, m, p, needed: () => needed() };
    };
    let a = asked(true);
    await sleep(0);
    check('keyframe on loss: asked of the camera while somebody watches, and counted', a.reqs.join() === 'q/sub' && a.m.stats.keyRequests === 1, JSON.stringify(a.reqs));
    const stillHeld = a.needed();
    a.p.lossHold = 0;
    check('keyframe on loss: a waiting request is needed while the picture is held, not after', stillHeld === true && a.needed() === false);
    check('keyframe on loss: not asked for a stream nobody watches', asked(false).reqs.length === 0);
    const edited = new CameraManager({ settings: DEFAULT_SETTINGS, saveCameras() {}, cameras: [{ id: 'e0', name: 'E0', enabled: true, sources: [{ label: 'main', url: 'test:640x360@25' }] }] });
    let warmed = 0; edited.applyKeepWarm = () => { warmed++; }; edited.probeCamera = async () => {};
    edited.update('e0', { sources: [{ label: 'main', url: 'test:320x180@25' }] });
    check('editing a camera starts its always-on streams again', warmed === 1);
    check('keyframe on loss: keyframeOnLoss false asks nothing', asked(true, false).reqs.length === 0);

    // --- loss history --------------------------------------------------------
    const { LossLog } = require('../server/loss-log');
    const HOUR = 3600000;
    let lt = 1e12, file = null;
    const sess = (id, stats) => ({ cameraId: id, label: 'sub', stats });
    const s1 = sess('a', { rtpGaps: 4, lossHeld: 30, frames: 600, lossHolds: 2 }), s2 = sess('b', { rtpGaps: 0, lossHeld: 0, frames: 900, lossHolds: 0 });
    const lm = { sessions: new Map([['a/sub', s1], ['b/sub', s2]]) };
    const io = { read: () => file, write: (f, d) => { file = JSON.parse(JSON.stringify(d)); }, now: () => lt, timer: false };
    const log = new LossLog(lm, io);
    lt += 60000; log.sample();
    check('loss history: a minute holds only the streams that lost something', JSON.stringify(log.rows) === JSON.stringify([{ t: lt, s: { 'a/sub': [4, 30, 600, 2] } }]), JSON.stringify(log.rows));
    Object.assign(s1.stats, { rtpGaps: 5, lossHeld: 41, frames: 1500, lossHolds: 3 });
    lt += 60000; log.sample();
    check('loss history: the next minute is the difference', JSON.stringify(log.rows[1].s) === JSON.stringify({ 'a/sub': [1, 11, 900, 1] }), JSON.stringify(log.rows[1]));
    lt += 60000; log.sample();
    check('loss history: a minute without loss is an empty row', log.rows.length === 3 && Object.keys(log.rows[2].s).length === 0);
    lm.sessions.set('a/sub', sess('a', { rtpGaps: 2, lossHeld: 8, frames: 100, lossHolds: 1 }));
    lt += 60000; log.sample();
    check('loss history: a session made anew counts from zero', JSON.stringify(log.rows[3].s) === JSON.stringify({ 'a/sub': [2, 8, 100, 1] }), JSON.stringify(log.rows[3]));
    check('loss history: not saved before 5 minutes', file === null);
    lt += 60000; log.sample();
    check('loss history: saved every 5 minutes', !!file && file.rows.length === 5);
    lt += 23 * HOUR;
    const again = new LossLog(lm, io);
    check('loss history: read back after a restart', again.rows.length === 5 && again.rows[0].t === log.rows[0].t);
    lt += HOUR - 60000; again.sample();   // 24 h after the fourth row
    check('loss history: rows older than 24 h are dropped', again.rows.length === 2 && again.rows[0].t === log.rows[4].t, again.rows.map((r) => r.t - 1e12).join());
    lt += 25 * HOUR;
    check('loss history: a file with only old rows starts empty', new LossLog(lm, { ...io, read: () => ({ rows: log.rows }) }).rows.length === 0);

    // --- DVR first: the recorder's relay, with the camera as the fallback -----
    const dvrCam = () => ({ id: 'd', name: 'D', enabled: true, sources: [{ label: 'sub', type: 'rtsp', url: 'rtsp://192.0.2.9/cam', transport: 'tcp', dvrUrl: 'rtsp://192.0.2.8/dvr?channel=1' }] });
    const nd = normaliseCamera({ id: 'n', name: 'N', sources: [
      { label: 'main', url: 'rtsp://h/x', dvrUrl: ' rtsp://dvr/1 ' }, { label: 'sub', url: 'rtsp://h/y', dvrUrl: 'rtsp://h/y' }] });
    check('dvr: dvrUrl survives normaliseCamera, trimmed; one equal to the camera URL is dropped', nd.sources[0].dvrUrl === 'rtsp://dvr/1' && nd.sources[1].dvrUrl === undefined, JSON.stringify(nd.sources));
    check('dvr: a dvrUrl that is not RTSP is dropped', normaliseCamera({ id: 'n2', name: 'N', sources: [{ url: 'rtsp://h/x', dvrUrl: 'http://dvr/1' }] }).sources[0].dvrUrl === undefined);
    const viaDvr = await sources.inputArgs(dvrCam().sources[0], settings, { dvr: true });
    const viaCam = await sources.inputArgs(dvrCam().sources[0], settings, {});
    check('dvr: input is the DVR address over TCP when asked for, the camera otherwise',
      viaDvr.dvr === true && viaDvr.args.includes('rtsp://192.0.2.8/dvr?channel=1') && viaDvr.args[viaDvr.args.indexOf('-rtsp_transport') + 1] === 'tcp'
      && !viaCam.dvr && viaCam.args.includes('rtsp://192.0.2.9/cam'), JSON.stringify([viaDvr.args, viaCam.args]));
    check('dvr: a source without a dvrUrl ignores the request', !(await sources.inputArgs({ type: 'rtsp', url: 'rtsp://192.0.2.9/cam' }, settings, { dvr: true })).dvr);
    const dvrSession = (keepWarm = true) => {
      const c = dvrCam();
      const m = new StreamSession({ ...fake, camera: () => c, keepWarm: () => keepWarm }, 'd', 'sub');
      clearInterval(m.watchdog);
      m.log = () => {};
      const calls = { spawn: 0, recycle: 0 };
      m._spawn = () => { calls.spawn++; }; m._recycle = () => { calls.recycle++; };
      return { m, calls };
    };
    {
      const { m, calls } = dvrSession();
      const wanted = m._useDvr();
      const sent = [];
      m.clients.add({ configSent: true, send: (b) => sent.push(b[1]) });
      const p = { dvr: true }; m.active = p; m.state = 'live'; m.liveSince = Date.now() - 5000; m.lastVideoAt = Date.now();
      m._onExit(p, 1, null, 'The camera stopped sending video');
      check('dvr: wanted first; after the DVR stalls the camera is started at once, not counted as a restart',
        wanted && calls.spawn === 1 && !m._useDvr() && m.restarts.length === 0 && m.stats.restarts === 0 && m.stats.dvrFallbacks === 1,
        JSON.stringify({ wanted, calls, restarts: m.restarts.length, stats: m.stats.dvrFallbacks }));
      const wait = m.noDvrUntil - Date.now();
      check('dvr: the DVR is left alone for dvrRetryMs (5 min)', wait > 299000 && wait <= 300000, `${wait} ms`);
      check('dvr: viewers are told to start afresh, and the reason is kept', sent.includes(0x06) && /stopped sending video/.test(m.dvrError), JSON.stringify({ sent, why: m.dvrError }));
      check('dvr: info() says the camera is played and why', m.info().dvrWanted === true && m.info().dvr === false && /stopped sending video/.test(m.info().dvrError));
      // On the camera now.  Nothing happens until the wait is over; then a make-before-break try.
      const cam2 = { dvr: false, exited: false, startedAt: Date.now() }; m.active = cam2; m.state = 'live'; m.lastVideoAt = Date.now();
      m._watchdog();
      const early = calls.recycle;
      m.noDvrUntil = Date.now() - 1; m.lastVideoAt = Date.now();
      m._watchdog();
      check('dvr: tried again only once its time is up, without stopping the camera stream', early === 0 && calls.recycle === 1 && m.active === cam2, JSON.stringify({ early, calls }));
      // That try exits without a picture: stay on the camera, wait again.
      const again = { dvr: true }; m.pending = again;
      m._onExit(again, 1, null, 'Connection refused');
      check('dvr: a failed retry leaves the camera stream alone and waits again', m.pending === null && m.active === cam2 && m.noDvrUntil > Date.now() + 299000 && calls.spawn === 1 && m.stats.dvrFallbacks === 2);
      const second = m.noDvrUntil - Date.now();
      for (let i = 0; i < 6; i++) m._dvrFailed('Connection refused');
      const capped = m.noDvrUntil - Date.now();
      check('dvr: an unstable DVR waits longer each time (10 min after the second failure), at most an hour', second > 599000 && second <= 600000 && capped > 3599000 && capped <= 3600000, `${second} ms, then ${capped} ms`);
      m.stats.dvrFallbacks = 2;
      // A retry that only has to start again as hev1 is not a failure.
      m.noDvrUntil = 0; const hev = { dvr: true, needsRestart: true }; m.pending = hev;
      m._onExit(hev, 0, null, '');
      check('dvr: a retry restarting for H.265 parameter sets is not held against the DVR', m._useDvr() && m.stats.dvrFallbacks === 2);
    }
    {
      const { m } = dvrSession();
      const p = { dvr: true }; m.active = p; m.state = 'starting';
      m._onExit(p, 1, null, 'method DESCRIBE failed: 401 Unauthorized');
      const hours = (m.noDvrUntil - Date.now()) / 3600000;
      check('dvr: a rejected login is not tried again for 24 h (recorders lock accounts)', hours > 23.9 && hours <= 24, `${hours.toFixed(2)} h`);
      check('dvr: the reason names the DVR, not the camera', m.dvrError === 'The DVR rejected the username or password', m.dvrError);
      m._dvrFailed('rtsp://admin:secret@192.0.2.8:554/dvr: Server returned 5XX Server Error reply');
      check('dvr: a password in the reason is masked', !/secret/.test(m.dvrError) && /admin:\*\*\*@192\.0\.2\.8/.test(m.dvrError), m.dvrError);
    }
    {
      const { m, calls } = dvrSession(false);
      const p = { dvr: true }; m.active = p; m.state = 'starting';
      m._onExit(p, 1, null, 'Connection refused');
      check('dvr: with nobody watching, a DVR failure starts nothing', calls.spawn === 0 && m.state === 'idle');
    }
    {
      // The real thing, FFmpeg stood in for by node (exits at once): the DVR address first, then the camera's.
      answer = 'ok';
      const c = dvrCam(); const dl = [];
      const m = new StreamSession({ ...fake, camera: () => c }, 'd', 'sub');
      m.log = (msg) => dl.push(msg);
      m.addClient({ configSent: false, send() {}, sendConfig() {}, detach() {} });
      await sleep(1500);
      const spawns = dl.filter((l) => l.startsWith('spawn'));
      check('dvr: a stream starts from the DVR address, then falls back to the camera address',
        /192\.0\.2\.8\/dvr.*\(DVR\)/.test(spawns[0] || '') && /192\.0\.2\.9\/cam/.test(spawns[1] || '') && !/\(DVR\)/.test(spawns[1] || '')
        && dl.some((l) => /^DVR: .*playing the camera directly; the DVR is tried again in 5 min/.test(l)), dl.slice(0, 6).join(' | '));
      m.destroy();
    }
    {
      const { CameraManager: CM } = require('../server/cameras');
      const mgr2 = new CM({ settings: DEFAULT_SETTINGS, cameras: [dvrCam()] });
      const sessLive = (dvr) => ({ active: { dvr, multicast: false }, state: 'live', dvrError: dvr ? null : 'The camera stopped sending video' });
      mgr2.sessions.set('d/sub', sessLive(true));
      const onDvr = mgr2.list()[0].variants[0];
      mgr2.sessions.set('d/sub', sessLive(false));
      const onCam = mgr2.list()[0].variants[0];
      check('dvr: the camera list says how each stream arrives', onDvr.delivery === 'dvr' && onDvr.dvrWanted && onDvr.dvrError === null
        && onCam.delivery === 'unicast' && /stopped sending/.test(onCam.dvrError), JSON.stringify([onDvr, onCam]));
    }

    check('keepMulticast survives normaliseCamera',normaliseCamera({ id: 'k', name: 'K', sources: [{ url: 'rtsp://h/x', transport: 'multicast', keepMulticast: true }] }).sources[0].keepMulticast === true);
  } catch (err) {
    check('no exceptions', false, err.stack);
  } finally {
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
