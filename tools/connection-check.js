/* Exercises the popup's "Test et" button path end to end.
 *
 * That button is the first thing a user presses when a key does not work, and
 * until now nothing covered it: not probe(), not the background settings:test
 * handler, not the shape of the answer the popup reads. A break here looks like
 * "the extension is broken" rather than "the button is broken", so it is worth
 * pinning down.
 *
 * The message listener background.js registers is invoked directly, which is
 * what makes this a test of the real handler rather than a copy of it.
 */
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
let respondWith = null;
/* What the open tab's content script answers with; the manual trigger's whole
 * contract is the hop from the popup through background into that page. */
let tabMessages = [];
let tabReply = () => ({ ok: true, images: 4, painted: 2, queued: 2 });

function geminiPayload() {
  return {
    candidates: [
      { content: { parts: [{ text: '{"lang":"en","items":[{"id":0,"tr":"Merhaba"}]}' }] } }
    ]
  };
}

function chatPayload() {
  return { choices: [{ message: { content: '{"lang":"en","items":[{"id":0,"tr":"Merhaba"}]}' } }] };
}

const ctx = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  fetch: function (url, init) {
    calls.push({ url: String(url), init: init });
    return respondWith(String(url), init);
  }
};

ctx.browser = {
  runtime: {
    getManifest: () => ({ version: "1.0.0" }),
    onMessage: { addListener: (fn) => { ctx.__listener = fn; } },
    sendNativeMessage: () => Promise.resolve({})
  },
  storage: {
    local: {
      get: (defaults) => Promise.resolve(Object.assign({}, defaults, store)),
      set: (patch) => { Object.assign(store, patch); return Promise.resolve(); },
      remove: (keys) => { (keys || []).forEach((k) => { delete store[k]; }); return Promise.resolve(); }
    }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 7 }]),
    sendMessage: (id, message) => {
      tabMessages.push({ id: id, message: message });
      return Promise.resolve(tabReply());
    }
  }
};

vm.createContext(ctx);
["bridge.js", "lang.js", "providers.js", "translator.js", "background.js"].forEach((name) => {
  vm.runInContext(read(name), ctx, { filename: name });
});

check("background mesaj dinleyicisi kaydedildi", typeof ctx.__listener === "function");

/* Builds an isolated copy of the extension. The native-messaging scenarios have
 * to run somewhere the probe has not already been answered, because the verdict
 * is cached after the first call -- reusing the main context would silently test
 * the cache instead of the delegation. */
function freshContext(withNative, withBackground, probeReply) {
  const c = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Promise: Promise, Date: Date, Math: Math, isFinite: isFinite,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: () => Promise.reject(new Error("kullanilmiyor"))
  };
  const runtime = {
    getManifest: () => ({ version: "1.0.0" }),
    onMessage: { addListener: (fn) => { c.__listener = fn; } },
    sendMessage: () => Promise.resolve(probeReply || { ok: true, result: { available: false, error: "kopru yok" } })
  };
  if (withNative) runtime.sendNativeMessage = () => Promise.resolve({ ok: true });
  c.browser = {
    runtime: runtime,
    storage: {
      local: {
        get: (defaults) => Promise.resolve(Object.assign({}, defaults)),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve()
      }
    }
  };
  vm.createContext(c);
  const files = withBackground
    ? ["bridge.js", "lang.js", "providers.js", "translator.js", "background.js"]
    : ["bridge.js"];
  files.forEach((name) => vm.runInContext(read(name), c, { filename: name }));
  return c;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ value: value }), (error) => ({ error: error })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms))
  ]);
}

function checkNoNativeContext() {
  // A content script: bridge.js only, no sendNativeMessage, background not loaded.
  const contentSide = freshContext(false, false);
  return withTimeout(contentSide.MangaTR.nativeAvailable(), 2000).then(function (out) {
    check("içerik betiği fırlatmıyor, false dönüyor",
      out.value === false && !out.error && !out.timeout, JSON.stringify(out));
    check("içerik betiği köprü sebebini aktardı",
      /kopru yok/.test(contentSide.MangaTR.nativeErrorText() || ""),
      contentSide.MangaTR.nativeErrorText());

    // The background page without the function must give up rather than message
    // itself: that path used to be a candidate for an unbreakable request loop.
    const bg = freshContext(false, true);
    const reply = new Promise((resolve) => bg.__listener({ type: "native:probe" }, {}, resolve));
    return withTimeout(reply, 2000).then(function (bgOut) {
      check("background kendine sormuyor", !bgOut.timeout, JSON.stringify(bgOut));
      check("background temiz hata veriyor",
        bgOut.value && bgOut.value.ok === true && bgOut.value.result.available === false &&
        /native mesajlaşma yok/.test(bgOut.value.result.error || ""),
        JSON.stringify(bgOut.value || bgOut.error || bgOut));
    });
  }).then(function () {
    // Sanity: with the function present the direct path is still taken.
    const withNative = freshContext(true, true);
    return withTimeout(withNative.MangaTR.nativeAvailable(), 2000).then(function (out) {
      check("native varsa doğrudan yoklama yapılıyor", out.value === true, JSON.stringify(out));
    });
  });
}

/* Sends a message the way the popup does and resolves with the reply object. */
function send(message) {
  return new Promise(function (resolve) {
    ctx.__listener(message, {}, resolve);
  });
}

function okJson(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload))
  });
}

function failWith(status, body) {
  return Promise.resolve({ ok: false, status: status, text: () => Promise.resolve(body) });
}

function seed(settings) {
  Object.keys(store).forEach((k) => { delete store[k]; });
  Object.assign(store, settings);
}

// ------------------------------------------------------------- anahtarsız

seed({ provider: "gemini", model: "gemini-2.5-flash", apiKeys: {} });
calls = [];
send({ type: "settings:test" }).then(function (reply) {
  check(
    "anahtarsız sınama uyarı veriyor",
    reply.ok === false && /anahtar/i.test(reply.error),
    reply.error
  );
  check("anahtarsız sınama istek atmadı", calls.length === 0, calls.length + " istek");

  // ------------------------------------------------------------------ gemini

  seed({ provider: "gemini", model: "gemini-2.5-flash", apiKeys: { gemini: "AIzaTEST" } });
  calls = [];
  respondWith = () => okJson(geminiPayload());
  return send({ type: "settings:test" }).then(function (reply) {
    check("gemini sınaması başarılı", reply.ok === true && reply.result.ok === true, JSON.stringify(reply));
    check("gemini adresi kullanıldı", calls[0] && calls[0].url.indexOf("generativelanguage") !== -1,
      calls[0] ? calls[0].url : "istek yok");
    // Gemini takes the model in the path, not the body, unlike the OpenAI shape.
    check("gemini modeli adres içinde", calls[0] && calls[0].url.indexOf("gemini-2.5-flash") !== -1,
      calls[0] ? calls[0].url : "istek yok");
    check("gemini anahtarı gönderildi",
      String(calls[0].init.headers["x-goog-api-key"] || "") === "AIzaTEST" ||
      calls[0].init.url.indexOf("AIzaTEST") !== -1,
      JSON.stringify(calls[0].init.headers));

    // ------------------------------------------------- 503: kapasite dolu

    /* 503 is the one users hit most: the key is fine and the model is real, but
       Gemini has no capacity. Hopping to another model is what rescues it, and
       the reply must name the model that actually answered. */
    seed({ provider: "gemini", model: "gemini-3.8-flash", apiKeys: { gemini: "AIzaTEST" } });
    calls = [];
    respondWith = (url) =>
      String(url).indexOf("gemini-3.6-flash") !== -1
        ? okJson(geminiPayload())
        : failWith(503, "The model is overloaded. Please try again later.");
    return send({ type: "settings:test" }).then(function (reply) {
      check("503 başka modele geçip başarılı oldu", reply.ok === true && reply.result.ok === true,
        JSON.stringify(reply));
      check("503 gerçekten iki model denedi", calls.length === 2, calls.length + " istek");
      check("503 cevaplayan model bildirildi", reply.ok && reply.result.model === "gemini-3.6-flash",
        reply.ok ? reply.result.model : reply.error);
    }).then(function () {

    // ------------------------------------------------ 503: kapasite hiç yok

      seed({ provider: "gemini", model: "gemini-3.8-flash", apiKeys: { gemini: "AIzaTEST" } });
      calls = [];
      respondWith = () => failWith(503, "The model is overloaded.");
      return send({ type: "settings:test" });
    }).then(function (reply) {
      check("503 kalıcıysa anlaşılır hata verdi", reply.ok === false && /yanıt vermiyor/i.test(reply.error),
        reply.error);
      check("503 denenen modelleri saydı", /Denenen modeller/.test(reply.error), reply.error);
      /* Bounded on purpose: 3 model hops then 2 retries of the last one. An
         unbounded fan-out during an outage would just multiply the wait. */
      const MAX503 = 3 + 2 + 1;
      check("503 istek sayısı sınırlı", calls.length === MAX503, calls.length + "/" + MAX503);

        /* 429 hides two unrelated problems behind one status code, and they are
         * fixed in opposite ways: a per-minute limit clears in a minute, a spent
         * daily quota does not clear at all. Saying "retry later" about the second
         * one is worse than useless. */
        seed({ provider: "gemini", model: "gemini-3.8-flash", apiKeys: { gemini: "AIzaTEST" } });
        calls = [];
        respondWith = () => failWith(429,
          '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",' +
          '"message":"Quota exceeded for quota metric: Generate requests"}}');
        return send({ type: "settings:test" });
      }).then(function (reply) {
        check("tükenen kota tükenen olarak anlatıldı",
          reply.ok === false && /Kota tükendi/.test(reply.error), reply.error);
        /* The point is that the *invitation* to retry is absent, not that the word cannot
         * appear: the sentence has to mention what waiting is worth, so the check
         * looks for the retry phrasing specifically. */
        check("tükenen kotede tekrar denemek önerilmiyor",
          !/biraz sonra tekrar dene/i.test(reply.error), reply.error);
        check("tükenen kotede alternatif servis önerildi",
          /Groq|OpenRouter/.test(reply.error), reply.error);
        check("tükenen kota için geri çekilme yapılmadı", calls.length === 1, calls.length + " istek");

        seed({ provider: "gemini", model: "gemini-3.8-flash", apiKeys: { gemini: "AIzaTEST" } });
        calls = [];
        respondWith = () => failWith(429,
          '{"error":{"code":429,"message":"Resource has been exhausted ' +
          '(e.g. check quota) per minute."}}');
        return send({ type: "settings:test" });
      }).then(function (reply) {
        check("dakikalık sınır hız sınırı olarak anlatıldı",
          reply.ok === false && /Hız sınırı/.test(reply.error), reply.error);
        check("dakikalık sınırda tekrar deneniyor", calls.length > 1, calls.length + " istek");

    // ---------------------------------------------------------------- deepseek

    seed({ provider: "deepseek", model: "deepseek-chat", apiKeys: { deepseek: "sk-test" } });
    calls = [];
    respondWith = () => okJson(chatPayload());
    return send({ type: "settings:test" }).then(function (reply) {
      check("deepseek sınaması başarılı", reply.ok === true && reply.result.ok === true, JSON.stringify(reply));
      check("deepseek adresi kullanıldı", calls[0] && calls[0].url.indexOf("api.deepseek.com") !== -1,
        calls[0] ? calls[0].url : "istek yok");
      check("deepseek yetkilendirmesi doğru",
        calls[0] && calls[0].init.headers.Authorization === "Bearer sk-test",
        calls[0] ? calls[0].init.headers.Authorization : "-");
      check("deepseek etiketi döndü", reply.result && reply.result.label === "DeepSeek",
        reply.result ? reply.result.label : "-");

      // Sınama isteği tek parça, sabit bir cümle göndermeli. The system prompt
      // itself contains a bracketed JSON example, so the count is taken from the
      // user message rather than from the first "[" in the body.
      const userText = JSON.parse(calls[0].init.body).messages.slice(-1)[0].content;
      const itemCount = (userText.match(/"tr"\s*:/g) || []).length;
      check("sınama isteği tek kalem", itemCount === 1, itemCount + " kalem, " + userText.slice(0, 60));

      // ------------------------------------------------------------------ 401

      calls = [];
      respondWith = () => Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"invalid api key"}')
      });
      return send({ type: "settings:test" }).then(function (reply) {
        check("401 hata olarak döndü", reply.ok === false && /401/.test(reply.error), reply.error);

// ------------------------------------------------- kredi yetersiz (402)

      seed({ provider: "deepseek", model: "deepseek-chat", apiKeys: { deepseek: "sk-test" } });
      calls = [];
      respondWith = () => Promise.resolve({
        ok: false,
        status: 402,
        text: () => Promise.resolve('{"error":{"message":"insufficient balance","type":"billing_not_active","request_id":"abc"}}')
      });
      return send({ type: "settings:test" }).then(function (reply) {
        check("402 kredi yetersizliği olarak anlatıldı",
          reply.ok === false && /kredi yok/i.test(reply.error),
          reply.error);
        check("402'de ham vendor JSON sızmadı",
          reply.ok === false && reply.error.indexOf("request_id") === -1,
          reply.error);
        check("402'de nereye bakılacağı söylendi",
          reply.ok === false && /deepseek/i.test(reply.error),
          reply.error);
      });

      // ------------------------------------------------- bozuk model yanıtı

      calls = [];
      respondWith = () => okJson(chatPayload());
      seed({ provider: "custom", customBase: "http://localhost:11434/v1", customModel: "qwen2.5:14b", apiKeys: { custom: "sk-local" } });
      return send({ type: "settings:test" }).then(function (reply) {
          check("özel sunucu sınaması başarılı", reply.ok === true, JSON.stringify(reply));
          check("özel sunucu adresi kullanıldı",
            calls[0] && calls[0].url === "http://localhost:11434/v1/chat/completions",
            calls[0] ? calls[0].url : "istek yok");

          calls = [];
          respondWith = () => okJson({ choices: [{ message: { content: '{"lang":"en","items":[]}' } }] });
          return send({ type: "settings:test" }).then(function (reply) {
            check("bozuk yanıt yakalandı",
              reply.ok === false && /yanıt vermedi|bicimde/i.test(reply.error),
              reply.error);

            // ------------------------------------------------- eksik yapılandırma

            seed({ provider: "custom", customBase: "", customModel: "qwen2.5:14b", apiKeys: { custom: "sk-local" } });
            calls = [];
            return send({ type: "settings:test" }).then(function (reply) {
              check("adres yoksa sınama reddedildi", reply.ok === false && /Sunucu adresi/.test(reply.error), reply.error);
              check("adres yoksa istek atmadı", calls.length === 0, calls.length + " istek");
            });
          });
        });
      });
    });
  });
  });
}).then(function () {
  /* Safari exposes runtime.sendNativeMessage to the background page only. In a
   * content script the property is absent, and calling it unguarded threw a
   * TypeError that escaped every .catch and aborted the OCR pipeline -- which is
   * exactly why "3 pages queued" turned into "nothing happened". */
  return send({ type: "native:probe" }).then(function (reply) {
    check("native sınaması gerekçesiyle döndü",
      reply.ok === true && reply.result && typeof reply.result.available === "boolean",
      JSON.stringify(reply));
    check("başarısız köprü sebebini taşıyor", typeof reply.result.error === "string",
      JSON.stringify(reply.result));
    return send({ type: "ping" });
  }).then(function (reply) {
    check("ping calisiyor", reply.ok === true && !!reply.result.version, JSON.stringify(reply));
    return checkNoNativeContext();
  }).then(function () {
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("sayfa tetiği aktif sekmeye gitti", tabMessages.length === 2 && tabMessages[0].id === 7,
      JSON.stringify(tabMessages));
    check("sayfaya doğru mesaj gönderildi", tabMessages[1].message.type === "ocr:run");
    check("kuyruk bilisi döndü", reply.ok === true && reply.result.queued === 2, JSON.stringify(reply));

    /* No content script at all -- a PDF viewer, a chrome:// page, or a site the
     * extension was never permitted on. Ping fails too, which is the only thing
     * that distinguishes this from "every frame had nothing to do". */
    tabMessages = [];
    tabReply = () => undefined;
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("içerik betiği yoksa izin yolu gösteriliyor",
      reply.ok === false && /izin ver/i.test(reply.error), reply.error);
    check("önce ping atıldı", tabMessages.length === 2 && tabMessages[0].message.type === "ping",
      JSON.stringify(tabMessages.map((m) => m.message.type)));

    /* Reader inside an iframe: the top document has no images and must stay
     * quiet so the frame that does have the page can answer. */
    tabMessages = [];
    ctx.browser.tabs.sendMessage = (id, message) => {
      tabMessages.push({ id: id, message: message });
      if (message.type === "ping") return Promise.resolve({ ok: true, images: 0, canvases: 0 });
      return Promise.resolve({ ok: true, images: 3, canvases: 0, painted: 1, queued: 1 });
    };
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("çerçeve içindeki okuyucudan kuyruk geldi",
      reply.ok === true && reply.result.queued === 1, JSON.stringify(reply));

    /* Script present in every frame, no frame has a page image: a chapter list,
     * or a canvas reader. Saying "reload" here would send the user in circles. */
    tabMessages = [];
    ctx.browser.tabs.sendMessage = (id, message) => {
      tabMessages.push({ id: id, message: message });
      if (message.type === "ping") return Promise.resolve({ ok: true, images: 0, canvases: 2 });
      return Promise.resolve(undefined);
    };
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("hiçbir çerçevede görsel yoksa bölüm ipucu veriyor",
      reply.ok === false && /hiçbir yerinde <img> yok/.test(reply.error), reply.error);
    check("canvas okuyucu varsa sayısı söylendi", /2 canvas bulundu/.test(reply.error), reply.error);
    check("canvas ipucu karıştırılmadı", !/yenile/i.test(reply.error), reply.error);

    tabMessages = [];
    ctx.browser.tabs.sendMessage = (id, message) => {
      tabMessages.push({ id: id, message: message });
      return Promise.resolve(tabReply());
    };

    tabMessages = [];
    tabReply = () => ({ ok: false, error: "Sayfada çevrilecek büyük görsel bulunamadı (9 görsel tarandı)" });
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("sayfa bulamadıysa hata yüzeye çıktı",
      reply.ok === false && /görsel bulunamadı/i.test(reply.error), reply.error);
  });
}).then(function () {
  console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
  process.exit(failed ? 1 : 0);
}).catch(function (error) {
  console.log("HATA  testler coktugun: " + (error && error.stack ? error.stack : error));
  process.exit(1);
});