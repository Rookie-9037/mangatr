/* Page image -> Vision OCR.
 * Runs in the content script. Bytes are prepared here (so a 4000px spread can
 * be downscaled before it is shipped) and recognised in the native handler.
 *
 * The same bytes are decoded once more into a small analysis canvas. Doing it
 * from the bytes rather than from the <img> matters: a cross-origin manga
 * image taints the page's canvas, and every colour decision the overlay makes
 * would silently degrade to flat white. */
var MangaTROCR = (function () {
  "use strict";

  var ANALYSIS_MAX_EDGE = 1000;
  var CHUNK_CHARS = 480 * 1024;

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var step = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error("Blob oluşturulamadı"));
          },
          type,
          quality
        );
      } catch (error) {
        // Thrown when the canvas is tainted, i.e. the image is cross-origin
        // and the site sends no CORS headers.
        reject(error);
      }
    });
  }

  function isRenderable(img) {
    return !!img && img.complete && img.naturalWidth > 0;
  }

  function canvasToBytes(canvas) {
    // Line art survives JPEG poorly, so keep PNG while the page stays small.
    var useJpeg = canvas.width * canvas.height > 1200000;
    return canvasToBlob(canvas, useJpeg ? "image/jpeg" : "image/png", 0.92).then(function (blob) {
      return blob.arrayBuffer();
    });
  }

  /* Webtoon pages are vertical strips: a 800x20000 episode chapter is normal.
   * Scaling the longest edge down to fit one Vision pass would leave ~100px of
   * width and produce garbage, so tall images are cut into overlapping vertical
   * tiles and recognised one at a time at full horizontal resolution.
   *
   * Tile height is capped at MAX_CANVAS_EDGE because Safari refuses to hand out
   * a 2D context for a canvas past that on either axis. */
  var OCR_MAX_WIDTH = 1800;
  var TILE_SOURCE_HEIGHT = 2600;
  var TILE_OVERLAP = 140;
  var MAX_CANVAS_EDGE = 4000;

  function tilePlan(naturalWidth, naturalHeight) {
    var scale = Math.min(1, OCR_MAX_WIDTH / naturalWidth);
    var maxTileHeight = Math.max(600, Math.round(MAX_CANVAS_EDGE / scale));
    var tileHeight = Math.min(TILE_SOURCE_HEIGHT, maxTileHeight);
    var step = Math.max(1, tileHeight - TILE_OVERLAP);

    var tiles = [];
    for (var y = 0; y < naturalHeight; y += step) {
      var height = Math.min(tileHeight, naturalHeight - y);
      tiles.push({ y: y, height: height });
      if (y + height >= naturalHeight) break;
    }
    return { scale: scale, tiles: tiles };
  }

  /* Draws one tile straight from the <img>, at source resolution so nothing is
   * resampled twice. */
  /* Draws one tile from `source` at full horizontal resolution. */
  function tileBytes(source, tile, scale) {
    var width = Math.max(1, Math.round(source.naturalWidth * scale));
    var height = Math.max(1, Math.round(tile.height * scale));

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("2D bağlamı yok"));
    ctx.drawImage(source, 0, tile.y, source.naturalWidth, tile.height, 0, 0, width, height);

    return canvasToBytes(canvas);
  }

  function runTile(source, tile, scale, lang) {
    return tileBytes(source, tile, scale).then(function (buffer) {
      return chunkedNativeTransfer(arrayBufferToBase64(buffer), lang).then(function (reply) {
        if (!reply || !reply.ok) throw new Error((reply && reply.error) || "OCR başarısız");

        var scaleX = source.naturalWidth / (reply.w || 1);
        var scaleY = tile.height / (reply.h || 1);

        return (reply.boxes || []).map(function (box) {
          return {
            text: box.t,
            x: box.x * scaleX,
            // Lift the box out of tile space back into whole-image space.
            y: tile.y + box.y * scaleY,
            width: box.w * scaleX,
            height: box.h * scaleY,
            confidence: box.c
          };
        });
      });
    });
  }

  /* box.js de-duplicates the overlap between consecutive tiles; Vision happily
   * reports the same line twice when it sits right on a seam. */
  function dropSeamDuplicates(boxes) {
    var sorted = boxes.slice().sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });
    var kept = [];
    sorted.forEach(function (box) {
      var duplicate = false;
      for (var i = kept.length - 1; i >= 0 && i >= kept.length - 8; i--) {
        var other = kept[i];
        var overlapY = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
        var overlapX = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
        if (overlapY > box.height * 0.6 && overlapX > box.width * 0.6 && box.text === other.text) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) kept.push(box);
    });
    return kept;
  }

  /* Samples the whole page for colour work. Scaled by its longest edge, so the
   canvas stays small and legal for a 20000px strip — just narrow, which is all
   the overlay needs: it wants the flat fill of a balloon and a clean nearby
   patch, not the lettering. Drawing straight from the <img> means we never hold
   a page-sized buffer in memory. */
  function analysisCanvas(img) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      var width = Math.max(1, Math.round(img.naturalWidth * scale));
      var height = Math.max(1, Math.round(img.naturalHeight * scale));

      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, width, height);
      resolve(canvas);
    });
  }

  function chunkedNativeTransfer(base64, lang) {
    var chunks = [];
    for (var i = 0; i < base64.length; i += CHUNK_CHARS) {
      chunks.push(base64.slice(i, i + CHUNK_CHARS));
    }
    var id = "ocr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    return MangaTR.native({
      type: "ocrBegin",
      id: id,
      chunks: chunks.length,
      lang: lang || "auto"
    }).then(function (reply) {
      if (!reply || !reply.ok) throw new Error((reply && reply.error) || "OCR oturumu açılamadı");

      var chain = Promise.resolve();
      chunks.forEach(function (chunk, index) {
        chain = chain.then(function () {
          return MangaTR.native({ type: "ocrChunk", id: id, i: index, d: chunk });
        });
      });
      return chain.then(function () {
        return MangaTR.native({ type: "ocrCommit", id: id });
      });
    });
  }

  /* Drawing a cross-origin <img> onto a canvas taints it, and toBlob() then
   * throws. The workaround is to pull the bytes through the native handler once
   * and decode them into an <img> that counts as same-origin; every tile is
   * then drawn from that copy. One fetch, however tall the strip is. */
  function decodedCopy(img) {
    return MangaTR.send({
      type: "image:fetch",
      url: img.currentSrc || img.src,
      referer: location.href
    }).then(function (reply) {
      if (!reply || !reply.ok) {
        throw new Error((reply && reply.error) || "Görsel indirilemedi");
      }
      var binary = atob(reply.result.b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var url = URL.createObjectURL(new Blob([bytes], { type: reply.result.mime || "image/png" }));
      return new Promise(function (resolve, reject) {
        var copy = new Image();
        copy.onload = function () {
          URL.revokeObjectURL(url);
          resolve(copy);
        };
        copy.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("Görsel çözülemedi"));
        };
        copy.src = url;
      });
    });
  }

  /* Tiles are recognised in order so the pill can say how far along it is. */
  function recognize(img, settings, onProgress) {
    if (!isRenderable(img)) {
      return Promise.reject(new Error("Görsel henüz yüklenmedi"));
    }

    var options = settings || {};
    var lang = options.sourceLanguages || "auto";
    var plan = tilePlan(img.naturalWidth, img.naturalHeight);

    // Prefer the already-decoded <img> and only pay for a network round trip if its
    // canvas turns out to be tainted. The probe is done once, not per tile,
    // because a ten-tile webtoon strip would otherwise fetch ten times.
    var source = img;

    return tileBytes(source, plan.tiles[0], plan.scale)
      .then(function () {
        return source;
      })
      .catch(function () {
        return decodedCopy(img);
      })
      .then(function (resolved) {
        source = resolved;
        // Sampled from the resolved copy, not the page's <img>: a cross-origin
        // copy is same-origin by construction, so the colours stay real.
        return analysisCanvas(source);
      })
      .then(function (analysis) {
        var collected = [];
        var chain = Promise.resolve();

        plan.tiles.forEach(function (tile, index) {
          chain = chain.then(function () {
            return runTile(source, tile, plan.scale, lang).then(function (boxes) {
              collected = collected.concat(boxes);
              // A 20-tile webtoon takes a while, and a silent page reads as a
              // broken one.
              if (onProgress) {
                onProgress(index + 1, plan.tiles.length);
              }
            });
          });
        });

        return chain.then(function () {
          return { boxes: dropSeamDuplicates(collected), analysis: analysis };
        });
      });
  }

  return {
    recognize: recognize,
    isRenderable: isRenderable
  };
})();