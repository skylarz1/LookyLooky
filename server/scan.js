'use strict';
/**
 * Subnet scan for the Scan Network dialog: TCP-connect every host in a range
 * on the usual camera ports and report what answers, with the HTTP Server
 * header when there is one (it usually names the vendor).
 *
 * Works from a bridged container — outbound connections to the LAN are NATed
 * like any other.  (ONVIF WS-Discovery multicast would not be, which is why
 * this is a port scan.)
 */

const net = require('net');
const http = require('http');

const PORTS = [554, 8554, 80, 8080, 8000, 443];

function tcpOpen(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const end = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(timeoutMs, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

function serverHeader(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 1500, headers: { 'User-Agent': 'lookylooky-scan' } }, (res) => {
      res.resume();
      resolve(res.headers.server || res.headers['www-authenticate']?.match(/realm="([^"]+)"/)?.[1] || '');
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

/**
 * @param {string} base  first three octets, e.g. "192.168.1"
 * @param {(event:string, data:object)=>void} emit
 * @param {{aborted:boolean}} signal
 */
async function scan(base, start, end, emit, signal) {
  const hosts = [];
  for (let i = Math.max(1, start); i <= Math.min(254, end); i++) hosts.push(`${base}.${i}`);
  const total = hosts.length;
  let scanned = 0, found = 0, next = 0;
  const worker = async () => {
    while (next < hosts.length && !signal.aborted) {
      const ip = hosts[next++];
      const open = [];
      await Promise.all(PORTS.map(async (p) => { if (await tcpOpen(ip, p)) open.push(p); }));
      if (open.length && !signal.aborted) {
        open.sort((a, b) => PORTS.indexOf(a) - PORTS.indexOf(b));
        const hp = open.find((p) => p === 80 || p === 8080 || p === 8000);
        const server = hp ? await serverHeader(ip, hp) : '';
        found++;
        emit('found', { ip, ports: open, server });
      }
      scanned++;
      if (!signal.aborted) emit('progress', { scanned, total });
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  if (!signal.aborted) emit('done', { found });
}

module.exports = { scan, tcpOpen };
