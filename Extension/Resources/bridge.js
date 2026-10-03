/* Shared plumbing for the background page and content scripts.
 * Manifest v2 content scripts share one isolated world, so a top-level var is
 * how these files see each other. */
var MangaTR = (function () {
  "use strict";

  /* Must match the host app's bundle identifier for runtime.sendNativeMessage
   * to reach SafariWebExtensionHandler. */
  var APP_ID = "com.mangatr.MangaTR";
  var NATIVE_AVAILABLE = "nativeAvailable";

  var DEFAULTS = {
    enabled: true,
    hideOriginal: true,
    fontScale: 1.0,
    fontFamily: "auto",
    // "auto" is the default and the recommended mode: the page's own script
    // detection plus the model decide what language a page is in.
    sourceLanguages: "auto",
    provider: "gemini",
    model: "gemini-2.5-flash",
    // Keys live per provider so switching services never reuses one vendor's
    // secret for another.
    apiKeys: {},
    // Kept for keys saved by older builds; migrated into apiKeys on first save.
    apiKey: "",
    customBase: "",
    customModel: "",
    minPixelWidth: 620,
    minPixelHeight: 400,
    autoTranslate: true,
    showPill: true
  };

  var nativeSupport = null;

  function api() {
    if (typeof browser !== "undefined") return browser;
    return chrome;
  }

  function hash(text) {
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
    }
    return h1.toString(36) + "-" + h2.toString(36) + "-" + text.length.toString(36);
  }

  function getSettings() {
    return api().storage.local.get(DEFAULTS).then(function (stored) {
      var merged = {};
      for (var key in DEFAULTS) {
        merged[key] = Object.prototype.hasOwnProperty.call(stored, key) && stored[key] !== null && stored[key] !== undefined
          ? stored[key]
          : DEFAULTS[key];
      }
      return merged;
    });
  }

  function saveSettings(patch) {
    return api().storage.local.set(patch).then(getSettings);
  }

  function send(message) {
    return api().runtime.sendMessage(message);
  }

  /* nativeSupport is cached because a failed probe means the extension bundle
   * is not wired up, and retrying it per image would be pure latency. */
  function nativeAvailable() {
    if (nativeSupport !== null) return Promise.resolve(nativeSupport);
    return api()
      .runtime.sendNativeMessage(APP_ID, { type: "ping" })
      .then(function (reply) {
        nativeSupport = !!(reply && reply.ok);
        return nativeSupport;
      })
      .catch(function () {
        nativeSupport = false;
        return false;
      });
  }

  function native(message) {
    return api().runtime.sendNativeMessage(APP_ID, message);
  }

  return {
    APP_ID: APP_ID,
    NATIVE_AVAILABLE: NATIVE_AVAILABLE,
    DEFAULTS: DEFAULTS,
    api: api,
    hash: hash,
    getSettings: getSettings,
    saveSettings: saveSettings,
    send: send,
    native: native,
    nativeAvailable: nativeAvailable
  };
})();