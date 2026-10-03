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
  // iOS refuses to allocate a 2D canvas context past roughly this on either axis.
  var MAX_CANVAS_EDGE = 4000;
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
      }, 10000);
    }
  }

  // ----------------------------------------------------------- diagnostics

  /* Every way this extension can quietly do nothing used to be invisible, which
   * made "it didn't translate" impossible to act on: the page just looked
   * untouched. These notes collect the reason and the pill states it outright. */
  var diag = [];
  var diagStats = { images: 0, eligible: 0, canvases: 0 };

  function note(key) {
    if (diag.indexOf(key) === -1) diag.push(key);
    return message;
  }

  function diagReport() {
    return diag.join(" · ");
  }

  /* A one-shot explanation for the common "nothing happened" cases. Kept
   * separate from setPill so the wording can grow without touching the
   * progress messages. */
  function explainSilence() {
    if (!settings.showPill) return;
    var detail = [];
    if (diagStats.canvases && !diagStats.eligible) {
      detail.push(diagStats.canvases + " canvas var, uzantı sadece <img> okuyor");
    }
    if (diag.length) detail.push(diagReport());
    if (!detail.length) {
      detail.push(
        diagStats.images + " görsel bulundu, uygun sayfa yok (eşik: " +
          settings.minPixelWidth + "x" + settings.minPixelHeight + ")"
      );
    }
    setPill("MangaTR: " + detail.join(" · "), true);
  }

  // -------------------------------------------------------------- selection

  /* `why` collects why an image was skipped so a page that matched nothing can
   * say so out loud instead of leaving the user guessing. */
  function isCandidate(img, why) {
    if (!MangaTROCR.isRenderable(img)) {
      if (why) note("görsel henüz yüklenmedi");
      return false;
    }
    if (img.naturalWidth < settings.minPixelWidth || img.naturalHeight < settings.minPixelHeight) {
      if (why) {
        note("görsel çok küçük (" + img.naturalWidth + "x" + img.naturalHeight + ")");
      }
      return false;
    }
    var source = img.currentSrc || img.src || "";
    if (!/^(https?:|blob:|data:)/i.test(source)) {
      if (why) note("görsel bir dosya değil");
      return false;
    }
    // Banners are wide but short; a page is roughly a page. Tall webtoon strips
    // stay well above this ratio on purpose.
    if (img.naturalHeight / img.naturalWidth < 0.35) {
      if (why) note("görsel bir banner şeridi");
      return false;
    }
    if (img.getBoundingClientRect().width < 280) {
      if (why) note("görsel ekranda çok dar");
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- overlay

  function canvasScaleFor(img) {
    var pixels = img.naturalWidth * img.naturalHeight;
    if (pixels <= MAX_OVERLAY_PIXELS) return 1;
    return Math.sqrt(MAX_OVERLAY_PIXELS / pixels);
  }

  /* Safari will not hand out a 2D context for a canvas taller than this on iOS,
   * and a webtoon strip scaled to the pixel budget is routinely 12000px tall.
   * So the overlay becomes several canvases stacked over one image, each
   * covering a horizontal band and each drawing with a vertical offset. */
  function overlaySlices(img, scale) {
    var totalHeight = Math.max(1, Math.round(img.naturalHeight * scale));
    var count = Math.max(1, Math.ceil(totalHeight / MAX_CANVAS_EDGE));
    var band = Math.ceil(totalHeight / count);

    var slices = [];
    for (var i = 0; i < count; i++) {
      var top = i * band;
      var bottom = Math.min(totalHeight, top + band);
      if (top >= bottom) break;
      slices.push({
        top: top,
        height: bottom - top,
        // Image-space y the band starts at, so a slice can be told where it
        // sits without knowing anything about the other bands.
        origin: top / scale,
        cssTop: (top / totalHeight) * 100,
        cssHeight: ((bottom - top) / totalHeight) * 100,
        canvas: null
      });
    }
    return slices;
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
    var slices = overlaySlices(img, scale);
    slices.forEach(function (slice) {
      var canvas = document.createElement("canvas");
      canvas.className = "mangatr-canvas is-loading";
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, slice.height);
      canvas.style.width = "100%";
      canvas.style.height = slice.cssHeight + "%";
      canvas.style.top = slice.cssTop + "%";
      slice.canvas = canvas;
      host.appendChild(canvas);
    });

    var entry = {
      host: host,
      slices: slices,
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
    entry.slices.forEach(function (slice) {
      if (slice.canvas && slice.canvas.parentNode) slice.canvas.parentNode.removeChild(slice.canvas);
    });
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
    if (!entry || !entry.blocks.length || !entry.sampler) return;
    var live = false;
    entry.slices.forEach(function (slice) {
      if (!slice.canvas || !slice.canvas.isConnected) return;
      live = true;
      var ctx = slice.canvas.getContext("2d");
      ctx.setTransform(entry.scale, 0, 0, entry.scale, 0, -slice.origin * entry.scale);
      MangaTROverlay.render(slice.canvas, entry.sampler, entry.blocks, entry.translations, settings);
      slice.canvas.classList.remove("is-loading");
    });
    return live;
  }

  function repaintAll() {
    tracked.forEach(function (img) {
      var entry = state.get(img);
      if (entry && entry.done && entry.blocks.length) repaint(entry);
    });
  }

  // ------------------------------------------------------------- processing

  function applyTranslations(entry, blocks, payload, img, sourceLabel) {
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
    var prefix = sourceLabel ? sourceLabel + " · " : "";
    setPill(
      count < blocks.length
        ? "MangaTR: " + prefix + count + "/" + blocks.length + " çevrildi"
        : "MangaTR: " + prefix + count + " metin çevrildi",
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
        /* Vision needs the app extension, which a free Apple ID cannot sign: the
           process is killed on launch. Rather than refusing to work, fall back to
           reading the page with a vision model. Slower and it uploads the page
           image, but it is the difference between translating and not. */
        var remote = !available;
        if (remote && !nativeWarned) {
          nativeWarned = true;
          setPill(
            "MangaTR: cihazda OCR yok (" +
              (MangaTR.nativeErrorText() || "bilinmeyen") +
              ") — görseli Gemini ile okuyorum",
            true
          );
        }

        return MangaTROCR.recognize(img, settings, function (done, total) {
          // blocks is not known yet at this point, so the count is left out;
          // what matters here is that something is visibly happening.
          setPill("MangaTR: sayfa okunuyor " + done + "/" + total + " parça…");
        }, remote).then(function (result) {
          var blocks = MangaTROverlay.clusterBoxes(result.boxes || []);
          if (!blocks.length) {
            /* Used to be a completely silent no-op: the overlay was removed and
               the page looked untouched, so a failed OCR was indistinguishable
               from the extension not running at all. */
            note("OCR metin bulamadı (" + (result.boxes ? result.boxes.length : 0) + " kutu)");
            unwrap(entry, img);
            explainSilence();
            return null;
          }

          // Only now that we have text can we tell what language it is. A page
          // that is already Turkish must be left exactly as it is: erasing the
          // lettering and handing the model the same words back is pure damage.
          var detected = MangaTRLang.detect(
            blocks.map(function (block) {
              return block.text;
            }).join("\n")
          );
          if (detected.isTurkish) {
            unwrap(entry, img);
            setPill("MangaTR: sayfa zaten Türkçe, dokunulmadı", true);
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

          // Script detection settles Japanese, Korean and Chinese on its own.
          // For Latin pages a short bubble carries too little signal for a
          // word list, so the model is asked to name the language too and its
          // answer is used when the local guess came back empty.
          var sourceLabel = MangaTRLang.describe(detected, settings);
          setPill(
            "MangaTR: " +
              (sourceLabel ? sourceLabel + " · " : "") +
              blocks.length +
              " metin çevriliyor…"
          );
          return MangaTR.send({
            type: "translate",
            items: items,
            source: { code: detected.code, label: sourceLabel }
          }).then(function (reply) {
            if (!reply || !reply.ok) {
              throw new Error((reply && reply.error) || "çeviri bağlantısı koptu");
            }
            var payload = reply.result;

            // The model can recognise a Turkish page the word list missed, for
            // instance a fan scan in Latin script with almost no particles.
            if (
              payload.language === "tr" &&
              (!detected.code || detected.code === "unknown")
            ) {
              unwrap(entry, img);
              setPill("MangaTR: sayfa Türkçe görünüyor, dokunulmadı", true);
              return;
            }

            var resolvedLabel = sourceLabel;
            if (!resolvedLabel && payload.language) {
              resolvedLabel = MangaTRLang.LABELS[payload.language] || "";
            }
            entry.sourceLabel = resolvedLabel;
            applyTranslations(entry, blocks, payload, img, resolvedLabel);
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

  /* Collects elements from the light DOM *and* from open shadow roots.
   *
   * querySelectorAll cannot see into a shadow tree, so a reader that renders its
   * pages inside a web component looks exactly like a page that has no images at
   * all -- which is how an entire site reports "0 görsel tarandı" and nothing
   * ever gets translated. Depth is bounded because shadow trees nest. */
  function collectAll(selector, out, root, depth) {
    out = out || [];
    root = root || document;
    depth = depth || 0;
    if (depth > 6) return out;

    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) out.push(found[i]);

    var hosts = root.querySelectorAll("*");
    for (var j = 0; j < hosts.length; j++) {
      if (hosts[j].shadowRoot) collectAll(selector, out, hosts[j].shadowRoot, depth + 1);
    }
    return out;
  }

  /* Site-independent escape hatch, wired to the popup's "Bu sayfayı çevir".
   *
   * Automatic detection depends on the page image intersecting the viewport.
   * Plenty of manga readers never let that happen in a form we can observe --
   * paged carousels park non-current pages off-screen, zoomable viewers keep the
   * page in a transformed layer, some render into a canvas -- and the result is
   * a site that silently does nothing, forever. This skips the intersection
   * observer and the size heuristics and simply takes the largest pictures that
   * are actually painted on screen. */
  function forceRun() {
    var images = collectAll("img");
    var painted = [];
    for (var i = 0; i < images.length; i++) {
      var img = images[i];
      if (!MangaTROCR.isRenderable(img)) continue;
      var source = img.currentSrc || img.src || "";
      if (!/^(https?:|blob:|data:)/i.test(source)) continue;
      // Rendered size, not natural size: the point is what the reader is showing.
      var rect = img.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;
      painted.push({ img: img, area: img.naturalWidth * img.naturalHeight });
    }
    painted.sort(function (a, b) {
      return b.area - a.area;
    });

    /* Clearing the recorded state is deliberate. The button has to be able to
     * retry a page that already failed -- an earlier attempt may have died on a
     * native ping or a network blip, and a WeakMap entry would otherwise make
     * that page permanently untranslatable. */
    var targets = painted.slice(0, 3);
    targets.forEach(function (item) {
      state.delete(item.img);
      var index = queue.indexOf(item.img);
      if (index !== -1) queue.splice(index, 1);
    });
    targets.forEach(function (item) {
      enqueue(item.img);
    });

    return {
      images: images.length,
      canvases: collectAll("canvas").length,
      painted: painted.length,
      queued: targets.length
    };
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
    /* Shadow-aware for the same reason forceRun is: a reader that hides its
       pages in a web component would otherwise never be picked up by the
       automatic pass either. */
    var images = collectAll("img");
    var observer = ensureObserver();
    var eligible = 0;
    for (var i = 0; i < images.length; i++) {
      if (state.has(images[i])) continue;
      if (isCandidate(images[i], true)) {
        eligible++;
        observer.observe(images[i]);
      }
    }
    diagStats.images = images.length;
    diagStats.eligible = eligible;
    diagStats.canvases = collectAll("canvas").length;
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  }

  // ---------------------------------------------------------------- wiring

  function start() {
    refreshSettings().then(function () {
      scan();

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
        if (attempts > 15) {
          clearInterval(timer);
          /* The watching window is over. If nothing was ever picked up, say why
             instead of leaving the page looking like the extension is broken. */
          if (!tracked.length && !diagStats.eligible) explainSilence();
        }
      }, 1200);
    }).catch(function (error) {
      /* Without this the page just sits there: every later stage is chained
       * onto this promise, so one failure at startup silently disables the whole
       * extension with no way to tell it apart from "nothing to translate". */
      setPill("MangaTR başlatılamadı: " + String((error && error.message) || error), true);
    });
  }

  /* Registered synchronously as the script runs, deliberately *not* inside
   * start()'s promise chain.
   *
   * A listener registered after an async hop simply does not exist if that hop
   * fails, and the page goes completely deaf while looking perfectly healthy:
   * the popup's manual trigger got no answer and reported "MangaTR is not
   * running here" about a script that was loaded and running. Being able to
   * answer "ping" is what makes that case distinguishable from Safari not having
   * injected the script at all. */
  MangaTR.api().runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;

    if (message.type === "ping") {
      sendResponse({
        ok: true,
        images: collectAll("img").length,
        canvases: collectAll("canvas").length
      });
      return false;
    }

    if (message.type === "settings:changed") {
      settings = message.settings;
      repaintAll();
      if (settings.enabled) scheduleScan();
      return false;
    }

    if (message.type === "ocr:run") {
      /* A frame with nothing in it stays silent on purpose.
       *
       * The content script runs in every frame, and tabs.sendMessage resolves
       * with whichever frame answers first. On a site whose reader lives in an
       * iframe, the empty top document used to win the race and report "0 görsel
       * tarandı" while the frame holding the actual page went unheard. Not
       * answering lets the capable frame speak; if nobody answers, the caller
       * knows no frame had anything to do. */
      if (!collectAll("img").length && !collectAll("canvas").length) return false;

      /* Settings are re-read here rather than trusted from the closure, because
       * this listener can fire before -- or instead of -- start() succeeding. */
      refreshSettings()
        .then(function () {
          if (!settings.enabled) throw new Error("MangaTR kapalı");
          var result = forceRun();
          if (result.queued) return result;
          /* Naming the cause is the whole point of the button: "no big image"
           * and "the reader draws to a canvas" need completely different fixes,
           * and neither is obvious from the outside. */
          if (!result.painted && result.canvases) {
            throw new Error(
              "Sayfa " + result.canvases + " canvas'a çiziliyor, MangaTR yalnız <img> okuyor " +
                "(" + result.images + " görsel var)"
            );
          }
          throw new Error(
            "Sayfada çevrilecek büyük görsel bulunamadı (" + result.images + " görsel tarandı)"
          );
        })
        .then(sendResponse, function (error) {
          sendResponse({ ok: false, error: String((error && error.message) || error) });
        });
      return true;
    }

    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();