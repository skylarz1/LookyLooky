/*
 * LookyLooky browser compatibility — load as a classic <script> in <head>,
 * before any module, on every camera page.
 *
 *  1. Fullscreen API.  The viewer uses the standard API (requestFullscreen,
 *     document.fullscreenElement, 'fullscreenchange').  iPadOS before 16.4
 *     has it only prefixed (webkit*); iPhone Safari has no element
 *     fullscreen at all.  Prefixed is mapped onto standard; where there is
 *     nothing, a CSS "pseudo-fullscreen" (fixed, full viewport) stands in, so
 *     the dashboard's fullscreen views and per-pane fullscreen still work.
 *
 *  2. Capabilities.  window.LookyCompat says what this browser can do:
 *       secure     isSecureContext (WebCodecs and AudioWorklet need it)
 *       webcodecs  VideoDecoder present — full-motion video possible
 *       audio      'opus' (AudioDecoder) | 'pcm' (Safari < 26, iPad 6th gen) | 'none'
 *
 *  3. HTTPS.  LookyCompat.requireSecure(port) sends a plain-HTTP page on a
 *     LAN address to the HTTPS port, unless the URL
 *     says ?insecure=1 — then the page stays and runs thumbnail-only.
 *     LookyCompat.insecureBanner() explains, with links to fix it.
 */
(function () {
  'use strict';
  var d = document, E = Element.prototype;

  /* --- 1. Fullscreen ------------------------------------------------------ */
  if (!('fullscreenElement' in d)) {
    if ('webkitFullscreenElement' in d || E.webkitRequestFullscreen) {
      Object.defineProperty(d, 'fullscreenElement', { get: function () { return d.webkitFullscreenElement || d.webkitCurrentFullScreenElement || null; } });
      Object.defineProperty(d, 'fullscreenEnabled', { get: function () { return !!d.webkitFullscreenEnabled; } });
      E.requestFullscreen = function () {
        var el = this;
        return new Promise(function (resolve, reject) {
          try { (el.webkitRequestFullscreen || el.webkitRequestFullScreen).call(el); resolve(); } catch (e) { reject(e); }
        });
      };
      d.exitFullscreen = function () {
        return new Promise(function (resolve) { try { (d.webkitExitFullscreen || d.webkitCancelFullScreen).call(d); } catch (e) { /* ignore */ } resolve(); });
      };
      d.addEventListener('webkitfullscreenchange', function () { d.dispatchEvent(new Event('fullscreenchange')); });
    } else {
      // iPhone: no element fullscreen.  Fake it with fixed positioning.
      var current = null;
      var style = d.createElement('style');
      style.textContent = '.claudifer-pseudo-fs{position:fixed!important;inset:0!important;width:100vw!important;'
        + 'height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;'
        + 'z-index:2147483000!important;margin:0!important;border-radius:0!important;background:#000}'
        + 'html.claudifer-pseudo-fs-on,html.claudifer-pseudo-fs-on body{overflow:hidden!important}';
      (d.head || d.documentElement).appendChild(style);
      Object.defineProperty(d, 'fullscreenElement', { get: function () { return current; } });
      Object.defineProperty(d, 'fullscreenEnabled', { get: function () { return true; } });
      var change = function () { d.dispatchEvent(new Event('fullscreenchange')); };
      E.requestFullscreen = function () {
        if (current && current !== this) current.classList.remove('claudifer-pseudo-fs');
        current = this;
        if (this !== d.documentElement) this.classList.add('claudifer-pseudo-fs');
        d.documentElement.classList.add('claudifer-pseudo-fs-on');
        setTimeout(change, 0);
        return Promise.resolve();
      };
      d.exitFullscreen = function () {
        if (current) current.classList.remove('claudifer-pseudo-fs');
        current = null;
        d.documentElement.classList.remove('claudifer-pseudo-fs-on');
        setTimeout(change, 0);
        return Promise.resolve();
      };
      d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && current) d.exitFullscreen(); });
    }
  }

  /* --- 2. Capabilities ----------------------------------------------------- */
  var AC = window.AudioContext || window.webkitAudioContext;
  var compat = {
    secure: !!window.isSecureContext,
    webcodecs: typeof window.VideoDecoder !== 'undefined',
    audio: typeof window.AudioDecoder !== 'undefined' ? 'opus'
         : (AC && typeof window.AudioWorkletNode !== 'undefined' ? 'pcm' : 'none'),
    ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  };

  /* --- 3. HTTPS -------------------------------------------------------------- */
  compat.httpsUrl = function (port) {
    port = String(port || '').trim();
    if (!/^\d+$/.test(port) || port === '0') return null;
    return 'https://' + location.hostname + (port === '443' ? '' : ':' + port) + location.pathname + location.search + location.hash;
  };

  compat.requireSecure = function (port) {
    if (location.protocol === 'https:' || window.isSecureContext) return false;
    if (/[?&]insecure=1\b/.test(location.search)) return false;
    var url = compat.httpsUrl(port);
    if (!url) return false;
    location.replace(url);
    return true;
  };

  compat.insecureBanner = function (port, opts) {
    opts = opts || {};
    if (compat.webcodecs) return null;
    var https = compat.httpsUrl(port);
    var why = compat.secure
      ? 'This browser has no WebCodecs (it needs Safari 16.4+, Chrome/Edge 94+ or Firefox 130+).'
      : 'Full-motion video needs a secure (HTTPS) connection, and this page was opened over plain HTTP.';
    var el = d.createElement('div');
    el.className = 'looky-banner';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99990;background:rgba(20,22,30,.96);color:#e1e4ed;'
      + 'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:10px 14px;'
      + 'border-top:1px solid #2a2d3a;display:flex;gap:12px;align-items:center;flex-wrap:wrap;';
    el.innerHTML = '<span style="flex:1;min-width:220px;"><b style="color:#fbbf24;">Thumbnails only.</b> ' + why + '</span>'
      + (https && !compat.secure ? '<a href="' + https + '" style="color:#f2711c;">Open the secure page</a>' : '')
      + '<a href="/setup.html" style="color:#f2711c;">How to fix</a>'
      + '<button type="button" style="background:none;border:1px solid #2a2d3a;color:#8b8fa3;border-radius:4px;padding:2px 8px;cursor:pointer;">Dismiss</button>';
    el.querySelector('button').onclick = function () { el.remove(); };
    if (!opts.hidden) (d.body || d.documentElement).appendChild(el);
    return el;
  };

  window.LookyCompat = compat;
})();
