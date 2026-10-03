/* translator.js beklediği tek global. Tarayıcıda eklenti deposu yok, bellekte
 * tutuyoruz. Bu dosya hem preview.html hem tools/preview-check.js tarafından
 * yüklenir; ayrı kopyaları olursa önizleme sessizce eski davranışa düşer. */
var MangaTR = {
  DEFAULTS: { model: "gemini-3.8-flash" },
  hash: (function () {
    return function (text) {
      var h = 0;
      for (var i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
      return String(h);
    };
  })(),
  api: function () {
    return {
      storage: {
        local: {
          get: function () { return Promise.resolve({}); },
          set: function () { return Promise.resolve(); },
          remove: function () { return Promise.resolve(); }
        }
      },
      runtime: { getManifest: function () { return { version: "preview" }; } }
    };
  }
};