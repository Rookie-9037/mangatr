/* Exercises the fallback OCR path: the page image being read by a vision model
 * instead of Vision.
 *
 * The risky part is not the request, it is the coordinates. Vision reports
 * normalised boxes with a bottom-left origin and the overlay works in whole-image
 * pixels; this path gets the same numbers from a language model instead. Getting
 * the mapping wrong would not fail loudly — it would draw Turkish text in the
 * wrong place — so the assertions here are about geometry, not just wiring. */
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

function okJson(payload) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload))
  });
}

function failWith(status, body) {
  return Promise.resolve({ ok: false, status: status, text: () => Promise.resolve(body || "") });
}

/* A Gemini reply carrying normalised boxes. */
function visionPayload(blocks) {
  return { candidates: [{ content: { parts: [{ text: JSON.stringify({ blocks: blocks }) }] } }] };
}

/* An OpenAI-compatible reply carrying the same boxes, optionally fenced the way a
 * small local model tends to answer. */
function openAiVisionPayload(blocks, fenced) {
  var text = JSON.stringify({ blocks: blocks });
  if (fenced) text = "```json\n" + text + "\n```";
  return { choices: [{ message: { content: text } }] };
}

const ctx = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Date: Date,
  Math: Math,
  isFinite: isFinite,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  Image: function () {},
  Blob: function () {},
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  document: {
    createElement: () => ({
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => ({ data: [] }),
        putImageData: () => {}
      }),
      toBlob: (cb, type) => {
        cb({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
      }
    })
  },
  location: { href: "https://ornek.test/bolge-1" },
  fetch: function (url, init) {
    calls.push({ url: String(url), init: init });
    return respondWith(String(url), init);
  }
};

ctx.browser = {
  runtime: {
    getManifest: () => ({ version: "1.0.0" }),
    onMessage: { addListener: (fn) => { ctx.__listener = fn; } },
    sendNativeMessage: () => Promise.reject(new Error("native yok")),
    /* Routed through the same background listener the real extension uses, so
     * the content script's request shape is exercised for real. */
    sendMessage: (message) =>
      new Promise(function (resolve) {
        ctx.__listener(message, {}, resolve);
      })
  },
  storage: {
    local: {
      get: (defaults) => Promise.resolve(Object.assign({}, defaults, store)),
      set: (patch) => { Object.assign(store, patch); return Promise.resolve(); },
      remove: (keys) => { (keys || []).forEach((k) => { delete store[k]; }); return Promise.resolve(); }
    }
  }
};

vm.createContext(ctx);
/* ocr.js is loaded too: the coordinate mapping lives there, and it is the part
 * most likely to be wrong. */
["bridge.js", "lang.js", "providers.js", "translator.js", "background.js", "ocr.js"].forEach((name) => {
  vm.runInContext(read(name), ctx, { filename: name });
});

const Providers = ctx.MangaTRProviders;
const OCR = ctx.MangaTROCR;

function send(message) {
  return new Promise(function (resolve) {
    ctx.__listener(message, {}, resolve);
  });
}

function seed(settings) {
  Object.keys(store).forEach((k) => { delete store[k]; });
  Object.assign(store, settings);
}

// ------------------------------------------------- istek biçimi (dosya düzeyi)

check("gemini görsel okumayı destekliyor", Providers.get("gemini").supportsVision === true);
check("deepseek görsel okumuyor", !Providers.get("deepseek").supportsVision);

/* The popup never sees the internal provider objects, only what list() hands
 * over. Dropping the flag there made the popup insist Gemini could not read
 * images while telling the user to choose Gemini. */
const listed = {};
Providers.list().forEach((p) => { listed[p.id] = p; });
check("servis listesi görsel yeteneğini taşıyor", listed.gemini.supportsVision === true,
  String(listed.gemini.supportsVision));
check("görsel okumayan servis doğru işaretli", listed.deepseek.supportsVision === false);
check("görsel okumayan listede false olarak geçiyor", listed.groq.supportsVision === false);
/* The self-hosted entry is the one that can read a page with no account at all,
 * which is the only way around a free Apple ID not signing the Vision extension. */
check("özel sunucu listede görsel okuyor", listed.custom.supportsVision === true,
  String(listed.custom.supportsVision));

const request = Providers.get("gemini").visionRequest(
  { b64: "AAAA", mime: "image/png" },
  "gemini-3.6-flash",
  "AIzaTEST",
  {}
);
const body = JSON.parse(request.init.body);
const parts = body.contents[0].parts;

check("görsel istekte inline olarak gönderiliyor",
  parts[0].inlineData && parts[0].inlineData.data === "AAAA" && parts[0].inlineData.mimeType === "image/png",
  JSON.stringify(parts[0]));
check("görsel istekte talimat var", typeof parts[1].text === "string" && parts[1].text.length > 40);
check("görsel istekte anahtar header'da", request.init.headers["x-goog-api-key"] === "AIzaTEST");
check("görsel istekte model yolda", request.url.indexOf("gemini-3.6-flash") !== -1, request.url);
check("görsel istek JSON şeması istiyor",
  body.generationConfig.responseSchema.properties.blocks.items.properties.x.type === "number");
check("görsel istek sıcaklık 0", body.generationConfig.temperature === 0);

// ------------------------------------------------------------- yanıt ayrıştırma

const parsed = Providers.get("gemini").visionParse(visionPayload([
  { text: "やあ", x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
  { text: "  ", x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
  { text: "bozuk", x: "bir", y: 0.2, w: 0.3, h: 0.05 },
  { text: "taşma", x: -0.4, y: 1.7, w: 0.3, h: 0.05 }
]));

check("boş metin elendi", parsed.blocks.length === 2, JSON.stringify(parsed.blocks));
check("sayı olmayan kutu elendi", parsed.blocks.every((b) => b.text !== "bozuk"));
check("kutular 0-1 arasına kırpıldı",
  parsed.blocks[1].x === 0 && parsed.blocks[1].y === 1,
  JSON.stringify(parsed.blocks[1]));
check("metin kırpıldı", parsed.blocks[0].text === "やあ", JSON.stringify(parsed.blocks[0].text));

check("bozuk JSON ayrıştırılamadı",
  Providers.get("gemini").visionParse({ candidates: [{ content: { parts: [{ text: "merhaba" }] } }] }) === null);

// -------------------------------------------------- görsel okumayan servis

seed({ provider: "deepseek", model: "deepseek-chat", apiKeys: { deepseek: "sk-test" } });

send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } })
  .then(function (reply) {
    check("görsel okumayan servis açıkça reddedildi",
      reply.ok === false && /görsel okuyamıyor/i.test(reply.error), reply.error);
    check("reddedilen istek dışarı çıkmadı", calls.length === 0, calls.length + " istek");
    return send({ type: "ocr:vision", image: { b64: "AAAA" } });
  })
  .then(function () {
    seed({ provider: "gemini", model: "gemini-3.6-flash", apiKeys: {} });
    return send({ type: "ocr:vision", image: { b64: "AAAA" } });
  })
  .then(function (reply) {
    check("anahtarsız görsel okuma reddedildi",
      reply.ok === false && /anahtar/i.test(reply.error), reply.error);

    seed({ provider: "gemini", model: "gemini-3.6-flash", apiKeys: { gemini: "AIzaTEST" } });
    calls = [];
    respondWith = () => okJson(visionPayload([{ text: "やあ", x: 0.5, y: 0.25, w: 0.4, h: 0.05 }]));
    return send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } });
  })
  .then(function (reply) {
    check("görsel okuma döndü", reply.ok === true && reply.result.blocks.length === 1, JSON.stringify(reply));
    check("kutu 0-1 olarak döndü", reply.ok && reply.result.blocks[0].x === 0.5, JSON.stringify(reply.result));

    // --------------------------------------------- normalize -> piksel eşlemesi

    /* One tile, no seam involved: a 1000x800 page is one 1000x800 pass at scale 1.
     * A box at x=0.5 must land at pixel 500, not somewhere off the page. */
    const img = { naturalWidth: 1000, naturalHeight: 800, complete: true, currentSrc: "https://x/a.png" };
    calls = [];
    respondWith = () => okJson(visionPayload([
      { text: "sol", x: 0.1, y: 0.2, w: 0.2, h: 0.1 },
      { text: "sağ", x: 0.5, y: 0.25, w: 0.4, h: 0.05 }
    ]));

    return OCR.recognize(img, { sourceLanguages: "auto" }, null, true).then(function (result) {
      const boxes = result.boxes;
      check("iki kutu geldi", boxes.length === 2, JSON.stringify(boxes));

      const left = boxes.find((b) => b.text === "sol");
      const right = boxes.find((b) => b.text === "sağ");
      check("x normalize piksele çevrildi", left.x === 100 && right.x === 500, JSON.stringify([left.x, right.x]));
      check("y normalize piksele çevrildi", left.y === 160 && right.y === 200, JSON.stringify([left.y, right.y]));
      check("genişlik normalize piksele çevrildi", left.width === 200 && right.width === 400,
        JSON.stringify([left.width, right.width]));
      check("yükseklik normalize piksele çevrildi", left.height === 80, String(left.height));
      check("tüm sayfa tek parça sayıldı", calls.length === 1, calls.length + " istek");
      check("analiz tuvali döndü", !!result.analysis);

      // ------------------------------------------------ uzun şeritte dikey kayma

      /* A 4000px-tall strip is cut into tiles. The second tile must be lifted by
       * its offset, otherwise every balloon below the first seam is drawn on top
       * of the wrong panel. */
      const tall = { naturalWidth: 1000, naturalHeight: 6000, complete: true, currentSrc: "https://x/b.png" };
      calls = [];
      respondWith = (url) => {
        /* Every tile answers at y=0.5, so the expected y differs per tile purely
         * because of the offset. */
        const match = String(url).match(/image\/([a-z]+)/);
        return okJson(visionPayload([{ text: "t" + (match ? match[1] : "0"), x: 0, y: 0.5, w: 0.1, h: 0.05 }]));
      };

      return OCR.recognize(tall, { sourceLanguages: "auto" }, null, true).then(function (tallResult) {
        const boxes = tallResult.boxes.sort((a, b) => a.y - b.y);
        check("şerit birden fazla parçaya bölündü", calls.length > 1, calls.length + " istek");
        check("parçalar tekilleştirildi", boxes.length === calls.length, boxes.length + "/" + calls.length);
        check("ikinci parça kendi dikey konumuna düştü",
          boxes.length > 1 && boxes[0].y !== boxes[1].y,
          boxes.map((b) => b.y).join(","));
        check("en üst parça sayfa tepesinde", boxes[0].y >= 0 && boxes[0].y < 1400, String(boxes[0].y));
        check("en alt parça sayfa dibinde",
          boxes[boxes.length - 1].y + boxes[boxes.length - 1].height <= 6000,
          String(boxes[boxes.length - 1].y));
      });
    });
  })
  .then(function () {
    // ---------------------------------------- 404'te model değiştirme (görsel)

    seed({ provider: "gemini", model: "gemini-3.8-flash", apiKeys: { gemini: "AIzaTEST" } });
    calls = [];
    respondWith = (url) =>
      String(url).indexOf("gemini-3.6-flash") !== -1
        ? okJson(visionPayload([{ text: "やあ", x: 0.5, y: 0.5, w: 0.2, h: 0.05 }]))
        : failWith(404, "model not found");

    return send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } });
  })
  .then(function (reply) {
    check("görsel okumada 404 model değiştirdi", reply.ok === true && calls.length === 2,
      JSON.stringify(reply) + " istek=" + calls.length);
  })
  .then(function () { return localVisionChecks(); })
  .then(function () { return localVisionEndToEnd(); })
  .then(function () {
    console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
    process.exit(failed ? 1 : 0);
  })
  .catch(function (error) {
    console.log("HATA  testler coktugun: " + (error && error.stack ? error.stack : error));
    process.exit(1);
  });

// ------------------------------------------------ kendi sunucun (anahtarsız)

/* The local route is the only one that works without a paid Apple ID, so the
 * pieces it leans on are checked directly rather than through the chat path: the
 * OpenAI picture dialect, the absent Authorization header, and a vision model
 * that is configured apart from the text one. */
function localVisionChecks() {
  const custom = Providers.get("custom");
  const Translate = ctx.MangaTRTranslate;

  check("özel sunucu görsel okumayı destekliyor", custom.supportsVision === true);
  check("deepseek hâlâ görsel okumuyor", !Providers.get("deepseek").supportsVision);
  check("groq hâlâ görsel okumuyor", !Providers.get("groq").supportsVision);
  check("openrouter hâlâ görsel okumuyor", !Providers.get("openrouter").supportsVision);

  const keyless = custom.visionRequest(
    { b64: "AAAA", mime: "image/jpeg" },
    "qwen2.5vl:7b",
    "",
    { base: "http://192.168.1.5:11434/v1/" }
  );
  const body = JSON.parse(keyless.init.body);
  const parts = body.messages[0].content;
  const picture = parts.find((p) => p.type === "image_url");

  check("yerel adres kullanıldı",
    keyless.url === "http://192.168.1.5:11434/v1/chat/completions", keyless.url);
  /* A blank "Bearer " is answered with 401 by stricter servers, so the header has
   * to be missing rather than empty. */
  check("anahtarsız istekte Authorization yok",
    keyless.init.headers.Authorization === undefined, JSON.stringify(keyless.init.headers));
  check("görsel data URL olarak gönderiliyor",
    !!picture && picture.image_url.url === "data:image/jpeg;base64,AAAA",
    picture && picture.image_url.url);
  /* OpenAI's API rejects json_object unless the word JSON is in the messages, and
   * Ollama and LM Studio copy that rule. */
  check("talimat JSON biçimini içeriyor",
    parts[0].type === "text" && /JSON/.test(parts[0].text), JSON.stringify(parts[0].text.slice(0, 40)));
  check("yerel istek sıcaklık 0", body.temperature === 0, String(body.temperature));
  check("yerel istek JSON biçimi istiyor",
    !!body.response_format && body.response_format.type === "json_object");
  /* The default cap on a local server truncates the last panels of a page instead
   * of failing, so the limit has to be asked for explicitly. */
  check("yerel istek çıktı sınırı koyuyor", body.max_tokens === 8192, String(body.max_tokens));
  check("çeviri sistem talimatı karışmıyor",
    !body.messages.some((m) => m.role === "system"), JSON.stringify(body.messages.length + " mesaj"));

  const withKey = custom.visionRequest(
    { b64: "AAAA", mime: "image/png" }, "qwen2.5vl:7b", "abc", { base: "http://x/v1" }
  );
  check("anahtarlı istekte Authorization var",
    withKey.init.headers.Authorization === "Bearer abc", String(withKey.init.headers.Authorization));

  const parsedLocal = custom.visionParse(openAiVisionPayload(
    [{ text: "やあ", x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, { text: "  ", x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
    true
  ));
  check("kod bloğu içindeki JSON ayrıştırıldı", parsedLocal.blocks.length === 1,
    JSON.stringify(parsedLocal.blocks));
  check("yerel yanıtta metin kırpıldı", parsedLocal.blocks[0].text === "やあ");
  check("çöp yanıt null döndü",
    custom.visionParse({ choices: [{ message: { content: "üzgünüm, yapamam" } }] }) === null);

  const resolved = Translate.resolveSettings({
    provider: "custom",
    customBase: "http://localhost:11434/v1",
    customModel: "qwen2.5:7b",
    customVisionModel: "qwen2.5vl:7b",
    apiKeys: {}
  });
  check("özel sunucuda anahtar zorunlu sayılmıyor", resolved.keyRequired === false);
  check("görsel model ayarlardan çözümlendi", resolved.visionModel === "qwen2.5vl:7b",
    resolved.visionModel);

  return Promise.resolve();
}

function localVisionEndToEnd() {
  seed({
    provider: "custom",
    customBase: "http://localhost:11434/v1",
    customModel: "qwen2.5:7b",
    customVisionModel: "qwen2.5vl:7b",
    apiKeys: {}
  });
  calls = [];
  respondWith = () => okJson(openAiVisionPayload([{ text: "やあ", x: 0.5, y: 0.25, w: 0.4, h: 0.05 }]));

  return send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } })
    .then(function (reply) {
      check("anahtarsız yerel görsel okuma çalıştı",
        reply.ok === true && reply.result.blocks.length === 1, JSON.stringify(reply));
      /* The regression this route kept hitting: the address never reached the
       * request, so everything but Gemini died with "Sunucu adresi boş". */
      check("yerel adrese istek gitti",
        calls.length === 1 && calls[0].url === "http://localhost:11434/v1/chat/completions",
        JSON.stringify(calls.map((c) => c.url)));
      const sent = calls.length ? JSON.parse(calls[0].init.body) : {};
      check("görsel model ayrı alandan geldi", sent.model === "qwen2.5vl:7b", sent.model);
      check("yerel istekte anahtar header yok",
        !calls[0].init.headers.Authorization, JSON.stringify(calls[0].init.headers));

      /* Blank vision model must fall back to the text model. Sending an empty name
       * instead would be answered with a 404 by every server. */
      seed({
        provider: "custom",
        customBase: "http://localhost:11434/v1",
        customModel: "qwen2.5vl:7b",
        customVisionModel: "",
        apiKeys: {}
      });
      calls = [];
      return send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } });
    })
    .then(function () {
      check("görsel model boşsa metin modeli kullanılıyor",
        calls.length === 1 && JSON.parse(calls[0].init.body).model === "qwen2.5vl:7b",
        calls.length ? JSON.parse(calls[0].init.body).model : "istek yok");

      seed({ provider: "custom", customBase: "", customModel: "qwen2.5vl:7b", apiKeys: {} });
      calls = [];
      return send({ type: "ocr:vision", image: { b64: "AAAA", mime: "image/png" } });
    })
    .then(function (reply) {
      check("adres boşken anlaşılır hata verdi",
        reply.ok === false && /Sunucu adresi boş/.test(reply.error), reply.error);
      check("adres yokken istek atılmadı", calls.length === 0, calls.length + " istek");

      /* A model that was never pulled is the most common local failure, and
       * "bu anahtar erişemiyor" is advice that cannot work without a key. */
      const explained = Providers.explainStatus(
        Providers.get("custom"), 404, "model not found", "qwen2.5vl:7b", []
      );
      check("yerel 404 indirme komutu veriyor",
        /ollama pull qwen2\.5vl:7b/.test(explained), explained);
    });
}