/* Popup: settings live in the extension's own storage so the page's scripts
 * never see the API key. */
(function () {
  "use strict";

  var els = {
    status: document.getElementById("status"),
    enabled: document.getElementById("enabled"),
    provider: document.getElementById("provider"),
    providerHint: document.getElementById("providerHint"),
    apiKey: document.getElementById("apiKey"),
    keyState: document.getElementById("keyState"),
    saveKey: document.getElementById("saveKey"),
    testKey: document.getElementById("testKey"),
    model: document.getElementById("model"),
    modelField: document.getElementById("modelField"),
    customBase: document.getElementById("customBase"),
    customBaseField: document.getElementById("customBaseField"),
    customModel: document.getElementById("customModel"),
    customModelField: document.getElementById("customModelField"),
    autoLanguage: document.getElementById("autoLanguage"),
    sourceField: document.getElementById("sourceField"),
    sourceLanguages: document.getElementById("sourceLanguages"),
    langState: document.getElementById("langState"),
    fontScale: document.getElementById("fontScale"),
    fontScaleValue: document.getElementById("fontScaleValue"),
    fontFamily: document.getElementById("fontFamily"),
    hideOriginal: document.getElementById("hideOriginal"),
    showPill: document.getElementById("showPill"),
    clearCache: document.getElementById("clearCache"),
    cacheSize: document.getElementById("cacheSize")
  };

  var providers = [];
  var byId = {};
  var keyTimer = null;

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

  /* The background page is the single writer for settings, but if it is asleep
   * (Safari tore the non-persistent event page down) write locally so the key is
   * never lost. Both paths end in storage.local. */
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

  // ------------------------------------------------------------------ keys

  function keyFor(settings, providerId) {
    var keys = settings.apiKeys || {};
    if (keys[providerId]) return keys[providerId];
    // Older builds had one Gemini-only field; adopt it rather than asking again.
    if (providerId === "gemini" && settings.apiKey) return settings.apiKey;
    return "";
  }

  function withKey(settings, providerId, value) {
    var keys = Object.assign({}, settings.apiKeys || {});
    if (value) keys[providerId] = value;
    else delete keys[providerId];
    var patch = { apiKeys: keys };
    // Retire the legacy field once it has been copied over, so there is only
    // one place a key can live.
    if (settings.apiKey) patch.apiKey = "";
    return patch;
  }

  function showKeyState(text, tone) {
    els.keyState.textContent = text;
    els.keyState.className = "hint" + (tone ? " is-" + tone : "");
  }

  function showKeySaved() {
    showKeyState("Anahtar kaydedildi ✓", "ok");
  }

  /* The bug that started all this: the field only listened for `change`, which
   * never fires when the popup is dismissed mid-typing. iOS Safari gives no
   * other chance to persist, so the keystrokes are saved as they happen. */
  function saveKeyNow() {
    var value = els.apiKey.value.trim();
    var providerId = els.provider.value;
    if (keyTimer) {
      clearTimeout(keyTimer);
      keyTimer = null;
    }
    showKeyState("Kaydediliyor…", null);
    return MangaTR.getSettings().then(function (settings) {
      return persist(withKey(settings, providerId, value));
    }).then(function () {
      showKeySaved();
      return value;
    }).catch(function (error) {
      showKeyState("Kaydedilemedi: " + (error && error.message ? error.message : error), "warn");
      // Rethrown so the "Kaydet" button cannot report success over a failed
      // write, and so the provider switch does not race ahead of it.
      throw error;
    });
  }

  function scheduleKeySave() {
    showKeyState("Yazılıyor…", null);
    if (keyTimer) clearTimeout(keyTimer);
    keyTimer = setTimeout(function () {
      keyTimer = null;
      // The failure is already on screen; this timer has no caller to tell.
      saveKeyNow().catch(function () {});
    }, 500);
  }

  // -------------------------------------------------------------- provider

  function currentProvider() {
    return byId[els.provider.value] || providers[0];
  }

  function fillModels(provider, settings) {
    var models = (provider.models || []).slice();
    if (provider.id === "custom") {
      els.modelField.hidden = true;
    } else if (!models.length) {
      els.modelField.hidden = true;
    } else {
      els.modelField.hidden = false;
      els.model.innerHTML = "";
      models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        els.model.appendChild(option);
      });
      var stored = settings && settings.model;
      els.model.value = models.indexOf(stored) !== -1 ? stored : provider.defaultModel;
    }

    var custom = provider.id === "custom";
    els.customBaseField.hidden = !custom;
    els.customModelField.hidden = !custom;
    if (custom && settings) {
      els.customBase.value = settings.customBase || "";
      els.customModel.value = settings.customModel || "";
    }
  }

  function applyProvider(providerId, settings) {
    var provider = byId[providerId] || providers[0];
    els.provider.value = provider.id;
    els.apiKey.value = keyFor(settings, provider.id);
    els.apiKey.placeholder = provider.keyPlaceholder || "";
    els.providerHint.textContent = provider.hint || "";
    fillModels(provider, settings);
    if (els.apiKey.value) showKeySaved();
    else showKeyState("Anahtar kaydedilmedi.", null);
  }

  // --------------------------------------------------------------- language

  function describeLanguage(settings) {
    if (settings.sourceLanguages === "auto" || !settings.sourceLanguages) {
      els.autoLanguage.checked = true;
      els.sourceField.hidden = true;
      showLanguageHint("Her sayfa kendi dilinde okunur ve çevrilir.", null);
      return;
    }
    els.autoLanguage.checked = false;
    els.sourceField.hidden = false;
    els.sourceLanguages.value = settings.sourceLanguages;

    if (settings.sourceLanguages === "tr") {
      showLanguageHint("Türkçe sayfalara dokunulmaz.", "warn");
    } else {
      var label = MangaTRLang.describe(null, settings);
      showLanguageHint("Yalnız " + label + " okunacak. Sayfa zaten bu dilde değilse çeviri bozulur.", "warn");
    }
  }

  function showLanguageHint(text, tone) {
    els.langState.textContent = text;
    els.langState.className = "hint" + (tone ? " is-" + tone : "");
  }

  // ------------------------------------------------------------------- init

  function load(settings) {
    els.enabled.checked = !!settings.enabled;
    els.fontScale.value = settings.fontScale || 1;
    els.fontScaleValue.textContent = Number(settings.fontScale || 1).toFixed(2);
    els.fontFamily.value = settings.fontFamily || "auto";
    els.hideOriginal.checked = settings.hideOriginal !== false;
    els.showPill.checked = settings.showPill !== false;
    describeLanguage(settings);
    applyProvider(settings.provider || "gemini", settings);
  }

  MangaTR.send({ type: "providers:list" })
    .then(function (reply) {
      providers = (reply && reply.ok && reply.result) || [];
      providers.forEach(function (provider) {
        byId[provider.id] = provider;
        var option = document.createElement("option");
        option.value = provider.id;
        option.textContent = provider.label;
        els.provider.appendChild(option);
      });
      return MangaTR.getSettings();
    })
    .then(function (settings) {
      load(settings);
      setStatus(settings.enabled ? "Etkin" : "Kapalı", settings.enabled ? "is-ok" : "is-warn");
      refreshCacheSize();

return MangaTR.nativeAvailable().then(function (available) {
        if (!available) {
          setStatus(
            "OCR bağlantısı yok (" + (MangaTR.nativeErrorText() || "bilinmeyen") + ") — uygulamayı bir kez aç",
            "is-warn"
          );
        }
      });
    })
    .catch(function (error) {
      setStatus("Ayar okunamadı: " + (error && error.message ? error.message : error), "is-warn");
    });

  // ---------------------------------------------------------------- events

  bindCheckbox(els.enabled, "enabled");
  bindCheckbox(els.hideOriginal, "hideOriginal");
  bindCheckbox(els.showPill, "showPill");

  els.enabled.addEventListener("change", function () {
    setStatus(els.enabled.checked ? "Etkin" : "Kapalı", els.enabled.checked ? "is-ok" : "is-warn");
  });

  els.apiKey.addEventListener("input", scheduleKeySave);
  els.apiKey.addEventListener("change", function () {
    saveKeyNow().catch(function () {});
  });

  // Last chance before iOS tears the popup down mid-edit.
  window.addEventListener("pagehide", function () {
    if (keyTimer) saveKeyNow().catch(function () {});
  });

  els.saveKey.addEventListener("click", function () {
    saveKeyNow().then(function () {
      els.saveKey.textContent = "Kaydedildi ✓";
      setTimeout(function () {
        els.saveKey.textContent = "Kaydet";
      }, 1600);
    }).catch(function () {
      // saveKeyNow has already put the reason on screen.
    });
  });

  els.testKey.addEventListener("click", function () {
    saveKeyNow().then(function () {
      els.testKey.disabled = true;
      els.testKey.textContent = "Sınanıyor…";
      showKeyState("Bağlantı sınanıyor…", null);
      MangaTR.send({ type: "settings:test" })
        .then(function (reply) {
          if (reply && reply.ok && reply.result) {
            showKeyState("Bağlantı çalışıyor ✓ (" + reply.result.model + ")", "ok");
          } else {
            showKeyState((reply && reply.error) || "Sınama başarısız", "warn");
          }
        })
        .catch(function (error) {
          showKeyState(String((error && error.message) || error), "warn");
        })
        .then(function () {
          els.testKey.disabled = false;
          els.testKey.textContent = "Test et";
        });
    }).catch(function () {
      els.testKey.disabled = false;
      els.testKey.textContent = "Test et";
    });
  });

  els.provider.addEventListener("change", function () {
    var providerId = els.provider.value;
    // The pending debounce belongs to the provider being switched away from,
    // so it has to land before the new provider is stored; otherwise both writes
    // read the same snapshot and one of them wins at random.
    var flushed = keyTimer ? saveKeyNow() : Promise.resolve();
    flushed.then(function () {
      return MangaTR.getSettings().then(function (settings) {
        return persist({ provider: providerId }).then(function (next) {
          applyProvider(providerId, next || settings);
        });
      });
    }).catch(function () {
      // Already reported by saveKeyNow; restoring the stored provider keeps the
      // dropdown from claiming a switch that did not happen.
      MangaTR.getSettings().then(function (settings) {
        applyProvider(settings.provider, settings);
      });
    });
  });

  els.model.addEventListener("change", function () {
    persist({ model: els.model.value });
  });

  els.customBase.addEventListener("change", function () {
    persist({ customBase: els.customBase.value.trim() });
  });

  els.customModel.addEventListener("change", function () {
    persist({ customModel: els.customModel.value.trim() });
  });

  els.autoLanguage.addEventListener("change", function () {
    if (els.autoLanguage.checked) {
      persist({ sourceLanguages: "auto" }).then(function (settings) {
        describeLanguage(settings);
      });
    } else {
      // Turning auto off must not silently leave "auto" selected behind the
      // hidden control; give it something real to show.
      var fallback = "en";
      els.sourceLanguages.value = fallback;
      persist({ sourceLanguages: fallback }).then(function (settings) {
        describeLanguage(settings);
      });
    }
  });

  els.sourceLanguages.addEventListener("change", function () {
    persist({ sourceLanguages: els.sourceLanguages.value }).then(function (settings) {
      describeLanguage(settings);
    });
  });

  els.fontScale.addEventListener("input", function () {
    els.fontScaleValue.textContent = Number(els.fontScale.value).toFixed(2);
  });

  els.fontScale.addEventListener("change", function () {
    persist({ fontScale: Number(els.fontScale.value) });
  });

  els.fontFamily.addEventListener("change", function () {
    persist({ fontFamily: els.fontFamily.value });
  });

  els.clearCache.addEventListener("click", function () {
    MangaTR.send({ type: "cache:clear" }).then(function () {
      els.cacheSize.textContent = "temizlendi";
    });
  });
})();