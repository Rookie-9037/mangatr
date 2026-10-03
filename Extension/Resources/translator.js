/* Gemini translation layer. Runs in the background page so the page's own
 * scripts never see the API key and so one batched request can cover a whole
 * manga page instead of one request per balloon. */
var MangaTRTranslate = (function () {
  "use strict";

  var ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";
  var BATCH_SIZE = 24;
  var MAX_PARALLEL = 2;
  var FALLBACK_MODEL = "gemini-2.0-flash";
  var CACHE_PREFIX = "tr:v1:";

  var SYSTEM = [
    "Sen profesyonel bir manga çevirmenis. Japonca manga konuşma balonlarını ve anlatım kutularını doğal, akıcı Türkçeye çevirirsin.",
    "Kurallar:",
    "- Anlamı aktar, uydurma veya özetleme.",
    "- Balon kısa kalsın; gereksiz sözcük ekleme.",
    "- Hitapları (さん, 君, おれ, 俺) Türkçe konuşma tonuna uygun biçimde ver.",
    "- Onomatopoeiyi (ドン, バン, ズズ…) Türkçeye uygun ses taklidi olarak çevir.",
    "- Noktalama ve ünlemleri koru.",
    "- Romaji yazma, açıklama ekleme, tırnak içinde çeviri verme.",
    "- Her girdi için tam olarak bir çıktı üret, girdi sırasını koru."
  ].join("\n");

  var SCHEMA = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        tr: { type: "string" }
      },
      required: ["id", "tr"]
    }
  };

  var cache = null;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

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

  function cacheKey(model, text) {
    return model + "|" + MangaTR.hash(text);
  }

  /* A page can contribute hundreds of balloons over a long reading session;
   * cap the map so storage.local does not grow without bound. */
  function trimCache() {
    var keys = Object.keys(cache);
    if (keys.length <= 8000) return;
    keys.sort();
    keys.slice(0, keys.length - 8000).forEach(function (key) {
      delete cache[key];
    });
  }

  function buildPrompt(items) {
    var payload = items.map(function (item) {
      return { id: item.id, ja: item.text };
    });
    return (
      "Aşağıdaki manga metinlerini Türkçeye çevir. " +
      "Çıktı, her girdi için { id, tr } alanlarından oluşan bir JSON dizisi olsun. " +
      "id değerlerini aynen koru.\n\n" +
      JSON.stringify(payload)
    );
  }

  function callModel(model, apiKey, prompt, attempt) {
    attempt = attempt || 0;
    var url = ENDPOINT + encodeURIComponent(model) + ":generateContent";
    var body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.25,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: SCHEMA
      }
    };

    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (response.ok) return response.json();

      if (response.status === 404 && model !== FALLBACK_MODEL) {
        // Older API keys and some regions do not expose 2.5 yet.
        return callModel(FALLBACK_MODEL, apiKey, prompt, attempt);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        return sleep(700 * (attempt + 1)).then(function () {
          return callModel(model, apiKey, prompt, attempt + 1);
        });
      }
      return response.text().then(function (bodyText) {
        var error = new Error("Gemini HTTP " + response.status + ": " + bodyText.slice(0, 300));
        error.status = response.status;
        throw error;
      });
    });
  }

  function parseReply(payload) {
    var candidates = (payload && payload.candidates) || [];
    for (var i = 0; i < candidates.length; i++) {
      var parts = (candidates[i].content && candidates[i].content.parts) || [];
      for (var j = 0; j < parts.length; j++) {
        if (parts[j].text) {
          try {
            var parsed = JSON.parse(parts[j].text);
            if (Array.isArray(parsed)) return parsed;
          } catch (error) {
            /* fall through to the next candidate part */
          }
        }
      }
    }
    throw new Error("Gemini yanıtı çözümlenemedi");
  }

  function translateBatch(items, model, apiKey) {
    return callModel(model, apiKey, buildPrompt(items)).then(function (payload) {
      var parsed = parseReply(payload);
      var byId = {};
      parsed.forEach(function (entry) {
        if (entry && typeof entry.id === "number" && typeof entry.tr === "string") {
          byId[entry.id] = entry.tr.trim();
        }
      });
      return items.map(function (item) {
        return { id: item.id, text: byId[item.id] || "" };
      });
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
      return tasks[current]().then(function (value) {
        results[current] = { ok: true, value: value };
      }, function (error) {
        results[current] = { ok: false, error: error };
      }).then(worker);
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, tasks.length); i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return results;
    });
  }

  /* items: [{ id, text }] -> [{ id, text }]. Already-cached entries cost no
   * network; anything still missing is sent in as few requests as possible. */
  function translate(items, settings) {
    if (!items.length) return Promise.resolve({ results: [], errors: [] });

    var model = settings.model || "gemini-2.5-flash";
    var apiKey = settings.apiKey;

    return loadCache().then(function () {
      if (!apiKey) {
        return {
          results: [],
          errors: [{ error: "API anahtarı girilmedi. Eklenti simgesine dokunup anahtarı kaydet." }]
        };
      }

      var pending = [];
      var results = [];

      items.forEach(function (item) {
        var key = cacheKey(model, item.text);
        if (cache[key]) {
          results.push({ id: item.id, text: cache[key], cached: true });
        } else {
          pending.push({ id: item.id, text: item.text, cacheKey: key });
        }
      });

      if (!pending.length) return { results: results, errors: [] };

      var batches = chunk(pending, BATCH_SIZE);
      var tasks = batches.map(function (batch) {
        return function () {
          return translateBatch(batch, model, apiKey).then(function (translated) {
            // Remap through the batch order so ids survive the model's reorder.
            return batch.map(function (source, i) {
              var text = translated[i] ? translated[i].text : "";
              if (text) cache[source.cacheKey] = text;
              return { id: source.id, text: text };
            });
          });
        };
      });

      return runLimited(tasks, MAX_PARALLEL).then(function (batchResults) {
        var errors = [];
        batchResults.forEach(function (entry) {
          if (entry.ok) {
            entry.value.forEach(function (item) {
              results.push({ id: item.id, text: item.text });
            });
          } else {
            errors.push({ error: String(entry.error && entry.error.message ? entry.error.message : entry.error) });
          }
        });
        trimCache();
        flushCache();
        return { results: results, errors: errors };
      });
    });
  }

  return {
    translate: translate,
    clearCache: clearCache,
    cacheSize: function () {
      return loadCache().then(function (c) {
        return Object.keys(c).length;
      });
    }
  };
})();