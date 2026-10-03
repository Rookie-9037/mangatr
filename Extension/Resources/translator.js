/* Translation layer. Runs in the background page so the page's own scripts
 * never see the API key and so one batched request can cover a whole manga page
 * instead of one request per balloon.
 *
 * The actual HTTP call belongs to MangaTRProviders; this file owns the parts
 * that are the same whichever model answers: how a page of dialogue is batched,
 * how failures degrade, and what is cached between reads. */
var MangaTRTranslate = (function () {
  "use strict";

  var BATCH_SIZE = 24;
  var MAX_PARALLEL = 2;
  var CACHE_PREFIX = "tr:v2:";

  /* Per-language advice, because hitaphandling and onomatopoeia work nothing
   * like each other. Falls back to a neutral note for languages we have no
   * specific rule for, so a new source language never blocks a translation. */
  var LOCAL_NOTES = {
    ja: "- Hitapları (さん, 君, おれ, 俺) Türkçe konuşma tonuna uygun biçimde ver.\n- Onomatopoeiyi (ドン, バン, ズズ…) Türkçeye uygun ses taklidi olarak çevir.",
    ko: "- Hitapları (-씨, -님) Türkçe konuşma tonuna uygun biçimde ver.\n- Onomatopoeiyi (쿵, 툭) Türkçeye uygun ses taklidi olarak çevir.",
    zh: "- Onomatopoeiyi (砰, 轟) Türkçeye uygun ses taklidi olarak çevir.",
    en: "- Konuşma dilini koru; günlük İngilizce konuşma tonunu abartma.\n- Arka plan efektlerini Türkçeye uygun ses taklidi olarak çevir.",
    es: "- Konuşma dilini koru; günlük İspanyolca konuşma tonunu abartma.\n- Arka plan efektlerini Türkçeye uygun ses taklidi olarak çevir."
  };

  var LATIN_NOTE =
    "- Konuşma dilini koru, günlük konuşma tonunu abartma.\n- Arka plan efektlerini Türkçeye uygun ses taklidi olarak çevir.";

  var cache = null;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // ------------------------------------------------------------------ cache

  function loadCache() {
    if (cache) return Promise.resolve(cache);
    return MangaTR.api()
      .storage.local.get(null)
      .then(function (all) {
        cache = {};
        for (var key in all) {
          if (key.indexOf(CACHE_PREFIX) === 0) cache[key.slice(CACHE_PREFIX.length)] = all[key];
        }
        return cache;
      });
  }

  function flushCache() {
    var payload = {};
    for (var key in cache) payload[CACHE_PREFIX + key] = cache[key];
    return MangaTR.api().storage.local.set(payload);
  }

  function clearCache() {
    cache = {};
    return MangaTR.api().storage.local.get(null).then(function (all) {
      var remove = [];
      for (var key in all) {
        if (key.indexOf(CACHE_PREFIX) === 0) remove.push(key);
      }
      return remove.length ? MangaTR.api().storage.local.remove(remove) : null;
    });
  }

  /* Provider and model are part of the key: DeepSeek's rendering of a line is
   * not Gemini's, and mixing them would show the user inconsistent wording for
   * the same balloon later. */
  function cacheKey(provider, model, text) {
    return provider + "|" + model + "|" + MangaTR.hash(text);
  }

  /* A long reading session can contribute thousands of balloons; cap the map so
   * storage.local does not grow without bound. */
  function trimCache() {
    var keys = Object.keys(cache);
    if (keys.length <= 8000) return;
    keys.sort();
    keys.slice(0, keys.length - 8000).forEach(function (key) {
      delete cache[key];
    });
  }

  // ------------------------------------------------------------- resolution

  /* Keys are kept per provider so switching back and forth does not mean typing
   * the same key twice, and so a DeepSeek key is never sent to Google. */
  function resolveSettings(settings) {
    var provider = MangaTRProviders.has(settings.provider) ? settings.provider : "gemini";
    var providerInfo = MangaTRProviders.get(provider);

    var keys = settings.apiKeys && typeof settings.apiKeys === "object" ? settings.apiKeys : {};
    var key = keys[provider] || "";
    // A key saved by an older build lived in a single `apiKey` field and could
    // only ever have been Gemini's.
    if (!key && provider === "gemini" && settings.apiKey) key = settings.apiKey;

    var model;
    if (provider === "custom") {
      // A custom endpoint has no model list to validate against, and
      // `settings.model` still holds the previously selected provider's model,
      // so only the explicitly typed one may be used here.
      model = String(settings.customModel || "").trim();
    } else {
      model = settings.model;
      var known = (providerInfo.models || []).indexOf(model) !== -1;
      if (!model || !known) model = providerInfo.defaultModel;
    }

    return {
      id: provider,
      provider: providerInfo,
      key: key.trim(),
      model: model,
      base: provider === "custom" ? String(settings.customBase || "").trim() : ""
    };
  }

  // ------------------------------------------------------------------ prompt

  /* `source` is what the page's own detector found. It is passed to the model as
   * a hint only: script detection is decisive for CJK, but a short English or
   * Spanish bubble can be genuinely ambiguous offline, and the model resolves
   * that better than a stopword list. */
  function buildPrompt(items, sourceCode, sourceLabel) {
    var payload = items.map(function (item) {
      return { id: item.id, src: item.text };
    });

    var head =
      "Aşağıdaki metinleri Türkçeye çevir. " +
      "Kaynak dil: " +
      (sourceLabel ? sourceLabel + " (" + sourceCode + ")" : "sen anla, emin değilsen tahmin et") +
      ". " +
      'Yanıt tam olarak {"lang":"<kaynak dil kodu>","items":[{"id":0,"tr":"..."}]} biçiminde olsun. ' +
      "id değerlerini aynen koru.";

    var note = (sourceCode && LOCAL_NOTES[sourceCode]) || LATIN_NOTE;

    return head + "\n" + note + "\n\n" + JSON.stringify(payload);
  }

  // ------------------------------------------------------------------- calls

  function callOnce(target, provider, prompt, attempt) {
    attempt = attempt || 0;

    var request = provider.request(prompt, target.model, target.key, {
      temperature: 0.25,
      // Without this the OpenAI-compatible adapter has no address to call for a
      // self-hosted endpoint, and the request never leaves the page.
      base: target.base
    });

    return fetch(request.url, request.init).then(function (response) {
      if (response.ok) return response.json();

      return response.text().then(function (bodyText) {
        // A 404 means the key cannot see that model, not that the key is bad:
        // Google answers this way for every project that has not used a model
        // before, and vendors retire models on their own schedule. So walk the
        // provider's list instead of trusting one hardcoded fallback that is
        // itself eventually retired.
        if (response.status === 404) {
          var step = nextModel(provider, target);
          if (step) {
            var retry = Object.assign({}, target, { model: step.model, tried: step.tried });
            return callOnce(retry, provider, prompt, 0);
          }
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          return sleep(700 * (attempt + 1)).then(function () {
            return callOnce(target, provider, prompt, attempt + 1);
          });
        }
        throw new Error(
          MangaTRProviders.explainStatus(target.provider, response.status, bodyText, target.model)
        );
      });
    });
  }

  /* The next model on the provider's list that this call has not already tried,
   * together with the updated tried-list. Returning the grown list is what stops
   * the walk: a fixed fallback cannot do this, and a list that is not carried
   * forward just re-requests the first candidate forever.
   * Returns null once the list is exhausted, which turns a 404 into an error. */
  function nextModel(provider, target) {
    var models = provider.models || [];
    var tried = target.tried || [];
    if (tried.indexOf(target.model) === -1) tried = tried.concat([target.model]);
    for (var i = 0; i < models.length; i++) {
      if (tried.indexOf(models[i]) === -1) {
        return { model: models[i], tried: tried };
      }
    }
    return null;
  }

  function normalise(parsed, items) {
    var byId = {};
    (parsed.items || []).forEach(function (entry) {
      if (entry && typeof entry.id === "number" && typeof entry.tr === "string") {
        byId[entry.id] = entry.tr.trim();
      }
    });

    return {
      // Some models answer with the original words when they refuse to
      // translate. Treating that as success would paint the page back onto
      // itself, so a verbatim echo is dropped instead.
      items: items.map(function (item) {
        return { id: item.id, text: byId[item.id] || "" };
      }),
      lang: typeof parsed.lang === "string" ? parsed.lang.toLowerCase().slice(0, 5) : ""
    };
  }

  function translateBatch(items, target, provider, sourceCode, sourceLabel) {
    var prompt = buildPrompt(items, sourceCode, sourceLabel);
    return callOnce(target, provider, prompt, 0).then(function (payload) {
      return normalise(provider.parse(payload), items);
    });
  }

  function chunk(items, size) {
    var out = [];
    for (var i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  function runLimited(tasks, limit) {
    var index = 0;
    var results = new Array(tasks.length);
    function worker() {
      if (index >= tasks.length) return Promise.resolve();
      var current = index++;
      return tasks[current]().then(
        function (value) {
          results[current] = { ok: true, value: value };
        },
        function (error) {
          results[current] = { ok: false, error: error };
        }
      ).then(worker);
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return results;
    });
  }

  // -------------------------------------------------------------- public API

  /* items: [{ id, text }] -> [{ id, text }], plus the language the model
   * reported so the page can tell the user what it thought it was reading. */
  function translate(items, settings, source) {
    if (!items.length) return Promise.resolve({ results: [], errors: [], language: "" });

    var resolved = resolveSettings(settings || {});
    var sourceCode = source && source.code;
    var sourceLabel = source && source.label;

    if (!resolved.key) {
      return Promise.resolve({
        results: [],
        errors: [{ error: "API anahtarı yok. Eklenti simgesine dokun, " + resolved.provider.label + " anahtarını kaydet." }],
        language: ""
      });
    }

    // Checked here rather than inside the request builder: a missing model or
    // address is a configuration mistake, and reporting it up front keeps a
    // throw inside the batch runner from turning the whole page into one
    // opaque failure.
    if (!resolved.model) {
      return Promise.resolve({
        results: [],
        errors: [{ error: "Model seçilmedi. Eklenti ayarlarından bir model yaz." }],
        language: ""
      });
    }

    if (resolved.id === "custom" && !resolved.base) {
      return Promise.resolve({
        results: [],
        errors: [{ error: "Sunucu adresi boş. Eklenti ayarlarından OpenAI uyumlu adresi yaz." }],
        language: ""
      });
    }

    var provider = resolved.provider;
    var target = {
      model: resolved.model,
      tried: [resolved.model],
      key: resolved.key,
      base: resolved.base,
      provider: provider
    };

    return loadCache().then(function () {
      var pending = [];
      var results = [];
      var languages = [];

      items.forEach(function (item) {
        var key = cacheKey(resolved.id, resolved.model, item.text);
        if (cache[key]) {
          results.push({ id: item.id, text: cache[key], cached: true });
        } else {
          pending.push({ id: item.id, text: item.text, cacheKey: key });
        }
      });

      function collectLanguages(entries) {
        entries.forEach(function (entry) {
          if (entry.language) languages.push(entry.language);
        });
      }

      if (!pending.length) return { results: results, errors: [], language: languages[0] || "" };

      var tasks = chunk(pending, BATCH_SIZE).map(function (batch) {
        return function () {
          return translateBatch(batch, target, provider, sourceCode, sourceLabel).then(function (parsed) {
            var texts = batch.map(function (source, i) {
              var text = parsed.items[i] ? parsed.items[i].text : "";
              if (text && text !== source.text) cache[source.cacheKey] = text;
              return { id: source.id, text: text };
            });
            return { items: texts, language: parsed.lang };
          });
        };
      });

      return runLimited(tasks, MAX_PARALLEL).then(function (batchResults) {
        var errors = [];
        batchResults.forEach(function (entry) {
          if (entry.ok) {
            entry.value.items.forEach(function (item) {
              results.push({ id: item.id, text: item.text });
            });
            collectLanguages([entry.value]);
          } else {
            errors.push({ error: String(entry.error && entry.error.message ? entry.error.message : entry.error) });
          }
        });
        trimCache();
        flushCache();
        // The first batch's answer is as good a guess as any; the rest of a page
        // is the same language.
        return { results: results, errors: errors, language: languages[0] || "" };
      });
    });
  }

  return {
    translate: translate,
    resolveSettings: resolveSettings,
    clearCache: clearCache,
    cacheSize: function () {
      return loadCache().then(function (c) {
        return Object.keys(c).length;
      });
    }
  };
})();