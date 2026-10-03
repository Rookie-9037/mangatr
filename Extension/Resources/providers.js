/* Which AI service does the translating?
 *
 * MangaTR is not tied to one vendor. Every provider here is just a different way
 * of asking the same question ("translate these lines to Turkish") and a
 * different shape of answer, so the adapter surface is deliberately tiny:
 *
 *   keyHint(key)     -> does this look like a key for this provider
 *   request(prompt)  -> { url, init } for the HTTP call
 *   parse(payload)   -> { lang, items: [{ id, tr }] } out of whatever JSON came back
 *
 * Adding a vendor means adding one entry here, nothing else. */
var MangaTRProviders = (function () {
  "use strict";

  /* DeepSeek, Groq, OpenRouter, Together and anything self-hosted all speak the
   * same OpenAI chat-completions dialect, so one adapter covers all of them and
   * only the base URL differs. */
  function openAICompatible(config) {
    return {
      id: config.id,
      label: config.label,
      // Short names are what people recognise; the full URL goes in the hint.
      hint: config.hint,
      docsUrl: config.docsUrl || "",
      keyHint: config.keyHint || /^sk[-_]/i,
      keyPlaceholder: config.keyPlaceholder || "sk-…",
      models: config.models,
      defaultModel: config.defaultModel,

      request: function (prompt, model, key, options) {
        var settings = options || {};
        var base = settings.base || config.base;
        if (!base) throw new Error("Sunucu adresi boş");
        return {
          url: base.replace(/\/+$/, "") + "/chat/completions",
          init: {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + key
            },
            body: JSON.stringify({
              model: model,
              temperature: settings.temperature == null ? 0.25 : settings.temperature,
              // Nudges most vendors into emitting a bare JSON object instead of
              // wrapping it in prose or a markdown fence.
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: config.system },
                { role: "user", content: prompt }
              ]
            })
          }
        };
      },

      parse: function (payload) {
        var choices = (payload && payload.choices) || [];
        var raw = choices[0] && choices[0].message && choices[0].message.content;
        if (typeof raw !== "string" || !raw.trim()) {
          throw new Error("Model yanıt vermedi");
        }
        return JSON.parse(stripFence(raw));
      }
    };
  }

  /* Models that wrap their answer in ```json fences despite being told not to.
   * Small models do this constantly, and a parse failure would look like a
   * broken key to the user. */
  function stripFence(text) {
    var trimmed = text.trim();
    var fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1] : trimmed;
  }

  var CHAT_SYSTEM = [
    "Sen profesyonel bir çevirmensin. Konuşma balonlarını ve anlatım kutularını kaynak dilden doğal, akıcı Türkçeye çevirirsin.",
    "Her zaman JSON nesnesi döndür: { \"lang\": \"<kaynak dil kodu>\", \"items\": [ { \"id\": 0, \"tr\": \"...\" } ] }",
    "id değerlerini girdiyle birebir aynen koru.",
    "Türkçe çeviri yapma; kaynak zaten Türkçe iste onu olduğu gibi döndür ve lang alanına \"tr\" yaz.",
    "Açıklama, tırnak içinde çeviri veya ek yorum yazma."
  ].join("\n");

  var GEMINI_SCHEMA = {
    type: "object",
    properties: {
      lang: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            tr: { type: "string" }
          },
          required: ["id", "tr"]
        }
      }
    },
    required: ["lang", "items"]
  };

/* Declared as its own variable rather than inline in the list below, so the
 * request body can name it without depending on `this`. */
var GEMINI = {
  id: "gemini",
  label: "Google Gemini",
  hint: "aistudio.google.com → API anahtarı al",
  docsUrl: "https://aistudio.google.com/apikey",
  keyHint: /^AIza/,
  keyPlaceholder: "AIza…",
  /* Google's model line moves fast and access is not uniform: 2.0 is shut down
   * entirely, and 2.5 answers 404 for any project that has not used it before —
   * which is every brand new key. So the list leads with the current stable
   * models and keeps 2.5 last for older projects that still have access. */
  models: [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite"
  ],
  defaultModel: "gemini-3.8-flash",
  system: CHAT_SYSTEM,

  request: function (prompt, model, key, options) {
    var settings = options || {};
    return {
      url:
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: GEMINI.system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            // Sampling parameters are left out on purpose: the 3.x migration
            // notes drop them, and pinning the output with the JSON schema below
            // is what actually keeps the answer in shape.
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: GEMINI_SCHEMA
          }
        })
      }
    };
  },

  parse: function (payload) {
    var candidates = (payload && payload.candidates) || [];
    for (var i = 0; i < candidates.length; i++) {
      var parts = (candidates[i].content && candidates[i].content.parts) || [];
      for (var j = 0; j < parts.length; j++) {
        if (!parts[j].text) continue;
        try {
          var parsed = JSON.parse(stripFence(parts[j].text));
          if (parsed && Array.isArray(parsed.items)) return parsed;
        } catch (error) {
          /* try the next part */
        }
      }
    }
    throw new Error("Gemini yanıtı çözümlenemedi");
  }
};

var PROVIDERS = [
  GEMINI,

  openAICompatible({
    id: "deepseek",
    label: "DeepSeek",
    hint: "platform.deepseek.com → API anahtarı",
    docsUrl: "https://platform.deepseek.com/api_keys",
    base: "https://api.deepseek.com/v1",
    keyHint: /^sk-/,
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    system: CHAT_SYSTEM
  }),

  openAICompatible({
    id: "groq",
    label: "Groq (çok hızlı)",
    hint: "console.groq.com → API anahtarı",
    docsUrl: "https://console.groq.com/keys",
    base: "https://api.groq.com/openai/v1",
    keyHint: /^gsk_/,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    defaultModel: "llama-3.3-70b-versatile",
    system: CHAT_SYSTEM
  }),

  openAICompatible({
    id: "openrouter",
    label: "OpenRouter (birçok model)",
    hint: "openrouter.ai → API anahtarı",
    docsUrl: "https://openrouter.ai/keys",
    base: "https://openrouter.ai/api/v1",
    keyHint: /^sk-or-/,
    models: [
      "google/gemini-2.5-flash",
      "anthropic/claude-3.5-haiku",
      "openai/gpt-4o-mini",
      "deepseek/deepseek-chat"
    ],
    defaultModel: "google/gemini-2.5-flash",
    system: CHAT_SYSTEM
  }),

  /* Escape hatch for anyone with their own server, a proxy, or Ollama on the
   * same network. The base URL is a setting, so no new code is needed. */
  openAICompatible({
    id: "custom",
    label: "Diğer (OpenAI uyumlu)",
    hint: "Kendi sunucu adresin + anahtarın",
    base: "",
    keyHint: /./,
    keyPlaceholder: "anahtar…",
    models: [],
    defaultModel: "",
    system: CHAT_SYSTEM
  })
];

  var BY_ID = {};
  PROVIDERS.forEach(function (provider) {
    BY_ID[provider.id] = provider;
  });

  function get(id) {
    return BY_ID[id] || BY_ID.gemini;
  }

  function has(id) {
    return !!BY_ID[id];
  }

  /* A one-line probe used by the popup's "Test et" button. Cheaper and far more
   * useful than a real page: it tells the user whether the key itself works. */
  function probe(id, model, key, base) {
    var provider = get(id);
    var request = provider.request(
      'Sadece şunu döndür, başka hiçbir şey yazma: {"lang":"en","items":[{"id":0,"tr":"Merhaba"}]}',
      model,
      key,
      { temperature: 0, base: base }
    );
    return fetch(request.url, request.init).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(explainStatus(provider, response.status, text));
        });
      }
      return response.json().then(function (payload) {
        var parsed = provider.parse(payload);
        if (!parsed || !parsed.items || !parsed.items.length) {
          throw new Error("Model beklenen biçimde yanıt vermedi");
        }
        return { ok: true, label: provider.label, model: model };
      });
    });
  }

  /* Vendors all word their errors differently; the user only needs to know
   * whether to fix the key, the model, or the network. `model` is the one that
   * actually failed — naming the first model on the list instead sent people
   * looking at a model they had never selected. */
  function explainStatus(provider, status, text, model) {
    var detail = String(text || "").slice(0, 200);
    if (status === 401 || status === 403) {
      return "Anahtar geçersiz (" + status + "). " + provider.hint;
    }
    if (status === 404) {
      var attempted = model || provider.models[0] || "?";
      return (
        "Model bulunamadı: " + attempted + " (" + status + "). " +
        "Bu anahtar bu modele erişemiyor; listedeki başka bir modeli dene."
      );
    }
    if (status === 402) {
      // DeepSeek and the other metered vendors answer with the raw vendor JSON
      // here, which tells the user nothing they can act on. Prepaid balance is
      // the single most common reason a first run fails.
      return (
        "Hesapta kredi yok (402). " + provider.label +
        " ücretli çalışıyor; bakiye yüklemelisin ya da ücretsiz kotolu bir servis seç. " +
        (provider.hint || "")
      );
    }
    if (status === 400) {
      return "İstek reddedildi (400). Model adı veya sunucu adresi yanlış olabilir. " + detail;
    }
    if (status === 429) {
      return "Kota doldu veya hız sınırı (429). Biraz sonra tekrar dene.";
    }
    if (status >= 500) {
      return "Servis hatası (" + status + "). " + detail;
    }
    return "HTTP " + status + ": " + detail;
  }

  return {
    list: function () {
      return PROVIDERS.map(function (provider) {
        return {
          id: provider.id,
          label: provider.label,
          hint: provider.hint,
          docsUrl: provider.docsUrl,
          keyPlaceholder: provider.keyPlaceholder,
          models: provider.models,
          defaultModel: provider.defaultModel
        };
      });
    },
    get: get,
    has: has,
    probe: probe,
    explainStatus: explainStatus
  };
})();