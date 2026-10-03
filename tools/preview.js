/* Tarayıcı önizlemesi. extension/Resources altındaki gerçek overlay.js ve
 * translator.js dosyalarını yükler; tek farkı OCR kaynağı (Tesseract) ve
 * depolamanın bellek olması. Amaç, iOS derlemesinden bağımsız olarak balon
 * kapatma ve Türkçe yerleştirmeyi görebilmek. */

(function () {
  "use strict";

  var els = {
    file: document.getElementById("file"),
    provider: document.getElementById("provider"),
    key: document.getElementById("key"),
    model: document.getElementById("model"),
    scale: document.getElementById("scale"),
    run: document.getElementById("run"),
    reset: document.getElementById("reset"),
    log: document.getElementById("log"),
    page: document.getElementById("page"),
    img: document.getElementById("img"),
    canvas: document.getElementById("overlay"),
    empty: document.getElementById("empty")
  };

  var objectUrl = null;
  var lastResult = null;
  var worker = null;

  function log(message) {
    var stamp = new Date().toLocaleTimeString("tr-TR");
    els.log.textContent = stamp + "  " + message + "\n" + els.log.textContent;
  }

  // ------------------------------------------------------------ sağlayıcı

  /* Model listesi ve anahtar ipucu sağlayıcıya göre değişir; aynı liste
   * popup.js'de de kullanılıyor. */
  function fillProviders() {
    MangaTRProviders.list().forEach(function (provider) {
      var option = document.createElement("option");
      option.value = provider.id;
      option.textContent = provider.label;
      els.provider.appendChild(option);
    });
  }

  function currentProvider() {
    return MangaTRProviders.get(els.provider.value);
  }

  function fillModels() {
    var provider = currentProvider();
    var models = provider.models || [];
    els.model.innerHTML = "";
    if (!models.length) {
      var none = document.createElement("option");
      none.value = provider.defaultModel || "";
      none.textContent = provider.defaultModel || "sunucu varsayılanı";
      els.model.appendChild(none);
      return;
    }
    models.forEach(function (model) {
      var option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      els.model.appendChild(option);
    });
    els.model.value = provider.defaultModel;
  }

  function applyProvider() {
    var provider = currentProvider();
    fillModels();
    els.key.placeholder = provider.keyPlaceholder || "anahtar";
    log("servis: " + provider.label + " — " + (provider.hint || ""));
  }

  // --------------------------------------------------------------- OCR

  /* Tesseract 5 sürümünde söz varlığı data.words altında, 6'da
   * data.blocks içinde; ikisini de kabul et. */
  function collectWords(data) {
    if (Array.isArray(data.words) && data.words.length) return data.words;

    var words = [];
    (function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (Array.isArray(node.words) && node.words.length) {
        node.words.forEach(function (w) { words.push(w); });
      }
      if (Array.isArray(node.lines)) node.lines.forEach(walk);
      if (Array.isArray(node.paragraphs)) node.paragraphs.forEach(walk);
      if (Array.isArray(node.blocks)) node.blocks.forEach(walk);
    })(data.blocks);

    return words;
  }

  function recognize(file) {
    return Tesseract.createWorker(["jpn", "eng"], 1, {
      logger: function (m) {
        if (m.status === "recognizing text") return;
        log("OCR: " + m.status + " " + (m.progress ? Math.round(m.progress * 100) + "%" : ""));
      }
    }).then(function (created) {
      worker = created;
      log("OCR: dil modelleri indiriliyor (ilk seferde biraz sürebilir)...");
      return worker.recognize(file);
    });
  }

  // ------------------------------------------------------------ render

  function fitCanvas(img) {
    // Cihazdaki 6M piksel tavanının tarayıcı karşılığı; iOS'ta bellek
    // sınırı olduğu için burada da kısıyoruz.
    var pixels = img.naturalWidth * img.naturalHeight;
    var scale = pixels > 6000000 ? Math.sqrt(6000000 / pixels) : 1;
    els.canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    els.canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    els.canvas.style.width = "100%";
    els.canvas.style.height = "100%";
    return scale;
  }

  function draw(result) {
    var img = els.img;
    var sampler = MangaTROverlay.createSampler(img, img.naturalWidth, img.naturalHeight);
    var scale = fitCanvas(img);
    var ctx = els.canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    var painted = MangaTROverlay.render(
      els.canvas,
      sampler,
      result.blocks,
      result.translations,
      { fontScale: Number(els.scale.value) }
    );
    log(painted + "/" + result.blocks.length + " metin yerleştirildi");
  }

  // --------------------------------------------------------------- akış

  function run() {
    var file = els.file.files && els.file.files[0];
    if (!file) return;

    els.run.disabled = true;
    els.canvas.getContext("2d").clearRect(0, 0, els.canvas.width, els.canvas.height);

    recognize(file)
      .then(function (out) {
        var words = collectWords(out.data);
        var boxes = words
          .filter(function (w) {
            return w.text && w.text.trim() && w.confidence > 40;
          })
          .map(function (w) {
            return {
              text: w.text.trim(),
              x: w.bbox.x0,
              y: w.bbox.y0,
              width: w.bbox.x1 - w.bbox.x0,
              height: w.bbox.y1 - w.bbox.y0,
              confidence: w.confidence
            };
          });
        log("OCR: " + boxes.length + " kelime bulundu");

        var blocks = MangaTROverlay.clusterBoxes(boxes);
        blocks.forEach(function (b, i) { b.id = i; });
        log("kümeleme: " + blocks.length + " metin bloğu");
        if (!blocks.length) throw new Error("Bu sayfada metin bulunamadı.");

        var items = blocks.map(function (b) {
          return { id: b.id, text: b.text };
        });

        var provider = currentProvider();
        var apiKey = els.key.value.trim();
        if (!apiKey) throw new Error(provider.label + " API anahtarını gir.");

        log("çeviri: " + items.length + " blok tek istekte " + provider.label + " servisine gönderiliyor...");
        var keys = {};
        keys[provider.id] = apiKey;
        return MangaTRTranslate.translate(items, {
          provider: provider.id,
          model: els.model.value,
          apiKeys: keys
        }).then(function (payload) {
          var map = {};
          (payload.results || []).forEach(function (r) {
            if (r.text) map[r.id] = r.text;
          });
          if (!Object.keys(map).length) {
            throw new Error(
              (payload.errors && payload.errors[0] && payload.errors[0].error) || "çeviri dönmedi"
            );
          }
          log("çevrildi: " + Object.keys(map).length + "/" + blocks.length);
          Object.keys(map).forEach(function (id) {
            log("  " + blocks[id].text.slice(0, 24) + "  →  " + map[id]);
          });
          lastResult = { blocks: blocks, translations: map };
          draw(lastResult);
          els.reset.disabled = false;
        });
      })
      .catch(function (error) {
        log("HATA: " + (error && error.message ? error.message : error));
      })
      .then(function () {
        els.run.disabled = false;
      });
  }

  fillProviders();
  applyProvider();
  els.provider.addEventListener("change", applyProvider);

  els.file.addEventListener("change", function () {
    var file = els.file.files && els.file.files[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    els.page.hidden = false;
    els.empty.hidden = true;
    els.reset.disabled = true;
    lastResult = null;
    els.img.onload = function () {
      fitCanvas(els.img);
      log("sayfa: " + els.img.naturalWidth + "×" + els.img.naturalHeight);
      log("OCR tanıma dikey Japonca için zayıf; sayfadaki birkaç balonu seçip deneyebilirsin.");
    };
    els.img.src = objectUrl;
    els.run.disabled = false;
  });

els.run.addEventListener("click", run);

els.reset.addEventListener("click", function () {
  var ctx = els.canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  els.reset.disabled = true;
});

els.scale.addEventListener("change", function () {
  if (lastResult) draw(lastResult);
});
})();