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
  // --------------------------------------------- elle "Bu sayfayı çevir"

  return send({ type: "ocr:run" }).then(function (reply) {
    check("sayfa tetiği aktif sekmeye gitti", tabMessages.length === 1 && tabMessages[0].id === 7,
      JSON.stringify(tabMessages));
    check("sayfaya doğru mesaj gönderildi", tabMessages[0].message.type === "ocr:run");
    check("kuyruk bilisi döndü", reply.ok === true && reply.result.queued === 2, JSON.stringify(reply));

    /* A PDF viewer or a chrome:// page has no content script, and the page's own
     * scripts may answer instead. Both look like an empty reply, and an empty
     * reply used to read as success. */
    tabMessages = [];
    tabReply = () => undefined;
    return send({ type: "ocr:run" });
  }).then(function (reply) {
    check("yanıt yoksa anlaşılır hata veriyor",
      reply.ok === false && /çalışmıyor/i.test(reply.error), reply.error);

    tabMessages = [];
    tabReply = () => ({ ok: false, error: "Sayfada çevrilecek büyük görsel bulunamadı" });
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