/* Exercises overlay.js without a browser.
 *
 * Three halves:
 *  - clustering: neighbouring OCR boxes must merge into one block, padded
 *    balloons that touch must be trimmed rather than dropped, and the median
 *    glyph height used for typesetting must survive both steps.
 *  - typesetting: the chosen font size must follow the height of the original
 *    lettering rather than just the size of the balloon.
 *  - rendering: driven through a recording stub of the 2D context, so the erase
 *    pass and the drawn glyphs can be asserted on directly. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RES = path.join(__dirname, "..", "Extension", "Resources");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "TAMAM " : "HATA  ") + name + (detail ? " — " + detail : ""));
}

// ------------------------------------------------------------- canvas stub

const CHARS_PER_EM = 0.5;

function fillPixels(w, h, options) {
  const opts = options || {};
  const grey = opts.grey == null ? 200 : opts.grey;
  const noise = !!opts.noise;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    // A deterministic pattern: busy pages need high-contrast edges, and
    // randomness would make the donor assertions flaky.
    const v = noise ? (i % 2 === 0 ? 20 : 240) : grey;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/* `grey` sets a flat page tone, `noise` produces a busy one. Both matter: a
 * flat page takes the texture-copy path while a busy one falls back to a flat
 * fill, and the erase assertions need each of them.
 *
 * The pixel buffer is real and drawImage copies it, because overlay.js builds
 * its own sampler canvas through document.createElement and reads that one back
 * with getImageData. A stub that ignored drawImage would silently present every
 * page as flat grey. */
function makeCanvas(width, height, options) {
  // The effective tone can change: overlay.js resizes the canvas and draws a
  // source page into it, and only then reads pixels back. So the buffer is
  // rebuilt lazily, and the size is read off the canvas object rather than
  // captured, because the caller reassigns canvas.width/height after this
  // returns.
  const canvas = { width: width, height: height, ops: [] };
  let effective = options || {};
  let pixels = null;

  function ensure() {
    const wanted = canvas.width * canvas.height * 4;
    if (!pixels || pixels.length !== wanted) pixels = fillPixels(canvas.width, canvas.height, effective);
    return pixels;
  }

  const ctx = {
    ops: canvas.ops,
    save() { canvas.ops.push(["save"]); },
    restore() { canvas.ops.push(["restore"]); },
    setTransform(a, b, c, d, e, f) { canvas.ops.push(["setTransform", a, b, c, d, e, f]); },
    clearRect() { canvas.ops.push(["clearRect"].concat(Array.prototype.slice.call(arguments))); },
    beginPath() { canvas.ops.push(["beginPath"]); },
    closePath() { canvas.ops.push(["closePath"]); },
    moveTo(x, y) { canvas.ops.push(["moveTo", x, y]); },
    arcTo(x1, y1, x2, y2, r) { canvas.ops.push(["arcTo", x1, y1, x2, y2, r]); },
    fill() { canvas.ops.push(["fill", this._fill]); },
    drawImage(source) {
      if (source && source._effective) ctx._adopt(source._effective);
      canvas.ops.push(["drawImage"].concat(Array.prototype.slice.call(arguments)));
    },
    fillText(text, x, y) { canvas.ops.push(["fillText", text, x, y]); },
    strokeText(text, x, y) { canvas.ops.push(["strokeText", text, x, y]); },
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; },
    get strokeStyle() { return this._stroke; },
    set lineWidth(v) { this._lineWidth = v; },
    get lineWidth() { return this._lineWidth || 0; },
    set lineJoin(v) { this._lineJoin = v; },
    set miterLimit(v) { this._miter = v; },
    set textAlign(v) { this._align = v; },
    set textBaseline(v) { this._baseline = v; },
    set font(value) {
      this._font = value;
      // Mirror it back, because the test needs to read the size that was
      // actually used for the glyphs that were drawn.
      const match = /(\d+(?:\.\d+)?)px/.exec(value);
      ctx.usedFontSize = match ? parseFloat(match[1]) : 0;
      ctx.usedFont = value;
    },
    get font() { return this._font; },
    measureText(text) {
      return { width: text.length * (ctx.usedFontSize || 10) * CHARS_PER_EM };
    },
    getImageData() {
      return { data: ensure(), width: canvas.width, height: canvas.height };
    },
    _adopt(tone) {
      effective = tone;
      pixels = null;
    }
  };

  canvas.getContext = function () { return ctx; };
  canvas._effective = effective;
  canvas._ctx = ctx;
  return canvas;
}

const vmCtx = {
  console: console,
  document: {
    createElement: function (tag) {
      if (tag !== "canvas") throw new Error("testte sadece canvas kullanilir");
      return makeCanvas(1, 1);
    }
  }
};

vm.createContext(vmCtx);
vm.runInContext(fs.readFileSync(path.join(RES, "overlay.js"), "utf8"), vmCtx);
const Overlay = vmCtx.MangaTROverlay;

const opsOf = (canvas, name) => canvas.ops.filter(function (op) { return op[0] === name; });
const textsDrawn = (canvas, kind) =>
  opsOf(canvas, kind).map(function (op) { return op[1]; });

// ------------------------------------------------------------- clustering

const line = (x, y, w, h, text) => ({ x, y, width: w, height: h, text });

const dialogue = Overlay.clusterBoxes([
  line(100, 100, 60, 24, "¿Qué"),
  line(165, 100, 60, 24, "haces?"),
  line(400, 100, 60, 24, "Solo")
]);

check("iki kutu tek bloğa birleşti", dialogue.length === 2, "blok=" + dialogue.length);
check("birleşen metin boşluksuz", dialogue[0].text === "¿Quéhaces?", dialogue[0].text);
check("ayrı kutu ayrı kaldı", dialogue[1].text === "Solo", dialogue[1].text);
check(
  "satır yüksekliği blok yüksekliğinden küçük",
  dialogue[0].lineHeight > 0 && dialogue[0].lineHeight < dialogue[0].height,
  "lineHeight=" + dialogue[0].lineHeight + " height=" + dialogue[0].height
);

const medians = Overlay.clusterBoxes([line(0, 0, 50, 20, "a"), line(60, 0, 50, 22, "b")]);
check(
  "farklı harf yüksekliklerinden medyana alınıyor",
  medians[0].lineHeight >= 20 && medians[0].lineHeight <= 22,
  "lineHeight=" + medians[0].lineHeight
);

check("nokta gürültüsü elendi", Overlay.clusterBoxes([line(10, 10, 4, 3, ".")]).length === 0);
check("tek kelime blok olur", Overlay.clusterBoxes([line(10, 10, 60, 24, "Hayır")]).length === 1);
check("boş liste blok üretmez", Overlay.clusterBoxes([]).length === 0);

/* Boxes far enough apart not to merge, close enough that their padding
 * collides: the overlap resolver has to trim one instead of dropping it. */
const touching = Overlay.clusterBoxes([
  line(100, 100, 200, 60, "büyük balon"),
  line(340, 100, 200, 60, "küçük balon")
]);
check("çakışan bloklar ikisini de korudu", touching.length === 2, "blok=" + touching.length);
if (touching.length === 2) {
  const a = touching[0];
  const b = touching[1];
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  check("çakışma kırpıldı", ox <= 0 || oy <= 0, "overlap=" + ox.toFixed(1) + "x" + oy.toFixed(1));
  check("kırpılan blokta metin kaldı", touching.every(function (blk) { return blk.text.length > 0; }));
}

// Well-separated boxes must be left completely alone.
const apart = Overlay.clusterBoxes([line(50, 50, 100, 40, "bir"), line(400, 50, 100, 40, "iki")]);
check("uzak bloklar değişmedi", apart.length === 2 &&
  apart[0].width < 200 && apart[1].width < 200,
  JSON.stringify(apart.map(function (b) { return Math.round(b.width); })));

// ------------------------------------------------------------- typesetting

function renderOnce(options) {
  const opts = options || {};
  const page = makeCanvas(400, 400, opts.page);
  const sampler = Overlay.createSampler(page, 400, 400);
  const blocks = opts.blocks || [
    { id: 0, x: 0, y: 0, width: 300, height: 80, vertical: false, lineHeight: 20, text: "x" }
  ];
  const canvas = makeCanvas(400, 400, opts.page);

  // `texts` maps block id to translation, so a test can leave some blocks
  // untranslated the way a failed page would.
  let translations;
  if (opts.texts) {
    translations = opts.texts;
  } else {
    translations = {};
    blocks.forEach(function (block) { translations[block.id] = opts.text || "kısa"; });
  }

  const drawn = Overlay.render(canvas, sampler, blocks, translations, {
    fontScale: opts.fontScale == null ? 1 : opts.fontScale,
    fontFamily: opts.fontFamily || "auto"
  });
  return { canvas: canvas, drawn: drawn, sampler: sampler };
}

const auto = renderOnce({ text: "Merhaba dünya" });
check("otomatik yazı tipiyle metin çizildi", auto.drawn === 1 && textsDrawn(auto.canvas, "fillText").length > 0);

const smallLine = renderOnce({ text: "kısa", blocks: [
  { id: 0, x: 0, y: 0, width: 300, height: 80, vertical: false, lineHeight: 12, text: "x" }
]}).canvas._ctx.usedFontSize;

const largeLine = renderOnce({ text: "kısa", blocks: [
  { id: 0, x: 0, y: 0, width: 300, height: 80, vertical: false, lineHeight: 44, text: "x" }
]}).canvas._ctx.usedFontSize;

check("küçük harf küçük yazı", smallLine > 0 && smallLine < 30, "px=" + smallLine);
check("büyük harf büyük yazı", largeLine > smallLine, "px=" + largeLine + " vs " + smallLine);
check(
  "yazı ölçeği uygulanıyor",
  renderOnce({ text: "kısa", fontScale: 1.4 }).canvas._ctx.usedFontSize > smallLine,
  "px=" + renderOnce({ text: "kısa", fontScale: 1.4 }).canvas._ctx.usedFontSize
);
check(
  "yazı tipi ailesi değişiyor",
  /Rounded/.test(renderOnce({ text: "kısa", fontFamily: "rounded" }).canvas._ctx.usedFont) &&
    !/Rounded/.test(renderOnce({ text: "kısa", fontFamily: "clean" }).canvas._ctx.usedFont),
  renderOnce({ text: "kısa", fontFamily: "rounded" }).canvas._ctx.usedFont
);

// A balloon with room for only a few characters must wrap, not overflow.
const wrapped = renderOnce({ text: "bir iki üç dört beş altı yedi sekiz", blocks: [
  { id: 0, x: 0, y: 0, width: 120, height: 80, vertical: false, lineHeight: 14, text: "x" }
]});
check("uzun metin satırlara bölündü", textsDrawn(wrapped.canvas, "fillText").length > 1,
  "satır=" + textsDrawn(wrapped.canvas, "fillText").length);

// ---------------------------------------------------------------- rendering

const blocks = [
  { id: 0, x: 20, y: 20, width: 150, height: 70, vertical: false, lineHeight: 24, text: "orig" },
  { id: 1, x: 200, y: 20, width: 150, height: 70, vertical: false, lineHeight: 24, text: "orig" }
];

const both = renderOnce({ blocks: blocks, text: "bir", page: { grey: 200 } });
check("iki blok da çizildi", both.drawn === 2, "d=" + both.drawn);

// The page is flat, so MangaTR copies a flat donor patch rather than filling.
// Either is a legitimate erase; what matters is that every block got one.
const eraseOps = opsOf(both.canvas, "fill").length + opsOf(both.canvas, "drawImage").length;
check("her blok temizlendi", eraseOps === 2, "temizleme=" + eraseOps);

const clear = opsOf(both.canvas, "clearRect")[0];
check(
  "temizleme dönüşümden bağımsız",
  clear && clear[1] === 0 && clear[2] === 0 && clear[3] === 400 && clear[4] === 400,
  JSON.stringify(clear)
);

// A busy page has no clean donor nearby, so the flat-fill path runs, and that is
// where the bleed past the OCR box is visible.
const busy = renderOnce({ blocks: [blocks[0]], text: "y", page: { noise: true } });
const moveTo = opsOf(busy.canvas, "moveTo")[0];
check("dolu sayfada düz boyama yapıldı", opsOf(busy.canvas, "fill").length === 1,
  "fill=" + opsOf(busy.canvas, "fill").length);
check("silme kutusu OCR kutusundan geniş", moveTo !== undefined && moveTo[1] > 20,
  "moveTo x=" + (moveTo ? moveTo[1] : null));

// Only translated blocks may be touched: erasing an untranslated balloon would
// leave the page blank where text used to be.
const partialDraw = renderOnce({
  blocks: blocks,
  texts: { 0: "sadece birinci" },
  page: { noise: true }
});
check("yalnız çevrilmiş blok çizildi", partialDraw.drawn === 1, "d=" + partialDraw.drawn);
check("çevrilmemiş metin hiç çizilmedi",
  textsDrawn(partialDraw.canvas, "fillText").join(" ").indexOf("kısa") === -1 &&
    opsOf(partialDraw.canvas, "fill").length === 1,
  "fill=" + opsOf(partialDraw.canvas, "fill").length);

// No translations at all must be a complete no-op: erasing the page with
// nothing in its place is the worst possible outcome.
const none = renderOnce({ blocks: blocks, texts: {}, page: { noise: true } });
check("çeviri yoksa hiçbir şey çizilmedi",
  none.drawn === 0 &&
    opsOf(none.canvas, "fill").length === 0 &&
    opsOf(none.canvas, "drawImage").length === 0 &&
    opsOf(none.canvas, "fillText").length === 0);

// Ink has to stay readable over mid-tone screentone, which is where an outline
// earns its keep.
const midTone = renderOnce({ blocks: [blocks[0]], text: "okunaklı", page: { grey: 128 } });
check("orta tonlu zeminde kontur çizildi",
  opsOf(midTone.canvas, "strokeText").length === opsOf(midTone.canvas, "fillText").length &&
    opsOf(midTone.canvas, "strokeText").length > 0,
  "stroke=" + opsOf(midTone.canvas, "strokeText").length);

const lightTone = renderOnce({ blocks: [blocks[0]], text: "okunaklı", page: { grey: 245 } });
check("açık zeminde gereksiz kontur yok", opsOf(lightTone.canvas, "strokeText").length === 0,
  "stroke=" + opsOf(lightTone.canvas, "strokeText").length);

const darkTone = renderOnce({ blocks: [blocks[0]], text: "okunaklı", page: { grey: 20 } });
check("koyu zeminde beyaz mürekkep seçildi",
  darkTone.canvas._ctx.fillStyle === "rgb(250,250,252)",
  String(darkTone.canvas._ctx.fillStyle));

console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
process.exit(failed ? 1 : 0);