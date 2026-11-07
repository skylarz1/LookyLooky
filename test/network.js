/**
 * Network errors without a camera:  node test/network.js
 * Needs no LookyLooky instance.  Checks the TCP knock that tells an
 * unreachable camera from one that answers, the STREAM_PROBLEM wire layout,
 * the "camera network is down" check, and that a stream whose camera is off
 * the network waits for it (no FFmpeg every 30 s) and restarts the moment it
 * answers.
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
      m._onMulticastLoss(p, 2); m._onMulticastLoss(p, 2);
      return { recycled, gaps: m.stats.rtpGaps, off: m.noMulticastUntil > Date.now() };
    };
    const plain = lossy(false), kept = lossy(true);
    check('multicast loss: 3 gaps in a minute → unicast', plain.recycled === 1 && plain.off, JSON.stringify(plain));
    check('multicast loss: keepMulticast stays on multicast, still counts the gaps', kept.recycled === 0 && !kept.off && kept.gaps === 4, JSON.stringify(kept));
    check('keepMulticast survives normaliseCamera', normaliseCamera({ id: 'k', name: 'K', sources: [{ url: 'rtsp://h/x', transport: 'multicast', keepMulticast: true }] }).sources[0].keepMulticast === true);
  } catch (err) {
    check('no exceptions', false, err.stack);
  } finally {
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
