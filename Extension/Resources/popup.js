/* Popup: settings live in the extension's own storage so the page's scripts
 * never see the API key. */
(function () {
  "use strict";

  var els = {
    status: document.getElementById("status"),
    enabled: document.getElementById("enabled"),
    apiKey: document.getElementById("apiKey"),
    keyState: document.getElementById("keyState"),
    model: document.getElementById("model"),
    fontScale: document.getElementById("fontScale"),
    fontScaleValue: document.getElementById("fontScaleValue"),
    hideOriginal: document.getElementById("hideOriginal"),
    showPill: document.getElementById("showPill"),
    clearCache: document.getElementById("clearCache"),
    cacheSize: document.getElementById("cacheSize")
  };

  function setStatus(text, tone) {
    els.status.textContent = text;
    els.status.className = tone || "";
  }

  function refreshCacheSize() {
    return MangaTR.send({ type: "cache:size" })
      .then(function (reply) {
        var count = reply && reply.ok ? reply.result : 0;
        els.cacheSize.textContent = count ? count + " metin önbellekte" : "önbellek boş";
      })
      .catch(function () {
        els.cacheSize.textContent = "";
      });
  }

  function persist(patch) {
    return MangaTR.send({ type: "settings:save", patch: patch }).catch(function () {
      return MangaTR.saveSettings(patch);
    });
  }

  function bindCheckbox(element, key) {
    element.addEventListener("change", function () {
      var patch = {};
      patch[key] = element.checked;
      persist(patch);
    });
  }

  function load(settings) {
    els.enabled.checked = !!settings.enabled;
    els.apiKey.value = settings.apiKey || "";
    els.model.value = settings.model || MangaTR.DEFAULTS.model;
    els.fontScale.value = settings.fontScale || 1;
    els.fontScaleValue.textContent = Number(settings.fontScale || 1).toFixed(2);
    els.hideOriginal.checked = settings.hideOriginal !== false;
    els.showPill.checked = settings.showPill !== false;

    if (settings.apiKey) {
      els.keyState.textContent = "Anahtar kayıtlı.";
      els.keyState.className = "hint is-ok";
    } else {
      els.keyState.textContent = "Anahtar girilmedi. Manga çevrilmez.";
      els.keyState.className = "hint is-warn";
    }
  }

  MangaTR.getSettings().then(function (settings) {
    load(settings);
    setStatus(settings.enabled ? "Etkin" : "Kapalı", settings.enabled ? "is-ok" : "is-warn");
    refreshCacheSize();

    return MangaTR.nativeAvailable().then(function (available) {
      if (!available) {
        setStatus("OCR bağlantısı yok — uygulamayı aç", "is-warn");
      }
    });
  });

  bindCheckbox(els.enabled, "enabled");
  bindCheckbox(els.hideOriginal, "hideOriginal");
  bindCheckbox(els.showPill, "showPill");

  els.enabled.addEventListener("change", function () {
    setStatus(els.enabled.checked ? "Etkin" : "Kapalı", els.enabled.checked ? "is-ok" : "is-warn");
  });

  els.apiKey.addEventListener("change", function () {
    var value = els.apiKey.value.trim();
    persist({ apiKey: value }).then(function (settings) {
      load(settings);
    });
  });

  els.model.addEventListener("change", function () {
    persist({ model: els.model.value });
  });

  els.fontScale.addEventListener("input", function () {
    els.fontScaleValue.textContent = Number(els.fontScale.value).toFixed(2);
  });

  els.fontScale.addEventListener("change", function () {
    persist({ fontScale: Number(els.fontScale.value) });
  });

  els.clearCache.addEventListener("click", function () {
    MangaTR.send({ type: "cache:clear" }).then(function () {
      els.cacheSize.textContent = "temizlendi";
    });
  });
})();