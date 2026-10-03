/* Exercises MangaTRLang without a browser.
 *
 * Two different standards apply here, matching the module's own rules:
 *  - CJK is decided by script, so the exact language must come back.
 *  - Latin script is genuinely ambiguous, so either the right language or
 *    "unknown" is acceptable for a single short bubble. What must never happen
 *    is Turkish being claimed for a non-Turkish page, because that makes the
 *    page skip translation entirely. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(
  path.join(__dirname, "..", "Extension", "Resources", "lang.js"),
  "utf8"
);
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const Lang = ctx.MangaTRLang;

let failed = 0;

function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? "TAMAM " : "HATA  ") + name + (detail ? " — " + detail : ""));
}

// Script-based detection: exact match required.
const SCRIPT_CASES = [
  ["ja", "「どうしたの？」「いい顔して」と彼は言った"],
  ["ja", "うるさい！お前，能不能小声点"],
  ["ko", "너무 늦게 왔네. 왜 그렇게 걸었어?"],
  ["zh", "你终于来了。我等了很久了。"]
];

SCRIPT_CASES.forEach(([expected, text]) => {
  const got = Lang.detect(text);
  check(
    "betik " + expected,
    got.code === expected,
    "gelen=" + got.code + " güven=" + got.confidence.toFixed(2)
  );
});

// Latin detection on text long enough to carry signal: exact match expected.
const LATIN_CASES = [
  ["en", "What are you doing here? I was waiting for you the whole time."],
  ["en", "Don't be late again. We have a lot to discuss with the others."],
  ["es", "No llegues tarde otra vez. Tenemos mucho que hablar."],
  ["es", "¿Qué haces aquí? Te he estado esperando todo este tiempo."],
  ["id", "Apa yang kamu lakukan di sini? Saya sudah menunggu kamu."],
  ["pt", "O que você está fazendo aqui? Eu estava esperando por você."],
  ["fr", "Qu'est-ce que tu fais ici ? Je t'attendais depuis longtemps."]
];

LATIN_CASES.forEach(([expected, text]) => {
  const got = Lang.detect(text);
  check(
    "latin " + expected,
    got.code === expected,
    "gelen=" + got.code + " güven=" + got.confidence.toFixed(2)
  );
});

// A Turkish page must be recognised so it can be left untouched. Two particles
// is the documented minimum, so the text has to contain at least that many.
const turkishCases = [
  "Neden buradasın? Seni çok bekledim, bir daha geç kalma.",
  "Bir daha geç kalma. Konuşacak çok şeyimiz var."
];

turkishCases.forEach((text) => {
  const got = Lang.detect(text);
  check("türkçe koruması", got.isTurkish, "gelen=" + got.code);
});

// One Turkish function word is not enough on its own. The page is still left
// alone, but via the model: it reports the language, and content.js skips on a
// Turkish verdict whenever the local detector came back empty. What must not
// happen is the word list naming some *other* language with confidence.
const weakTurkish = "Bu sayfa zaten Türkçe, dokunulmamalı.";
const weak = Lang.detect(weakTurkish);
check(
  "zayıf türkçe: yanlış dil adı verilmiyor",
  weak.code === "unknown" || weak.code === "tr",
  "gelen=" + weak.code
);

// Non-Turkish Latin text must never be reported as Turkish.
const NOT_TURKISH = [
  "¿Qué haces aquí? Te he estado esperando.",
  "What are you doing here? I was waiting for you.",
  "Non posso crederci! Che cosa hai fatto?",
  "Je ne comprends rien à ce qui se passe ici.",
  "Ik snap er niets van, wat gebeurt hier?"
];

NOT_TURKISH.forEach((text) => {
  const got = Lang.detect(text);
  check("türkçe değil: " + text.slice(0, 24) + "…", !got.isTurkish, "gelen=" + got.code);
});

// Degenerate inputs must not throw and must not claim a language.
check("okunabilir metin yok", Lang.detect("!!! ??? ***").code === "unknown");
check("bos metin", Lang.detect("").code === "unknown");
check("tek harf", Lang.detect("a").code === "unknown");

// The popup's manual override must win over detection, and auto must not lie.
check(
  "elle seçim öncelikli",
  Lang.describe(null, { sourceLanguages: "es" }) === "İspanyolca"
);
check("auto boş döner", Lang.describe(null, { sourceLanguages: "auto" }) === "");
check(
  "auto algılananı kullanır",
  Lang.describe(Lang.detect("너무 늦게 왔네"), { sourceLanguages: "auto" }) === "Korece"
);
check("bilinmeyen etiketlenmez", Lang.describe(null, { sourceLanguages: "auto" }) === "");

console.log(failed ? "\n" + failed + " HATA" : "\nTUM TESTLER GECTI");
process.exit(failed ? 1 : 0);