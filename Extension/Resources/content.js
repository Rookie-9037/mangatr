/* Page-side orchestration: find the manga, run OCR, translate, repaint.
 *
 * The DOM is left alone until an image actually looks like a manga page and is
 * about to scroll into view, and unwrapped again if the page turns out not to
 * have any lettering on it. */
(function () {
  "use strict";

  /* iOS caps canvas area; a 3000x4500 spread would be 13.5M pixels and can get
   * a page evicted, so the overlay is rendered at a capped resolution and
   * scaled down by CSS. Text drawn at image resolution then downsamples
   * cleanly instead of being upscaled. */
  var MAX_OVERLAY_PIXELS = 6000000;
  var PREFETCH_MARGIN = "300px";

  var settings = MangaTR.DEFAULTS;
  var tracked = [];
  var state = new WeakMap();
  var queue = [];
  var running = false;
  var nativeWarned = false;
  var pill = null;
  var pillTimer = null;

  // ------------------------------------------------------------------- pill

  function ensurePill() {
    if (pill && pill.isConnected) return pill;
    pill = document.createElement("div");
    pill.className = "mangatr-pill";
    pill.setAttribute("data-mangatr", "pill");

    var spinner = document.createElement("span");
    spinner.className = "mangatr-spinner";
    var dot = document.createElement("span");
    dot.className = "mangatr-dot";
    var label = document.createElement("span");
    label.className = "mangatr-text";

    pill.appendChild(spinner);
    pill.appendChild(dot);
    pill.appendChild(label);
    (document.body || document.documentElement).appendChild(pill);
    return pill;
  }

  function setPill(message, done) {
    if (!settings.showPill) return;
    if (!message) {
      if (pill) pill.hidden = true;
      return;
    }
    var node = ensurePill();
    node.hidden = false;
    node.classList.toggle("is-done", !!done);
    var text = node.querySelector(".mangatr-text");
    if (text.textContent !== message) text.textContent = message;
    if (pillTimer) clearTimeout(pillTimer);
    if (done) {
      pillTimer = setTimeout(function () {
        node.hidden = true;
      }, 2400);
    }
  }

  // -------------------------------------------------------------- selection

  function isCandidate(img) {
    if (!MangaTROCR.isRenderable(img)) return false;
    if (img.naturalWidth < settings.minPixelWidth) return false;
    if (img.naturalHeight < settings.minPixelHeight) return false;
    var source = img.currentSrc || img.src || "";
    if (!/^(https?:|blob:|data:)/i.test(source)) return false;
    // Banners are wide but short; a page is roughly a page.
    if (img.naturalHeight / img.naturalWidth < 0.35) return false;
    return img.getBoundingClientRect().width >= 280;
  }

  // ---------------------------------------------------------------- overlay

  function canvasScaleFor(img) {
    var pixels = img.naturalWidth * img.naturalHeight;
    if (pixels <= MAX_OVERLAY_PIXELS) return 1;
    return Math.sqrt(MAX_OVERLAY_PIXELS / pixels);
  }

  function attachOverlay(img) {
    var existing = state.get(img);
    if (existing) return existing;

    var origin = {
      parent: img.parentNode,
      next: img.nextSibling
    };

    var host = document.createElement("div");
    host.className = "mangatr-host";
    if (origin.parent) {
      origin.parent.insertBefore(host, img);
      host.appendChild(img);
    }

    var scale = canvasScaleFor(img);
    var canvas = document.createElement("canvas");
    canvas.className = "mangatr-canvas is-loading";
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    var entry = {
      host: host,
      canvas: canvas,
      scale: scale,
      origin: origin,
      sampler: null,
      blocks: [],
      translations: {},
      done: false,
      started: false
    };
    state.set(img, entry);
    tracked.push(img);
    // Repaints iterate this list, so a long SPA session must not grow it
    // without bound and pin every image ever seen.
    if (tracked.length > 60) tracked.splice(0, tracked.length - 60);
    return entry;
  }

  /* Puts the page back exactly as it was. Anything that is not a translated
   * manga page must not stay wrapped, or ordinary sites pay for our mistake. */
  function unwrap(entry, img) {
    if (entry.canvas && entry.canvas.parentNode) entry.canvas.parentNode.removeChild(entry.canvas);
    if (entry.host && entry.host.parentNode) {
      entry.host.parentNode.removeChild(entry.host);
    }
    if (entry.origin && entry.origin.parent && img) {
      if (entry.origin.next && entry.origin.next.parentNode === entry.origin.parent) {
        entry.origin.parent.insertBefore(img, entry.origin.next);
      } else {
        entry.origin.parent.appendChild(img);
      }
    }
    entry.done = true;
    entry.blocks = [];
    entry.translations = {};
  }

  function repaint(entry) {
    if (!entry || !entry.blocks.length || !entry.canvas.isConnected || !entry.sampler) return;
    var ctx = entry.canvas.getContext("2d");
    ctx.setTransform(entry.scale, 0, 0, entry.scale, 0, 0);
    MangaTROverlay.render(entry.canvas, entry.sampler, entry.blocks, entry.translations, settings);
    entry.canvas.classList.remove("is-loading");
  }

  function repaintAll() {
    tracked.forEach(function (img) {
      var entry = state.get(img);
      if (entry && entry.done && entry.blocks.length) repaint(entry);
    });
  }

  // ------------------------------------------------------------- processing

  function applyTranslations(entry, blocks, payload, img) {
    var map = {};
    ((payload && payload.results) || []).forEach(function (item) {
      if (item.text) map[item.id] = item.text;
    });
    entry.translations = map;
    entry.done = true;

    var count = Object.keys(map).length;
    if (!count) {
      // Nothing usable: leave the page untouched rather than covering the
      // original with empty balloons.
      unwrap(entry, img);
      var reason =
        (payload && payload.errors && payload.errors[0] && payload.errors[0].error) || "çevrilmedi";
      setPill("MangaTR: " + reason, true);
      return;
    }

    repaint(entry);
    setPill(
      count < blocks.length
        ? "MangaTR: " + count + "/" + blocks.length + " çevrildi"
        : "MangaTR: " + count + " metin çevrildi",
      true
    );
  }

  // Settings are re-read per image: the popup may have changed the model or the
  // key since this tab loaded, and relying on a broadcast message would miss
  // tabs that were opened before it.
  function refreshSettings() {
    return MangaTR.getSettings().then(function (loaded) {
      settings = loaded;
      return loaded;
    });
  }

  function process(img) {
    if (state.has(img)) {
      var existing = state.get(img);
      if (existing.done || existing.started) return Promise.resolve();
    }

    return refreshSettings().then(function () {
      // Erasing is the whole trick; with it off there is nothing useful to do
      // that would not obscure the original page.
      if (!settings.hideOriginal) {
        setPill("MangaTR: orijinali gizle kapalı, sayfa değiştirilmedi", true);
        return null;
      }
      if (state.has(img)) return null;
      return runPipeline(img, attachOverlay(img));
    });
  }

  function runPipeline(img, entry) {
    entry.started = true;

    return MangaTR.nativeAvailable()
      .then(function (available) {
        if (!available) {
          if (!nativeWarned) {
            nativeWarned = true;
            setPill("MangaTR: OCR bağlantısı yok, uygulamayı bir kez aç", true);
          }
          unwrap(entry, img);
          return null;
        }

        return MangaTROCR.recognize(img).then(function (result) {
          var blocks = MangaTROverlay.clusterBoxes(result.boxes || []);
          if (!blocks.length) {
            unwrap(entry, img);
            return null;
          }

          var source = result.analysis || img;
          entry.sampler = MangaTROverlay.createSampler(
            source,
            img.naturalWidth,
            img.naturalHeight
          );
          blocks.forEach(function (block, index) {
            block.id = index;
          });
          entry.blocks = blocks;

          var items = blocks.map(function (block) {
            return { id: block.id, text: block.text };
          });

          setPill("MangaTR: " + blocks.length + " metin çevriliyor…");
          return MangaTR.send({ type: "translate", items: items }).then(function (reply) {
            if (!reply || !reply.ok) {
              throw new Error((reply && reply.error) || "çeviri bağlantısı koptu");
            }
            applyTranslations(entry, blocks, reply.result, img);
          });
        });
      })
      .catch(function (error) {
        unwrap(entry, img);
        setPill("MangaTR: " + String((error && error.message) || error), true);
      });
  }

  function pump() {
    if (running || !queue.length) return;
    running = true;
    var next = queue.shift();
    process(next)
      .catch(function () {})
      .then(function () {
        running = false;
        pump();
      });
  }

  function enqueue(img) {
    if (state.has(img)) return;
    if (queue.indexOf(img) === -1) queue.push(img);
    pump();
  }

  // ------------------------------------------------------------- observers

  var intersectionObserver = null;

  function ensureObserver() {
    if (intersectionObserver) return intersectionObserver;
    intersectionObserver = new IntersectionObserver(
      function (records) {
        records.forEach(function (record) {
          if (record.isIntersecting) enqueue(record.target);
        });
      },
      { rootMargin: PREFETCH_MARGIN, threshold: 0.01 }
    );
    return intersectionObserver;
  }

  var scanTimer = null;

  function scan() {
    if (!settings.enabled) return;
    var images = document.querySelectorAll("img");
    var observer = ensureObserver();
    for (var i = 0; i < images.length; i++) {
      if (state.has(images[i])) continue;
      if (isCandidate(images[i])) observer.observe(images[i]);
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  }

  // ---------------------------------------------------------------- wiring

  function start() {
    refreshSettings().then(function () {
      scan();

      MangaTR.api().runtime.onMessage.addListener(function (message) {
        if (message && message.type === "settings:changed") {
          settings = message.settings;
          repaintAll();
          if (settings.enabled) scheduleScan();
        }
        return false;
      });

      // Font size and erasing only need a repaint, not a re-translation.
      MangaTR.api().storage.onChanged.addListener(function (changes, area) {
        if (area !== "local") return;
        if (!changes.fontScale && !changes.hideOriginal) return;
        refreshSettings().then(repaintAll);
      });

      // Manga readers are SPAs: the next page arrives as new <img> nodes, and
      // lazy loaders reveal them long after DOMContentLoaded.
      new MutationObserver(scheduleScan).observe(document.body, {
        childList: true,
        subtree: true
      });

      var attempts = 0;
      var timer = setInterval(function () {
        attempts++;
        scan();
        if (attempts > 15) clearInterval(timer);
      }, 1200);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();