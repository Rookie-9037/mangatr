/* Background hub. Everything the content script cannot do for itself (network
 * with a key attached, cross-origin image downloads, storage writes) happens
 * here. */
(function () {
  "use strict";

  var api = MangaTR.api();

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var step = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function fetchImageBytes(url, referer) {
    function attempt(withReferer) {
      var options = { credentials: "omit", cache: "force-cache" };
      if (withReferer && referer) options.referrer = referer;
      return fetch(url, options);
    }
    return attempt(true)
      .catch(function () {
        return attempt(false);
      })
      .then(function (response) {
        if (!response.ok) {
          var error = new Error("Görsel indirilemedi (HTTP " + response.status + ")");
          error.status = response.status;
          throw error;
        }
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        return { ok: true, b64: arrayBufferToBase64(buffer) };
      });
  }

  function broadcastSettings(settings) {
    api.tabs
      .query({})
      .then(function (tabs) {
        tabs.forEach(function (tab) {
          if (tab.id === undefined || !tab.url) return;
          if (!/^https?:/i.test(tab.url)) return;
          api.tabs
            .sendMessage(tab.id, { type: "settings:changed", settings: settings })
            .catch(function () {
              /* no content script in that tab */
            });
        });
      })
      .catch(function () {});
  }

  var handlers = {
    "settings:get": function () {
      return MangaTR.getSettings();
    },

    "settings:save": function (message) {
      return MangaTR.saveSettings(message.patch || {}).then(function (settings) {
        broadcastSettings(settings);
        return settings;
      });
    },

    translate: function (message) {
      return MangaTR.getSettings().then(function (settings) {
        // content.js sends its own detection result; fall back to the popup
        // setting only when the page never got far enough to sniff the text.
        var source = message.source || null;
        if (!source && MangaTRLang) {
          var label = MangaTRLang.describe(null, settings);
          if (label) source = { code: settings.sourceLanguages, label: label };
        }
        return MangaTRTranslate.translate(message.items || [], settings, source);
      });
    },

    "providers:list": function () {
      return MangaTRProviders.list();
    },

    /* The popup's "Test et" button. Runs against the stored key so the answer
     * reflects what a real page would get, not what is in the text field. */
    "settings:test": function () {
      return MangaTR.getSettings().then(function (settings) {
        var resolved = MangaTRTranslate.resolveSettings(settings);
        if (!resolved.key) throw new Error("Önce API anahtarı kaydet");
        return MangaTRProviders.probe(
          resolved.id,
          resolved.model,
          resolved.key,
          resolved.base
        );
      });
    },

    /* Page OCR when Vision is unavailable, done by a vision model instead. The
     * image arrives as base64 from the content script because that is the only
     * side that can put it on a canvas without tainting it. */
    "ocr:vision": function (message) {
      return MangaTR.getSettings().then(function (settings) {
        var resolved = MangaTRTranslate.resolveSettings(settings);
        if (!resolved.key) throw new Error("Önce API anahtarını kaydet");
        if (!MangaTRProviders.visionOCR) {
          throw new Error("Bu sürümde görsel okuma yok");
        }
        return MangaTRProviders.visionOCR(
          MangaTRProviders.get(resolved.id),
          resolved.model,
          resolved.key,
          message.image,
          {}
        ).then(function (blocks) {
          return { blocks: blocks };
        });
      });
    },

    "image:fetch": function (message) {
      return fetchImageBytes(message.url, message.referer).catch(function (error) {
        return { ok: false, error: String(error.message || error) };
      });
    },

    "cache:clear": function () {
      return MangaTRTranslate.clearCache().then(function () {
        return { ok: true };
      });
    },

    "cache:size": function () {
      return MangaTRTranslate.cacheSize();
    },

    "native:probe": function () {
      return MangaTR.nativeAvailable();
    },

    ping: function () {
      return { ok: true, version: api.runtime.getManifest().version };
    }
  };

  api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;
    var handler = handlers[message.type];
    if (!handler) return false;

    Promise.resolve()
      .then(function () {
        return handler(message, sender);
      })
      .then(
        function (result) {
          sendResponse({ ok: true, result: result });
        },
        function (error) {
          sendResponse({ ok: false, error: String((error && error.message) || error) });
        }
      );
    return true;
  });
})();