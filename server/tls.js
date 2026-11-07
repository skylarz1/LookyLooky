'use strict';
/**
 * HTTPS for a LAN box.
 *
 * WebCodecs (the decode path) exists only in a secure context, so browsers on
 * other machines need HTTPS.  On first boot this makes a small local CA and a
 * server certificate signed by it, then reissues the server certificate when
 * the list of names changes or it nears expiry — always from the same CA, so
 * a device that trusted the CA once keeps trusting every reissue.
 *
 * Install /ca.crt on each viewing device once (the /setup page walks through
 * it for iPad/iPhone, Android, Windows and macOS).  Apple's rules for
 * user-trusted CAs are followed: RSA 2048, SHA-256, subjectAltName,
 * serverAuth EKU, and at most 825 days of validity.
 *
 * Bring your own certificate instead with LOOKY_TLS_CERT / LOOKY_TLS_KEY, or
 * terminate TLS in a reverse proxy and use the HTTP port.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function localNames() {
  const names = new Set(['localhost', '127.0.0.1', '::1', 'lookylooky']);
  try { names.add(os.hostname()); } catch { /* ignore */ }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) names.add(i.address);
  }
  for (const n of String(process.env.LOOKY_HOSTNAMES || '').split(',').map((s) => s.trim()).filter(Boolean)) names.add(n);
  return [...names].sort();
}

const isIp = (s) => net4.test(s) || s.includes(':');
const net4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function openssl(args, cwd) {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function needsReissue(certFile, names) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (new Date(cert.validTo).getTime() - Date.now() < 30 * 86400000) return true;
    const san = cert.subjectAltName || '';
    return names.some((n) => !san.includes(isIp(n) ? `IP Address:${n}` : `DNS:${n}`));
  } catch { return true; }
}

function ensureCertificates(dataDir) {
  if (process.env.LOOKY_TLS_CERT && process.env.LOOKY_TLS_KEY) {
    return {
      cert: fs.readFileSync(process.env.LOOKY_TLS_CERT), key: fs.readFileSync(process.env.LOOKY_TLS_KEY),
      ca: null, custom: true, names: [],
    };
  }
  const dir = path.join(dataDir, 'certs');
  fs.mkdirSync(dir, { recursive: true });
  const caKey = path.join(dir, 'ca.key'), caCrt = path.join(dir, 'ca.crt');
  const key = path.join(dir, 'server.key'), crt = path.join(dir, 'server.crt');
  const names = localNames();

  if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
    console.log('[tls] creating local certificate authority');
    const cn = `LookyLooky Local CA (${os.hostname()})`;
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', caKey, '-out', caCrt, '-subj', `/CN=${cn}/O=LookyLooky`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', 'subjectKeyIdentifier=hash'], dir);
    try { fs.unlinkSync(crt); } catch { /* none */ }
  }

  if (needsReissue(crt, names)) {
    console.log(`[tls] issuing server certificate for: ${names.join(', ')}`);
    const csr = path.join(dir, 'server.csr'), ext = path.join(dir, 'server.ext');
    const san = names.map((n) => (isIp(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
    fs.writeFileSync(ext, [
      'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth', `subjectAltName=${san}`, 'authorityKeyIdentifier=keyid', 'subjectKeyIdentifier=hash',
    ].join('\n'));
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', key, '-out', csr, '-subj', '/CN=lookylooky/O=LookyLooky'], dir);
    openssl(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', crt,
      '-days', '825', '-sha256', '-extfile', ext], dir);
    for (const f of [csr, ext]) try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  return { cert: fs.readFileSync(crt), key: fs.readFileSync(key), ca: fs.readFileSync(caCrt), custom: false, names };
}

/**
 * Copy the server certificate and key (never the CA key) into `dir`, for a
 * reverse proxy that serves our names on 443 with the same certificate, so
 * devices that trust our CA keep trusting the proxy.  Files are replaced
 * atomically and only when they change.
 */
function exportCertificates(t, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = { 'server.crt': t.cert, 'server.key': t.key };
  if (t.ca) files['ca.crt'] = t.ca;
  for (const [name, data] of Object.entries(files)) {
    const out = path.join(dir, name);
    try { if (fs.readFileSync(out).equals(data)) continue; } catch { /* not there yet */ }
    fs.writeFileSync(out + '.tmp', data, { mode: name.endsWith('.key') ? 0o600 : 0o644 });
    fs.renameSync(out + '.tmp', out);
  }
}

module.exports = { ensureCertificates, exportCertificates, localNames };
