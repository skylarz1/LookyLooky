/*
 * noodleman — the page message bus.
 *
 * A small topic API, so widgets written against it port by
 * renaming:
 *
 *   noodleman.Subscribe('story-set', (m) => { ... m.topic, m.value ... });
 *   noodleman.Broadcast({ topic: 'current-objective', value: { StoryID, Objective } });
 *   noodleman.Unsubscribe(token);
 *
 * Plus two bridges, so a LookyLooky page embedded in another stack can be
 * driven from outside without sharing any code:
 *
 *   • parent / opener window:  window.postMessage({ noodleman: { topic, value } }, '*')
 *     sent INTO an iframe (or from the window that opened this one) is
 *     re-broadcast here.  With `relay: true` set on a Broadcast, the message
 *     also goes OUT to the parent.
 *   • other tabs of this origin: a BroadcastChannel named 'noodleman'.
 *
 * Context the camera wall reads (all optional; a standalone page sets none):
 *   noodleman.stories   { [storyId]: { Options: { CameraLayoutID } } }
 *   noodleman.storyID   current story id
 *   noodleman.settings  { CamerasEnabled: true }
 */
(function () {
  'use strict';
  if (window.noodleman) return;

  var subs = {};
  var nextToken = 1;
  var channel = null;
  try { channel = new BroadcastChannel('noodleman'); } catch (e) { /* old Safari */ }

  function deliver(msg) {
    var list = subs[msg.topic];
    if (!list) return;
    list.slice().forEach(function (s) {
      try { s.fn(msg); } catch (err) { console.error('[noodleman] ' + msg.topic + ':', err); }
    });
  }

  var bus = {
    stories: window.stories || {},
    storyID: window.storyID != null ? window.storyID : null,
    settings: { CamerasEnabled: true },

    Subscribe: function (topic, fn) {
      var token = nextToken++;
      (subs[topic] = subs[topic] || []).push({ token: token, fn: fn });
      return token;
    },

    Unsubscribe: function (token) {
      Object.keys(subs).forEach(function (t) {
        subs[t] = subs[t].filter(function (s) { return s.token !== token; });
      });
    },

    /** { topic, value, relay? } — relay also posts it to the parent window and other tabs. */
    Broadcast: function (msg, opts) {
      if (!msg || !msg.topic) return;
      var clean = { topic: String(msg.topic), value: msg.value };
      deliver(clean);
      if (msg.relay || (opts && opts.relay)) {
        if (window.parent && window.parent !== window) {
          try { window.parent.postMessage({ noodleman: clean }, '*'); } catch (e) { /* ignore */ }
        }
        if (channel) { try { channel.postMessage(clean); } catch (e) { /* uncloneable */ } }
      }
    },
  };

  window.addEventListener('message', function (ev) {
    var m = ev.data && ev.data.noodleman;
    if (!m || !m.topic) return;
    // Only the embedding page (or the window that opened us) may drive this one.
    if (ev.source !== window.parent && ev.source !== window.opener && ev.source !== window) return;
    // A host may set context the same way: { noodleman: { topic: 'noodleman-context', value: { stories, storyID, settings } } }
    if (m.topic === 'noodleman-context' && m.value) {
      if (m.value.stories) bus.stories = m.value.stories;
      if (m.value.storyID != null) bus.storyID = m.value.storyID;
      if (m.value.settings) bus.settings = m.value.settings;
    }
    deliver({ topic: String(m.topic), value: m.value });
  });

  if (channel) channel.onmessage = function (ev) { if (ev.data && ev.data.topic) deliver(ev.data); };

  window.noodleman = bus;
})();
