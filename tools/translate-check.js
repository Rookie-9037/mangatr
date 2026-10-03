/* Exercises the provider layer and the batching/cache logic in translator.js
 * with a fake fetch and a fake storage.local, so no key and no network are
 * needed to check request shape, id remapping and failure recovery.
 *
 * The fake model builds its answer from the request it receives, including the
 * ids, which is what makes the id-mapping and batching assertions meaningful. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RES = path.join(__dirname, "..", "Extension", "Resources");
const read = (name) => fs.readFileSync(path.join(RES, name), "utf8");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "TAMAM " : "HATA  ") + name + (detail ? " — " + detail : ""));
}

const store = {};
let calls = [];

function okResponse(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload))
  });
}

function errorResponse(status, body) {
  return Promise.resolve({ ok: false, status: status, text: () => Promise.resolve(body || "") });
}

/* Pulls the [{ id, src }] array out of whichever prompt shape was sent. */
function requestItems(init) {
  const body = JSON.parse(init.body);
  const text = body.contents ? body.contents[0].parts[0].text : body.messages[body.messages.length - 1].content;
  return JSON.parse(text.slice(text.lastIndexOf("[")));
}

function respond(urlText, init) {
  const items = requestItems(init).map(function (item) {
    return { id: item.id, tr: "TR:" + item.src };
  });
  const answer = { lang: "es", items: items };

  if (urlText.indexOf("generativelanguage") !== -1) {
    return okResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
  }
  // Chat models fence their JSON half the time; parsing has to survive that.
  return okResponse({
    choices: [{ message: { content: "```json\n" + JSON.stringify(answer) + "\n```" } }]
  });
}

const ctx = {
  console: console,
  // translator.js backs off with setTimeout between retries; a vm context has
  // no timers of its own, so the retry path would silently never run.
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  fetch: function (url, init) {
    const urlText = String(url);
    calls.push({
      url: urlText,
      init: init,
      providerId: urlText.indexOf("deepseek") !== -1 ? "deepseek"
        : urlText.indexOf("generativelanguage") !== -1 ? "gemini"
        : "generic"
    });
    return respond(urlText, init);
  }
};

ctx.MangaTR = {
  /* Must actually discriminate: a length-only stand-in makes "satır 10" and
   * "401 dene" the same cache entry and quietly invalidates the tests. */
  hash: function (text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  },
  api: function () {
    return {
      storage: {
        local: {
          get: function () { return Promise.resolve(Object.assign({}, store)); },
          set: function (patch) { Object.assign(store, patch); return Promise.resolve(); },
          remove: function (keys) {
            (keys || []).forEach(function (k) { delete store[k]; });
            return Promise.resolve();
          }
        }
      }
    };
  }
};

vm.createContext(ctx);
vm.runInContext(read("providers.js"), ctx);
vm.runInContext(read("translator.js"), ctx);

const Providers = ctx.MangaTRProviders;
const Translate = ctx.MangaTRTranslate;

const SPANISH = "¿Y qué más dices?";
const CACHE_TEXT = "önbellek satırı";
const NEEDS_KEY_TEXT = "anahtar istiyor";
const BAD_KEY_TEXT = "401 dene";
const RATE_TEXT = "429 dene";
const MISSING_MODEL_TEXT = "404 dene";

function settings(patch) {
  return Object.assign(
    {
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKeys: { gemini: "AIzaTEST", deepseek: "sk-test" },
      sourceLanguages: "auto"
    },
    patch || {}
  );
}

const gemini = settings();
const deepseek = settings({ provider: "deepseek", model: "deepseek-chat" });

// One warm-up call, so the later cache assertions are not reading the first
// request in the file.
Translate.translate([{ id: 0, text: SPANISH }], gemini, { code: "es", label: "İspanyolca" })
  // ------------------------------------------------------------- resolution
  .then(function () {
    const g = Translate.resolveSettings(gemini);
    check("varsayılan sağlayıcı gemini", g.id === "gemini", g.id);
    check("gemini anahtarı okundu", g.key === "AIzaTEST", g.key);

    const d = Translate.resolveSettings(deepseek);
    check("deepseek anahtarı okundu", d.key === "sk-test", d.key);

    // A model belonging to another vendor must never be sent to this one.
    const crossed = Translate.resolveSettings(
      settings({ provider: "deepseek", model: "gemini-2.5-flash" })
    );
    check("yanlış model reddedildi", crossed.model === "deepseek-chat", crossed.model);

    // A key saved by an older build has to keep working, not be asked for twice.
    const legacy = Translate.resolveSettings({
      provider: "gemini",
      apiKey: "AIzaLEGACY",
      model: "gemini-2.5-flash"
    });
    check("eski apiKey alanı taşındı", legacy.key === "AIzaLEGACY", legacy.key);

    check("anahtar yoksa boş", Translate.resolveSettings({ provider: "gemini", apiKeys: {} }).key === "");

    // Switching to a custom endpoint must not carry the previous provider's
    // model over: the user types their own model name for that server.
    const custom = Translate.resolveSettings(
      settings({
        provider: "custom",
        model: "gemini-2.5-flash",
        customBase: "http://localhost:11434/v1",
        customModel: "qwen2.5:14b"
      })
    );
    check("özel sağlayıcı kendi modelini kullandı", custom.model === "qwen2.5:14b", custom.model);
    check("özel sağlayıcı adresi okundu", custom.base === "http://localhost:11434/v1", custom.base);

    const noCustomModel = Translate.resolveSettings(
      settings({ provider: "custom", model: "gemini-2.5-flash", customBase: "http://x/v1" })
    );
    check("özel sağlayıcıda eski model sızmadı", noCustomModel.model === "", noCustomModel.model);
  })
  // -------------------------------------------------------- request shape
  .then(function () {
    calls = [];
    return Translate.translate([{ id: 3, text: SPANISH + "?" }], gemini, {
      code: "es",
      label: "İspanyolca"
    });
  })
  .then(function (reply) {
    check("gemini isteği atıldı", calls.length === 1 && calls[0].providerId === "gemini");
    check(
      "gemini anahtarı başlıkta",
      calls[0].init.headers["x-goog-api-key"] === "AIzaTEST",
      JSON.stringify(calls[0].init.headers)
    );
    const sent = requestItems(calls[0].init);
    check("id gönderildi", sent.length === 1 && sent[0].id === 3, JSON.stringify(sent));
    check(
      "kaynak dili prompt'a girdi",
      calls[0].init.body.indexOf("İspanyolca") !== -1,
      "prompt dili eksik"
    );
    const expected = "TR:" + SPANISH + "?";
    check("çeviri doğru eşlendi", reply.results[0] && reply.results[0].text === expected,
      JSON.stringify(reply.results));
    check("kimlik korundu", reply.results[0].id === 3, String(reply.results[0].id));
    check("dil bildirildi", reply.language === "es", reply.language);
  })
  // --------------------------------------------------------- chat provider
  .then(function () {
    calls = [];
    return Translate.translate([{ id: 7, text: "Hello there" }], deepseek, {
      code: "en",
      label: "İngilizce"
    });
  })
  .then(function (reply) {
    check("deepseek isteği atıldı", calls.length === 1 && calls[0].providerId === "deepseek");
    check(
      "deepseek bearer token",
      calls[0].init.headers.Authorization === "Bearer sk-test",
      calls[0].init.headers.Authorization
    );
    check("çitli yanıt çözüldü", reply.results[0] && reply.results[0].text === "TR:Hello there",
      JSON.stringify(reply.results));
    check("deepseek kimliği korundu", reply.results[0].id === 7, String(reply.results[0].id));
  })
  // ---------------------------------------------------------------- cache
  .then(function () {
    calls = [];
    return Translate.translate([{ id: 0, text: CACHE_TEXT }], gemini, null)
      .then(function () {
        check("önbelleğe yazıldı", calls.length === 1, "çağrı=" + calls.length);
        calls = [];
        return Translate.translate([{ id: 0, text: CACHE_TEXT }], gemini, null);
      })
      .then(function (reply) {
        check("ikinci çağrı ağa gitmedi", calls.length === 0, "çağrı=" + calls.length);
        check("önbellekten döndü", reply.results[0].text === "TR:" + CACHE_TEXT, reply.results[0].text);
      });
  })
  .then(function () {
    // Same text on another provider must not reuse the first provider's wording.
    calls = [];
    return Translate.translate([{ id: 0, text: CACHE_TEXT }], deepseek, null);
  })
  .then(function () {
    check("sağlayıcı önbellek anahtarına giriyor", calls.length === 1, "çağrı=" + calls.length);
  })
  // ----------------------------------------------------------- missing key
  .then(function () {
    calls = [];
    return Translate.translate([{ id: 0, text: NEEDS_KEY_TEXT }], settings({
      provider: "gemini",
      apiKeys: {},
      apiKey: ""
    }), null);
  })
  .then(function (reply) {
    check("anahtarsız istek yapılmadı", calls.length === 0);
    check("anahtarsız hata veriyor", reply.errors.length === 1 && /anahtar/i.test(reply.errors[0].error),
      JSON.stringify(reply.errors));
  })
  // -------------------------------------------------------------- batching
  .then(function () {
    const many = [];
    for (let i = 0; i < 50; i++) many.push({ id: i, text: "satır " + i });
    calls = [];
    return Translate.translate(many, gemini, { code: "es", label: "İspanyolca" });
  })
  .then(function (reply) {
    check("50 metin 3 istekte gitti", calls.length === 3, "istek=" + calls.length);
    check("50 sonuç döndü", reply.results.length === 50, "sonuç=" + reply.results.length);
    const ids = reply.results.map(function (r) { return r.id; }).sort(function (a, b) { return a - b; });
    check("kimlikler eksiksiz", ids[0] === 0 && ids[49] === 49);
    check(
      "her sonuç kendi satırına bağlı",
      reply.results.every(function (r) { return r.text === "TR:satır " + r.id; }),
      JSON.stringify(reply.results.slice(0, 3))
    );
  })
  // ---------------------------------------------------------- HTTP failures
  .then(function () {
    const realFetch = ctx.fetch;
    const urls = [];

    ctx.fetch = function (url) {
      urls.push(String(url));
      calls.push({ url: String(url) });
      return errorResponse(401, "invalid api key");
    };
    return Translate.translate([{ id: 0, text: BAD_KEY_TEXT }], gemini, null)
      .then(function (reply) {
        check("401 hata olarak döndü", reply.errors.length === 1, JSON.stringify(reply.errors));
        check("401 mesajı anlaşılır", /anahtar/i.test(reply.errors[0].error), reply.errors[0].error);
        check("401'de sonuç uydurulmadı", reply.results.length === 0);
      })
      .then(function () {
        urls.length = 0;
        ctx.fetch = function (url) {
          urls.push(String(url));
          calls.push({ url: String(url) });
          return errorResponse(404, "model not found");
        };
        return Translate.translate([{ id: 0, text: MISSING_MODEL_TEXT }], gemini, null).then(function (reply) {
          /* A 404 must move to another model, stay bounded, and stop — a fixed
           * fallback model is retired upstream eventually, and an unbounded walk
           * would multiply the wait during a full outage. */
          const list = Providers.get("gemini").models;
          const HOP_LIMIT = 3;
          check("404 başka modele geçti", urls.length > 1, "istek=" + urls.length);
          check("404 yürüyüşü sınırlı", urls.length === HOP_LIMIT + 1, urls.length + "/" + (HOP_LIMIT + 1));
          check("404 arka arkaya aynı modeli istemedi", new Set(urls).size === urls.length, urls.join(" | "));
          check("404 listedeki modellerden seçti", urls.slice(1).every((u) => list.some((m) => u.indexOf(m) !== -1)));
          check("404 sonunda hata verdi", reply.errors.length === 1 && reply.results.length === 0);
          check("404 mesajı denenen modeli söylüyor", /bulunamadı/i.test(reply.errors[0].error), reply.errors[0].error);
        });
      })
      .then(function () {
        calls.length = 0;
        ctx.fetch = function (url) {
          calls.push({ url: String(url) });
          return errorResponse(429, "rate limited");
        };
        const started = Date.now();
        return Translate.translate([{ id: 0, text: RATE_TEXT }], gemini, null).then(function () {
          const elapsed = Date.now() - started;
          check("429 üç kez denendi", calls.length === 3, "istek=" + calls.length);
          check("429 gecikmeyle denendi", elapsed >= 700, "gecikme=" + elapsed + "ms");
        });
      })
      .then(function () {
        ctx.fetch = realFetch;
      });
  })
  // ---------------------------------------------------------- provider list
  .then(function () {
    const ids = Providers.list().map(function (p) { return p.id; });
    ["gemini", "deepseek", "groq", "openrouter", "custom"].forEach(function (id) {
      check("sağlayıcı listesi: " + id, ids.indexOf(id) !== -1);
    });

    const custom = Providers.get("custom");
    check("özel sağlayıcı modelsiz", (custom.models || []).length === 0);

    let threw = false;
    try {
      custom.request("x", "y", "z", { base: "" });
    } catch (error) {
      threw = true;
    }
    check("özel sağlayıcı sunucu adresi istiyor", threw);

    const customRequest = custom.request("x", "m", "z", { base: "http://localhost:11434/v1/" });
    check(
      "özel sunucu adresi kullanıldı",
      customRequest.url === "http://localhost:11434/v1/chat/completions",
      customRequest.url
    );
    check("bilinmeyen sağlayıcı geminiye düşüyor", Providers.get("yok").id === "gemini");
  })
  // ------------------------------------------------ custom endpoint, end to end
  .then(function () {
    const custom = settings({
      provider: "custom",
      model: "gemini-2.5-flash",
      customBase: "http://localhost:11434/v1",
      customModel: "qwen2.5:14b",
      apiKeys: { custom: "sk-local" }
    });

    calls = [];
    return Translate.translate([{ id: 7, text: "ÖZEL SUNUCU " + custom.customModel }], custom, {
      code: "en",
      label: "İngilizce"
    }).then(function (result) {
      // The whole point of the base plumbing: the address the user typed has to
      // be the one that gets called, and the stale model must not be sent.
      check(
        "özel sunucuya istek gitti",
        calls.length === 1 && calls[0].url === "http://localhost:11434/v1/chat/completions",
        calls.length ? calls[0].url : "istek yok"
      );
      const body = JSON.parse(calls[0].init.body);
      check("özel sunucuya doğru model gitti", body.model === "qwen2.5:14b", body.model);
      check("özel sunucu anahtarı kullandı", calls[0].init.headers.Authorization === "Bearer sk-local");
      check(
        "özel sunucu çevirdi",
        result.results.length === 1 && result.results[0].id === 7,
        JSON.stringify(result.results)
      );
    });
  })
  .then(function () {
    // A half-configured custom provider must say what is missing rather than
    // failing later inside the batch runner.
    const noBase = settings({
      provider: "custom",
      customBase: "",
      customModel: "qwen2.5:14b",
      apiKeys: { custom: "sk-local" }
    });
    calls = [];
    return Translate.translate([{ id: 0, text: "eksik adres " + noBase.customModel }], noBase, {}).then(
      function (result) {
        check(
          "adres yoksa uyarı verdi",
          result.results.length === 0 && result.errors.length === 1 && result.errors[0].error.indexOf("Sunucu adresi") === 0,
          JSON.stringify(result.errors)
        );
        check("adres yoksa istek atılmadı", calls.length === 0, calls.length + " istek");
      }
    );
  })
  .then(function () {
    const noModel = settings({
      provider: "custom",
      customBase: "http://localhost:11434/v1",
      customModel: "",
      apiKeys: { custom: "sk-local" }
    });
    calls = [];
    return Translate.translate([{ id: 0, text: "eksik model " + noModel.customBase }], noModel, {}).then(
      function (result) {
        check(
          "model yoksa uyarı verdi",
          result.results.length === 0 && result.errors.length === 1 && result.errors[0].error.indexOf("Model seçilmedi") === 0,
          JSON.stringify(result.errors)
        );
        check("model yoksa istek atılmadı", calls.length === 0, calls.length + " istek");
      }
    );
  })
  .then(function () {
    console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
    process.exit(failed ? 1 : 0);
  })
  .catch(function (error) {
    console.log("HATA  testler coktugun: " + (error && error.stack ? error.stack : error));
    process.exit(1);
  });