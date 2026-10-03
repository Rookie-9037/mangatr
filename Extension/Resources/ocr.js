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

  var MAX_EDGE = 2400;
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

  function bytesFromNetwork(img) {
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
      return bytes.buffer;
    });
  }

  /* Preferred path: draw the already-decoded <img> into a canvas. Same-origin
   * manga sites land here and never hit the network a second time. */
  function bytesFromCanvas(img) {
    var scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    var width = Math.max(1, Math.round(img.naturalWidth * scale));
    var height = Math.max(1, Math.round(img.naturalHeight * scale));

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("2D bağlamı yok"));
    ctx.drawImage(img, 0, 0, width, height);

    return canvasToBytes(canvas).catch(function () {
      return bytesFromNetwork(img);
    });
  }

  /* blob: URLs are same-origin, so the canvas built from them stays readable
   * even when the original image was not. */
  function analysisCanvas(buffer) {
    return new Promise(function (resolve) {
      var url;
      try {
        url = URL.createObjectURL(new Blob([buffer]));
      } catch (error) {
        resolve(null);
        return;
      }

      var probe = new Image();
      probe.onload = function () {
        var scale = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(probe.naturalWidth, probe.naturalHeight));
        var width = Math.max(1, Math.round(probe.naturalWidth * scale));
        var height = Math.max(1, Math.round(probe.naturalHeight * scale));
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(probe, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      probe.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      probe.src = url;
    });
  }

  function chunkedNativeTransfer(base64) {
    var chunks = [];
    for (var i = 0; i < base64.length; i += CHUNK_CHARS) {
      chunks.push(base64.slice(i, i + CHUNK_CHARS));
    }
    var id = "ocr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

    return MangaTR.native({ type: "ocrBegin", id: id, chunks: chunks.length }).then(function (reply) {
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

  /* -> { boxes: [...], analysis: HTMLCanvasElement|null }, boxes expressed in
   * the image's own pixel coordinates. */
  function recognize(img) {
    if (!isRenderable(img)) {
      return Promise.reject(new Error("Görsel henüz yüklenmedi"));
    }

    var bufferPromise = bytesFromCanvas(img);

    return bufferPromise
      .then(function (buffer) {
        return analysisCanvas(buffer).then(function (analysis) {
          return { buffer: buffer, analysis: analysis };
        });
      })
      .then(function (prepared) {
        return chunkedNativeTransfer(arrayBufferToBase64(prepared.buffer)).then(function (reply) {
          if (!reply || !reply.ok) throw new Error((reply && reply.error) || "OCR başarısız");

          var processedWidth = reply.w || img.naturalWidth;
          var processedHeight = reply.h || img.naturalHeight;
          var scaleX = img.naturalWidth / processedWidth;
          var scaleY = img.naturalHeight / processedHeight;

          var boxes = (reply.boxes || []).map(function (box) {
            return {
              text: box.t,
              x: box.x * scaleX,
              y: box.y * scaleY,
              width: box.w * scaleX,
              height: box.h * scaleY,
              confidence: box.c
            };
          });

          return { boxes: boxes, analysis: prepared.analysis };
        });
      });
  }

  return {
    recognize: recognize,
    isRenderable: isRenderable
  };
})();