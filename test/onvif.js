/**
 * Multicast without a camera:  node test/onvif.js
 * Starts nothing else and needs no LookyLooky instance.  A fake ONVIF camera
 * (WS-Security digest checked) answers discovery; then the FFmpeg input
 * arguments, the multicast fallback memory and the cameras.xml import are
 * checked directly.
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
process.env.LOOKY_DATA_DIR = process.env.LOOKY_DATA_DIR || path.join(__dirname, 'out', 'onvif-data');
const { discover, lookupMulticast } = require('../server/onvif');
const { inputArgs, noteMulticast, multicastState, clearMulticastMemory } = require('../server/sources');
const { normaliseCamera, parseCamerasXml, DEFAULT_SETTINGS } = require('../server/config');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const USER = 'admin', PASS = 'pa!ss';
// Three profiles: main has a multicast group and its own multicast URI; sub
// answers RTP-Multicast only with Protocol RTSP (and the unicast URI); third
// has no multicast at all.
const PROFILES = [
  { token: 'p0', name: 'MainStream', w: 1920, h: 1080, group: ['239.1.1.5', 40000, 'false'],
    uri: 'rtsp://127.0.0.1:554/cam/realmonitor?channel=1&amp;subtype=0', mc: { UDP: 'rtsp://127.0.0.1:554/cam/realmonitor?channel=1&amp;subtype=0&amp;multicast=true' } },
  { token: 'p1', name: 'SubStream', w: 640, h: 360, group: ['0.0.0.0', 0, 'false'],
    uri: 'rtsp://127.0.0.1:554/cam/realmonitor?channel=1&amp;subtype=1', mc: { RTSP: 'rtsp://127.0.0.1:554/cam/realmonitor?channel=1&amp;subtype=1' } },
  { token: 'p2', name: 'Third', w: 800, h: 450, group: null,
    uri: 'rtsp://127.0.0.1:554/cam/realmonitor?channel=1&amp;subtype=2', mc: {} },
];

const env = (body) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><s:Body>${body}</s:Body></s:Envelope>`;
const fault = (text) => env(`<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">${text}</s:Text></s:Reason></s:Fault>`);

function authorised(xml) {
  const g = (n) => (new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([^<]*)<`).exec(xml) || [])[1];
  const nonce = g('Nonce'), created = g('Created'), digest = g('Password');
  if (g('Username') !== USER || !nonce || !created) return false;
  const want = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(PASS)])).digest('base64');
  return want === digest;
}

function camera(req, body) {
  if (/GetSystemDateAndTime/.test(body)) {
    const d = new Date();
    return env(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
  }
  if (!authorised(body)) return { status: 400, xml: fault('Sender not Authorized') };
  const port = req.socket.localPort;
  if (/GetCapabilities/.test(body)) {
    return env(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.9.9.9:${port}/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>`);
  }
  if (/GetProfiles/.test(body)) {
    return env(`<trt:GetProfilesResponse>${PROFILES.map((p) => `<trt:Profiles token="${p.token}" fixed="true"><tt:Name>${p.name}</tt:Name>`
      + `<tt:VideoEncoderConfiguration token="v${p.token}"><tt:Name>enc</tt:Name><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${p.w}</tt:Width><tt:Height>${p.h}</tt:Height></tt:Resolution>`
      + (p.group ? `<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>${p.group[0]}</tt:IPv4Address></tt:Address><tt:Port>${p.group[1]}</tt:Port><tt:TTL>64</tt:TTL><tt:AutoStart>${p.group[2]}</tt:AutoStart></tt:Multicast>` : '')
      + `</tt:VideoEncoderConfiguration></trt:Profiles>`).join('')}</trt:GetProfilesResponse>`);
  }
  if (/GetStreamUri/.test(body)) {
    const p = PROFILES.find((x) => body.includes(`<ProfileToken>${x.token}</ProfileToken>`));
    const stream = (/<Stream[^>]*>([^<]+)</.exec(body) || [])[1];
    const protocol = (/<Protocol>([^<]+)</.exec(body) || [])[1];
    const uri = stream === 'RTP-Multicast' ? p.mc[protocol] : p.uri;
    if (!uri) return { status: 400, xml: fault('Unsupported StreamSetup') };
    return env(`<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${uri}</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`);
  }
  return { status: 400, xml: fault('Unknown action') };
}

(async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = camera(req, body);
      const { status, xml } = typeof r === 'string' ? { status: 200, xml: r } : r;
      res.writeHead(status, { 'Content-Type': 'application/soap+xml' }); res.end(xml);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // --- ONVIF discovery -------------------------------------------------
    const d = await discover({ host: '127.0.0.1', port, user: USER, pass: PASS });
    const by = Object.fromEntries(d.streams.map((s) => [s.token, s]));
    check('onvif: all three profiles found', d.streams.length === 3, d.streams.map((s) => s.profileName).join(', '));
    const m0 = by.p0 && by.p0.multicast;
    check('onvif: main reports its multicast group', !!m0 && m0.address === '239.1.1.5' && m0.port === 40000 && m0.ttl === 64 && m0.autoStart === false, JSON.stringify(m0 && { ...m0, rtspUrl: undefined }));
    check('onvif: main multicast URI (Protocol UDP), with credentials',
      !!m0 && (() => { const u = new URL(m0.rtspUrl.replace(/^rtsp:/, 'http:'));
        return decodeURIComponent(u.username) === USER && decodeURIComponent(u.password) === PASS
          && u.host === '127.0.0.1:554' && u.search === '?channel=1&subtype=0&multicast=true'; })(),
      m0 && m0.rtspUrl.replace(/:[^:@/]*@/, ':***@'));
    const m1 = by.p1 && by.p1.multicast;
    check('onvif: sub multicast URI via the Protocol RTSP retry; 0.0.0.0 group ignored',
      !!m1 && m1.rtspUrl === by.p1.rtspUrl && m1.address === null, JSON.stringify(m1 && { ...m1, rtspUrl: undefined }));
    check('onvif: a profile without multicast reports none', by.p2 && by.p2.multicast === null);
    check('onvif: suggested main/sub with their multicast URIs',
      d.suggested.main === by.p0.rtspUrl && d.suggested.sub === by.p1.rtspUrl
      && d.suggested.mainMulticast === m0.rtspUrl && d.suggested.subMulticast === by.p1.rtspUrl);

    // --- lookup for a camera already set up (credentials from its URL) ----
    const existing = normaliseCamera({ id: 'old', name: 'old', sources: [
      { label: 'main', url: 'rtsp://admin:pa%21ss@127.0.0.1:554/cam/realmonitor?channel=1&subtype=0' },
      { label: 'sub', url: 'rtsp://admin:pa%21ss@127.0.0.1/some/other/path' },
    ] });
    const look = await lookupMulticast(existing, { port });
    const [lm, ls] = look.sources;
    check('lookup: main matched by address, gets its multicast URI and group',
      lm.matched === 'address' && lm.multicast && lm.multicast.address === '239.1.1.5' && lm.multicast.rtspUrl === m0.rtspUrl, `${lm.matched} ${lm.profileName}`);
    check('lookup: sub with an unknown address matched as ONVIF\'s suggested sub', ls.matched === 'sub' && ls.profileName === 'SubStream');
    let lookErr = '';
    try { await lookupMulticast(normaliseCamera({ id: 'bad', sources: [{ url: 'rtsp://admin:wrong@127.0.0.1:554/x' }] }), { port }); } catch (err) { lookErr = err.message; }
    check('lookup: wrong password is reported', /rejected the username or password/.test(lookErr), lookErr);

    // --- sources as saved -------------------------------------------------
    const cam = normaliseCamera({ id: 'mc', name: 'mc', sources: [
      { label: 'main', url: d.suggested.main, transport: 'multicast', multicastUrl: d.suggested.mainMulticast },
      { label: 'sub', url: d.suggested.sub, transport: 'multicast', multicastUrl: d.suggested.subMulticast },
    ] });
    const [main, sub] = cam.sources;
    check('config: multicast transport and URL kept', main.transport === 'multicast' && main.multicastUrl === m0.rtspUrl);
    check('config: a multicast URL equal to the unicast one is not stored', sub.transport === 'multicast' && !('multicastUrl' in sub));
    check('config: unknown transport becomes tcp', normaliseCamera({ id: 'x', sources: [{ url: 'rtsp://h/s', transport: 'bogus' }] }).sources[0].transport === 'tcp');

    // --- FFmpeg input arguments -------------------------------------------
    const S = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const argv = async (src, opts, settings = S) => {
      const a = await inputArgs(src, settings, { key: 'mc/main', ...opts });
      const i = a.args.indexOf('-rtsp_transport');
      return { t: a.args[i + 1], url: a.args[a.args.indexOf('-i') + 1], multicast: !!a.multicast };
    };
    clearMulticastMemory();
    let a = await argv(main, {});
    check('ffmpeg: multicast source → udp_multicast on its multicast URL', a.t === 'udp_multicast' && a.url === main.multicastUrl && a.multicast);
    a = await argv(sub, { key: 'mc/sub' });
    check('ffmpeg: no separate multicast URL → udp_multicast on the unicast URL', a.t === 'udp_multicast' && a.url === sub.url);
    a = await argv(main, { multicast: false });
    check('ffmpeg: fallback → tcp on the unicast URL', a.t === 'tcp' && a.url === main.url && !a.multicast);
    noteMulticast('mc/main', false);
    a = await argv(main, {});
    check('ffmpeg: a stream that just fell back skips multicast', a.t === 'tcp' && multicastState('mc/main') === 'failed');
    noteMulticast('mc/main', true);
    a = await argv(main, {});
    check('ffmpeg: … and uses it again once it has worked', a.t === 'udp_multicast' && multicastState('mc/main') === 'ok');
    clearMulticastMemory('mc/');
    check('ffmpeg: memory cleared per camera', multicastState('mc/main') === 'unknown');

    const tcp = { label: 'main', type: 'rtsp', url: 'rtsp://h/s', transport: 'tcp' };
    a = await argv(tcp, { key: 'p/main' });
    check('ffmpeg: setting "off" leaves a tcp source on tcp', a.t === 'tcp');
    a = await argv(tcp, { key: 'p/main' }, { ...S, ffmpeg: { ...S.ffmpeg, multicast: 'prefer' } });
    check('ffmpeg: setting "prefer" tries multicast on a tcp source', a.t === 'udp_multicast');
    a = await argv({ ...tcp, transport: 'udp' }, { key: 'p/main', multicast: false }, { ...S, ffmpeg: { ...S.ffmpeg, multicast: 'prefer' } });
    check('ffmpeg: "prefer" on a udp source falls back to udp', a.t === 'udp');
    const http1 = await inputArgs({ label: 'main', type: 'http', url: 'http://h/x.mjpg', transport: 'multicast' }, { ...S, ffmpeg: { ...S.ffmpeg, multicast: 'prefer' } }, {});
    check('ffmpeg: non-RTSP sources never use multicast', !http1.multicast && !http1.args.includes('udp_multicast'));

    // --- cameras.xml ------------------------------------------------------
    const xml = `<cameras><camera-settings multicast="prefer"/><camera camera-id="c1" name="C1">`
      + `<source label="main" url="rtsp://h/main" transport="multicast" multicast-url="rtsp://h/main?mc=1"/>`
      + `<source label="sub" url="rtsp://h/sub" transport="udp"/></camera></cameras>`;
    const parsed = parseCamerasXml(xml);
    const c1 = normaliseCamera(parsed.cameras[0]);
    check('cameras.xml: transport="multicast" and multicast-url imported',
      c1.sources[0].transport === 'multicast' && c1.sources[0].multicastUrl === 'rtsp://h/main?mc=1' && c1.sources[1].transport === 'udp');
    check('cameras.xml: <camera-settings multicast="prefer">', parsed.settings.ffmpeg.multicast === 'prefer');
  } catch (err) {
    check('no exceptions', false, err.stack);
  } finally {
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
