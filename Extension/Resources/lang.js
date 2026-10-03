/* Which language is this page written in?
 *
 * The point is not linguistics, it is deciding two things cheaply and offline:
 *  - whether to touch the page at all (a page already in Turkish must be left
 *    alone, otherwise MangaTR would white-out Turkish text and hand Gemini the
 *    same words back)
 *  - what to tell Gemini the source language is.
 *
 * Scripts are decisive on their own: hangul is Korean, kana is Japanese, han
 * without kana is Chinese. Latin script is genuinely ambiguous, so that case
 * falls back to scoring very common function words. */
var MangaTRLang = (function () {
  "use strict";

  var LABELS = {
    ja: "Japonca",
    ko: "Korece",
    zh: "Çince",
    en: "İngilizce",
    es: "İspanyolca",
    pt: "Portekizce",
    tr: "Türkçe",
    id: "Endonezce",
    fr: "Fransızca",
    de: "Almanca",
    it: "İtalyanca",
    nl: "Felemenkçe",
    ru: "Rusça"
  };

  // Ordered by how many function words a typical dialogue bubble contains.
  // The longest lists win ties because short bubbles are the common case.
  var STOP = {
    tr: "bir ve bu için ile değil olan çok ama olarak daha gibi kadar sonra her ancak ne mi en olarak üzere göre yani",
    en: "the and you that have with this from they will have been were what about your there when which their would could",
    es: "el la los las de que y en un una por con para no se su más pero como sus le lo ya este esta",
    id: "yang dan di ke untuk dengan ini itu tidak akan pada adalah dari jika saya kami kita sudah atau bisa",
    pt: "de que os as um uma para com não em por mais do da dos das se como você nós ele",
    fr: "le la les de des et un une pour avec pas que qui dans plus ce sont elle nous vous sur",
    de: "der die das und ist nicht ein eine mit für auf von zu im den sich des auch als aber",
    it: "il lo la gli di che e un una per con non sono del della dei più ma come quando",
    nl: "de het een van en is dat op te niet met voor zijn aan er maar dan ook zich"
  };

  var WORD_LISTS = {};
  Object.keys(STOP).forEach(function (code) {
    WORD_LISTS[code] = STOP[code].split(" ");
  });

  function inRange(code, low, high) {
    return code >= low && code <= high;
  }

  /* -> { kana, hangul, han, latin, cyrillic, letters } */
  function census(text) {
    var out = { kana: 0, hangul: 0, han: 0, latin: 0, cyrillic: 0, letters: 0 };
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      var letter = false;

      if (inRange(code, 0x3041, 0x309f) || inRange(code, 0x30a0, 0x30ff) || inRange(code, 0xff66, 0xff9d)) {
        out.kana++;
        letter = true;
      } else if (inRange(code, 0xac00, 0xd7af) || inRange(code, 0x1100, 0x11ff) || inRange(code, 0x3130, 0x318f)) {
        out.hangul++;
        letter = true;
      } else if (inRange(code, 0x4e00, 0x9fff) || inRange(code, 0x3400, 0x4dbf) || inRange(code, 0xf900, 0xfaff)) {
        out.han++;
        letter = true;
      } else if (
        inRange(code, 0x41, 0x5a) ||
        inRange(code, 0x61, 0x7a) ||
        inRange(code, 0xc0, 0x24f) ||
        inRange(code, 0x1e00, 0x1eff)
      ) {
        out.latin++;
        letter = true;
      } else if (inRange(code, 0x400, 0x4ff)) {
        out.cyrillic++;
        letter = true;
      }

      if (letter) out.letters++;
    }
    return out;
  }

  /* Accents are stripped before matching: OCR is inconsistent about them and
   * "qué" must still count as "que". */
  function fold(word) {
    return word.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function scoreLatin(words) {
    var tally = {};
    for (var w = 0; w < words.length; w++) {
      var word = fold(words[w]);
      if (word.length < 2) continue;
      tally[word] = (tally[word] || 0) + 1;
    }

    var ranked = [];
    Object.keys(WORD_LISTS).forEach(function (code) {
      var list = WORD_LISTS[code];
      var score = 0;
      var distinct = 0;
      for (var i = 0; i < list.length; i++) {
        var hits = tally[fold(list[i])] || 0;
        if (hits) {
          score += hits;
          distinct++;
        }
      }
      // Two *different* function words beat one word repeated three times: a
      // character shouting "no" is not evidence of a language.
      ranked.push({ code: code, score: score, distinct: distinct });
    });

    ranked.sort(function (a, b) {
      if (b.distinct !== a.distinct) return b.distinct - a.distinct;
      return b.score - a.score;
    });

    return ranked[0] || { code: null, score: 0, distinct: 0 };
  }

  /* -> { code, label, script, confidence, isTurkish } */
  function detect(text) {
    if (!text) return { code: "unknown", label: "Bilinmiyor", script: "none", confidence: 0, isTurkish: false };

    var flat = text.toLowerCase().replace(/[^\p{L}\s']/gu, " ");
    var counts = census(flat);
    if (!counts.letters) {
      return { code: "unknown", label: "Metin yok", script: "none", confidence: 0, isTurkish: false };
    }

    var share = function (n) {
      return n / counts.letters;
    };

    // Kana settles Japanese against Chinese even when han dominates, because
    // every Japanese bubble mixes kana into its kanji.
    if (share(counts.kana) > 0.01) {
      return finish("ja", "kana", share(counts.kana));
    }
    if (share(counts.hangul) > 0.15) {
      return finish("ko", "hangul", share(counts.hangul));
    }
    if (share(counts.han) > 0.2) {
      return finish("zh", "han", share(counts.han));
    }
    if (share(counts.cyrillic) > 0.4) {
      return finish("ru", "cyrillic", share(counts.cyrillic));
    }
    if (share(counts.latin) > 0.5) {
      var scored = scoreLatin(flat.split(/\s+/));

      /* Turkish is held to a higher bar than everything else on purpose: a
       * wrong Turkish verdict makes MangaTR leave an untranslated page alone,
       * which is the one failure the user cannot work around. Any other wrong
       * verdict just means an empty hint in the prompt, and the model names the
       * language itself. */
      var enough = scored.code === "tr"
        ? scored.score >= 2
        : scored.distinct >= 1 && scored.score >= 1;

      if (scored.code && enough) {
        var total = Math.min(1, scored.score / Math.max(6, counts.letters / 40));
        return finish(scored.code, "latin", total);
      }
      return { code: "unknown", label: "Latin (belirsiz)", script: "latin", confidence: 0, isTurkish: false };
    }

    return { code: "unknown", label: "Bilinmiyor", script: "none", confidence: 0, isTurkish: false };
  }

  function finish(code, script, confidence) {
    return {
      code: code,
      label: LABELS[code] || code,
      script: script,
      confidence: Math.max(0, Math.min(1, confidence)),
      isTurkish: code === "tr"
    };
  }

  /* Gemini reads this, so keep it to what actually helps the model: the source
   * language and whether the dialogue is vertical. */
  function describe(detected, settings) {
    if (settings.sourceLanguages && settings.sourceLanguages !== "auto") {
      return LABELS[settings.sourceLanguages] || settings.sourceLanguages;
    }
    if (!detected || detected.code === "unknown") return "";
    return detected.label;
  }

  return {
    LABELS: LABELS,
    detect: detect,
    describe: describe
  };
})();