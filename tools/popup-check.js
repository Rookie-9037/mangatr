/* Guards on the popup that are cheap to check and expensive to miss.
 *
 * The `hidden` one is here because it was a real shipped bug: .field set
 * `display: block`, which outranks the UA stylesheet's `[hidden] { display: none
 * }`, so choosing DeepSeek still showed the custom-server fields and made it look
 * like they were required.
 */
const fs = require("fs");
const path = require("path");

const RES = path.join(__dirname, "..", "Extension", "Resources");
const read = (name) => fs.readFileSync(path.join(RES, name), "utf8");

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "TAMAM " : "HATA  ") + name + (detail ? " — " + detail : ""));
}

const css = read("popup.css");
const html = read("popup.html");
const js = read("popup.js");

// ------------------------------------------------------------------- hidden

/* Strip comments so a commented-out rule cannot satisfy the check. */
const liveCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

const hiddenRules = [];
const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
let match;
while ((match = rulePattern.exec(liveCss)) !== null) {
  if (/(^|,)\s*\[hidden\]\s*(,|$)/.test(match[1])) {
    hiddenRules.push(match[2].trim());
  }
}

check(
  "[hidden] kuralı var",
  hiddenRules.length > 0,
  hiddenRules.length + " kural"
);
check(
  "[hidden] display:none uyguluyor",
  hiddenRules.some((body) => /display\s*:\s*none\s*!important/.test(body)),
  hiddenRules.join(" | ")
);

// Any author rule that sets display on a class used by a hidden element would
// need !important to lose; this only reports, the check above is the guarantee.
const hiddenIds = (html.match(/id="([^"]+)"[^>]*\shidden/g) || []).map((chunk) => /id="([^"]+)"/.exec(chunk)[1]);
check(
  "gizli alan tanımlı",
  hiddenIds.length > 0,
  hiddenIds.join(", ")
);

// The two custom-server fields are the ones that must start hidden: a provider
// with its own address is the only case that needs them.
check("özel alanlar gizli başlıyor",
  hiddenIds.indexOf("customBaseField") !== -1 && hiddenIds.indexOf("customModelField") !== -1,
  hiddenIds.join(", "));

// ------------------------------------------------------------------ wiring

/* popup.js resolves every control through getElementById. A typo there fails
 * silently on iOS, where the only symptom is a control that does nothing. */
const referenced = new Set();
const idPattern = /getElementById\("([^"]+)"\)/g;
while ((match = idPattern.exec(js)) !== null) referenced.add(match[1]);

const missing = [...referenced].filter((id) => !new RegExp('id="' + id + '"').test(html));
check("popup.js'teki tüm id'ler HTML'de var", missing.length === 0, missing.join(", "));

// --------------------------------------------------- provider wiring in js

/* The popup asks the background page for the list rather than loading
 * providers.js itself, so this checks the message, not a global. */
check("servis listesi arka plandan isteniyor", /type:\s*"providers:list"/.test(js));
check(
  "özel alanlar yalnız custom'da açılıyor",
  /customBaseField\.hidden\s*=\s*!custom/.test(js) && /customModelField\.hidden\s*=\s*!custom/.test(js)
);
check(
  "model listesi özel sunucuda gizleniyor",
  /provider\.id === "custom"[\s\S]{0,120}modelField\.hidden = true/.test(js)
);

// -------------------------------------------------------------- copy hygiene

/* The popup is the only surface the user reads before pasting a key; stale
 * single-provider wording there is what made the custom fields look mandatory. */
check("popup Gemini'ye özel değil", !/Gemini API anahtarı/.test(html));
check("popup provider'ı listeliyor", /id="provider"/.test(html));
check("kaydet düğmesi var", /id="saveKey"/.test(html));
check("test düğmesi var", /id="testKey"/.test(html));

// The "Test et" button: what it asks the background page and what it reads back.
// The reply shape it depends on is pinned down in connection-check.js.
check("sınama isteği gönderiliyor", /type:\s*"settings:test"/.test(js));
check("sınama sonucu okunuyor", /reply\.result\.model/.test(js));
check("sınama hatası gösteriliyor", /reply && reply\.error/.test(js));

// ------------------------------------------------------------------ OCR yolu

/* With Vision unreachable on a free signing profile the popup must name the
 * fallback rather than tell the user to reopen an app that cannot help. Two
 * distinct messages: a vision provider still works (slowly), a non-vision one
 * means no OCR at all until the service changes. */
check("eski çıkmaz mesaj kalktı", !/uygulamayı bir kez aç/.test(js));
check("görsel yedeğin yavaşlığı söyleniyor", /yavaş, görsel servise gider/.test(js));
check("görsel okumayan servis uyarılıyor", /görsel okuyamaz — Google Gemini seç/.test(js));
check("yedek yol servis adını kullanıyor", /provider\.label/.test(js));
check("açılışta OCR durumu hesaplanıyor", /refreshOcrStatus\(settings\)/.test(js));
check("servis değişince OCR durumu tazeleniyor", /refreshOcrStatus\(next \|\| settings\)/.test(js));
check("aç/kapa düğmesi OCR durumunu ezmiyor", /refreshOcrStatus\(\{ provider: els\.provider\.value/.test(js));
/* The decision reads the provider list that background.js already hands the
 * popup, so it must not silently fall back to whatever is first in the array. */
check("sağlayıcı kimliğine göre seçiliyor", /byId\[\(settings && settings\.provider\)/.test(js));

// ------------------------------------------------------- elle sayfa tetiği

/* Some readers never let the page image become visible to the observer, and the
 * only way to find out which kind of site you are on is to try the manual
 * trigger -- so it has to exist, be wired, and report failures. */
check("bu sayfayı çevir düğmesi var", /id="runNow"/.test(html));
check("düğme JS'e bağlı", /runNow: document\.getElementById\("runNow"\)/.test(js));
check("düğme ocr:run gönderiyor", /type: "ocr:run"/.test(js));
check("düğme kuyruk sonucunu gösteriyor", /kuyruğa alındı/.test(js));
check("düğme hatayı yüzeye çıkarıyor", /els\.runNow[\s\S]{0,400}is-warn/.test(js));
check("düğme kendini kilitlemiyor", /els\.runNow\.disabled = false/.test(js));

// ------------------------------------------------------------ hata görünürlüğü

/* "3 sayfa kuyruğa alındı" followed by nothing was the worst failure mode in
   this extension: the error pill auto-hid after ten seconds and pump()'s empty
   catch swallowed the reason, so a broken run looked exactly like a page with
   no text. The reason has to survive the popup being closed and reopened. */
const content = fs.readFileSync(
  path.join(__dirname, "..", "Extension", "Resources", "content.js"), "utf8");
check("hata ekranda kalıcı yazıyor", /function reportFailure/.test(content) && /reportFailure\(error\)/.test(content));
check("hata konsola da yazılıyor", /console\.error\("\[MangaTR\]"/.test(content));
check("hata kaydediliyor", /mangatrLastError/.test(content));
check("başarı hatayı temizliyor", /reportSuccess/.test(content) && /mangatrLastError"\)/.test(content));
check("sessiz catch kalmadı", !/process\(next\)\s*\n?\s*\.catch\(function \(\) \{\}\)/.test(content));
check("son hata alanı var", /id="lastError"/.test(html));
check("popup son hatayı gösteriyor", /showLastFailure/.test(js) && /Son deneme başarısız/.test(js));

console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
process.exit(failed ? 1 : 0);