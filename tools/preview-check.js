/* Loads the preview page's script graph in order, the way a browser would, and
 * fails if a global is missing. preview.js only binds listeners on load, so a
 * stubbed DOM is enough to prove the wiring holds together.
 *
 * This is a guard against the exact regression it was written for: translator.js
 * grew a dependency on MangaTRProviders, and the preview loaded translator.js
 * without it, so every run died on a ReferenceError nobody noticed because the
 * preview is a manual tool.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TOOLS = __dirname;
const RES = path.join(TOOLS, "..", "Extension", "Resources");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "TAMAM " : "HATA  ") + name + (detail ? " — " + detail : ""));
}

// Minimal document: preview.js resolves every control through getElementById
// and then attaches listeners to them.
const IDS = ["file", "provider", "key", "model", "scale", "run", "reset", "log", "page", "img", "canvas", "empty"];

function makeElement(id) {
  const listeners = {};
  return {
    id: id,
    value: "",
    innerHTML: "",
    textContent: "",
    files: [],
    hidden: false,
    disabled: false,
    style: {},
    appendChild(child) { (this.children || (this.children = [])).push(child); },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener() {},
    getContext() {
      return {
        setTransform() {}, clearRect() {}, drawImage() {}, beginPath() {},
        closePath() {}, moveTo() {}, arcTo() {}, fill() {}, fillText() {},
        strokeText() {}, save() {}, restore() {}
      };
    }
  };
}

const nodes = {};
IDS.forEach((id) => { nodes[id] = makeElement(id); });

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  Tesseract: { createWorker: () => Promise.resolve({ recognize: () => Promise.resolve({}) }) },
  document: {
    getElementById: (id) => nodes[id] || null,
    createElement: () => makeElement("made")
  }
};

// vm is required rather than indirect eval: these files declare their exports as
// top-level `var`, which only becomes a property of this object if it is the
// context's global.
vm.createContext(sandbox);

function load(file, label) {
  try {
    vm.runInContext(read(file), sandbox, { filename: path.basename(file) });
    check(label + " yüklendi", true);
    return true;
  } catch (error) {
    check(label + " yüklendi", false, String(error && error.message ? error.message : error));
    return false;
  }
}

load(path.join(TOOLS, "preview-shim.js"), "önizleme shim");
load(path.join(RES, "providers.js"), "providers.js");
load(path.join(RES, "overlay.js"), "overlay.js");
load(path.join(RES, "translator.js"), "translator.js");
load(path.join(TOOLS, "preview.js"), "preview.js");

check("MangaTRProviders tanımlı", typeof sandbox.MangaTRProviders === "object");
check("MangaTROverlay tanımlı", typeof sandbox.MangaTROverlay === "object");
check("MangaTRTranslate tanımlı", typeof sandbox.MangaTRTranslate === "object");

check("servis listesi boş değil", sandbox.MangaTRProviders.list().length > 0);

if (sandbox.MangaTRProviders && sandbox.MangaTRTranslate) {
  // The dependency the preview exists to exercise: a provider call resolves.
  const providers = sandbox.MangaTRProviders.list();
  const deepseek = sandbox.MangaTRProviders.get("deepseek");
  const req = deepseek.request("çevir", deepseek.defaultModel, "sk-x", {});
  check(
    "önizlemede istek URL'si doğru",
    req.url.indexOf("api.deepseek.com") !== -1,
    req.url
  );
  check("sağlayıcı listesi çözüldü", providers.some((p) => p.id === "gemini"));

  // And the translator must accept the preview's settings shape.
  const resolved = sandbox.MangaTRTranslate.resolveSettings({
    provider: "groq",
    apiKeys: { groq: "gsk-x" },
    model: "llama-3.3-70b-versatile"
  });
  check("önizleme ayarı çözüldü", resolved.key === "gsk-x" && resolved.provider.id === "groq", resolved.provider.id);
}

if (sandbox.MangaTRProviders) {
  // preview.js must have populated the provider <select> and the model list.
  check("servis seçimi dolduruldu", (nodes.provider.children || []).length === sandbox.MangaTRProviders.list().length,
    String((nodes.provider.children || []).length));
  check("model listesi dolduruldu", (nodes.model.children || []).length > 0);
  check("anahtar ipucu geldi", nodes.key.placeholder !== "", nodes.key.placeholder);
}

console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
process.exit(failed ? 1 : 0);