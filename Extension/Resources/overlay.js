/* The part that makes the page still read like a manga page: cover the
 * original lettering and typeset the Turkish translation into the same space.
 *
 * Manga balloons are two very different problems:
 *  - dialogue over plain artwork, where the balloon must be redrawn;
 *  - lettering on a screentone or textured panel, where a flat fill would
 *    leave an obvious grey box, so we copy a clean patch of nearby texture.
 *
 * Coordinates everywhere are in the image's own pixel space; the overlay canvas
 * is sized to the natural resolution and scaled down by CSS. */
var MangaTROverlay = (function () {
  "use strict";

  /* Font choice is a compromise: a hand-lettered manga face has no Turkish
 * counterpart, so the goal is metrics and colour that sit naturally in the
 * balloon rather than a literal match. iOS ships these, and the stack falls
 * through to the system face if one is missing. */
var FONT_STACKS = {
  auto: '-apple-system, "SF Pro Rounded", "SF Pro Text", "Avenir Next", "Hiragino Sans", sans-serif',
  rounded: '"SF Pro Rounded", "Arial Rounded MT Bold", "Chalkboard SE", "Avenir Next", -apple-system, sans-serif',
  clean: '-apple-system, "SF Pro Text", "Helvetica Neue", "Hiragino Sans", sans-serif'
};

function fontStack(settings) {
  return FONT_STACKS[(settings && settings.fontFamily) || "auto"] || FONT_STACKS.auto;
}

  var ANALYSIS_MAX_EDGE = 1000;

  // ---------------------------------------------------------------- helpers

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function luma(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /* A run of boxes wider than it is tall is tategaki, i.e. one vertical line
   * of Japanese; a taller-than-wide cluster is a narration box. */
  function isVertical(block) {
    return block.height > block.width * 1.35;
  }

  // --------------------------------------------------------------- analysis

  /* One downscaled copy of the page, read once, used for every colour and
   * texture decision. Sampling the full-resolution page instead would cost
   * tens of megabytes and visibly stall scrolling.
   *
   * `source` is either the analysis canvas built from the bytes we shipped to
   * Vision, or the <img> itself as a fallback. It must be same-origin or the
   * canvas reads come back tainted and every sample degrades. */
  function createSampler(source, naturalWidth, naturalHeight) {
    var sourceWidth = source.naturalWidth || source.width || 1;
    var sourceHeight = source.naturalHeight || source.height || 1;
    var scale = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    var width = Math.max(1, Math.round(sourceWidth * scale));
    var height = Math.max(1, Math.round(sourceHeight * scale));

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);

    var data;
    try {
      data = ctx.getImageData(0, 0, width, height).data;
    } catch (error) {
      data = null;
    }

    var ratioX = width / naturalWidth;
    var ratioY = height / naturalHeight;

    function pixel(x, y) {
      var px = clamp(Math.round(x), 0, width - 1);
      var py = clamp(Math.round(y), 0, height - 1);
      var offset = (py * width + px) * 4;
      return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    }

    function meanLuma(box) {
      if (!data) return 255;
      var x0 = clamp(Math.round(box.x * ratioX), 0, width - 1);
      var y0 = clamp(Math.round(box.y * ratioY), 0, height - 1);
      var x1 = clamp(Math.round((box.x + box.width) * ratioX), x0 + 1, width);
      var y1 = clamp(Math.round((box.y + box.height) * ratioY), y0 + 1, height);
      var total = 0;
      var count = 0;
      // Stride the region: a full scan of a balloon is pure waste.
      var stepX = Math.max(1, Math.floor((x1 - x0) / 24));
      var stepY = Math.max(1, Math.floor((y1 - y0) / 24));
      for (var y = y0; y < y1; y += stepY) {
        for (var x = x0; x < x1; x += stepX) {
          var offset = (y * width + x) * 4;
          total += luma(data[offset], data[offset + 1], data[offset + 2]);
          count++;
        }
      }
      return count ? total / count : 255;
    }

    /* Most common colour, i.e. the flat fill of a balloon or the base tone of
     * a screentone, ignoring the lettering on top of it. */
    function modeColor(box) {
      if (!data) return { r: 255, g: 255, b: 255 };
      var x0 = clamp(Math.round(box.x * ratioX), 0, width - 1);
      var y0 = clamp(Math.round(box.y * ratioY), 0, height - 1);
      var x1 = clamp(Math.round((box.x + box.width) * ratioX), x0 + 1, width);
      var y1 = clamp(Math.round((box.y + box.height) * ratioY), y0 + 1, height);
      var buckets = {};
      var bestKey = null;
      var bestCount = 0;
      var stepX = Math.max(1, Math.floor((x1 - x0) / 32));
      var stepY = Math.max(1, Math.floor((y1 - y0) / 32));
      for (var y = y0; y < y1; y += stepY) {
        for (var x = x0; x < x1; x += stepX) {
          var offset = (y * width + x) * 4;
          var key =
            (data[offset] >> 4) * 256 + (data[offset + 1] >> 4) * 16 + (data[offset + 2] >> 4);
          var entry = buckets[key];
          if (entry) {
            entry.count++;
            entry.r += data[offset];
            entry.g += data[offset + 1];
            entry.b += data[offset + 2];
          } else {
            buckets[key] = { count: 1, r: data[offset], g: data[offset + 1], b: data[offset + 2] };
          }
          if (entry && entry.count > bestCount) {
            bestCount = entry.count;
            bestKey = key;
          }
        }
      }
      if (bestKey === null) {
        for (var candidate in buckets) {
          if (buckets[candidate].count > bestCount) {
            bestCount = buckets[candidate].count;
            bestKey = candidate;
          }
        }
      }
      if (bestKey === null) return { r: 255, g: 255, b: 255 };
      var winner = buckets[bestKey];
      return {
        r: Math.round(winner.r / winner.count),
        g: Math.round(winner.g / winner.count),
        b: Math.round(winner.b / winner.count)
      };
    }

    /* Sum of horizontal+vertical luminance steps. High inside lettering, low in
     * clean artwork, which is what makes a donor patch recognisable. */
    function edgeEnergy(box) {
      if (!data) return 0;
      var x0 = clamp(Math.round(box.x * ratioX), 0, width - 1);
      var y0 = clamp(Math.round(box.y * ratioY), 0, height - 1);
      var x1 = clamp(Math.round((box.x + box.width) * ratioX), x0 + 2, width);
      var y1 = clamp(Math.round((box.y + box.height) * ratioY), y0 + 2, height);
      var energy = 0;
      var stepX = Math.max(1, Math.floor((x1 - x0) / 28));
      var stepY = Math.max(1, Math.floor((y1 - y0) / 28));
      for (var y = y0; y < y1; y += stepY) {
        for (var x = x0; x < x1 - 1; x += stepX) {
          var offset = (y * width + x) * 4;
          var right = offset + 4;
          if (right + 2 >= data.length) continue;
          var here = luma(data[offset], data[offset + 1], data[offset + 2]);
          var neighbour = luma(data[right], data[right + 1], data[right + 2]);
          if (Math.abs(here - neighbour) > 42) energy++;
        }
      }
      return energy;
    }

    return {
      canvas: canvas,
      pixel: pixel,
      meanLuma: meanLuma,
      modeColor: modeColor,
      edgeEnergy: edgeEnergy,
      ratioX: ratioX,
      ratioY: ratioY,
      naturalWidth: naturalWidth,
      naturalHeight: naturalHeight
    };
  }

  /* Looks for a text-free patch of roughly the right size and brightness near
   * the block, so screentone and hatching survive the erase. */
  function findDonor(sampler, block) {
    var gap = Math.max(6, block.height * 0.35);
    var target = sampler.edgeEnergy(block);
    var reference = sampler.meanLuma(block);
    var candidates = [
      { x: block.x + block.width + gap, y: block.y },
      { x: block.x - block.width - gap, y: block.y },
      { x: block.x + 2 * (block.width + gap), y: block.y },
      { x: block.x - 2 * (block.width + gap), y: block.y },
      { x: block.x, y: block.y - block.height - gap },
      { x: block.x, y: block.y + block.height + gap },
      { x: block.x, y: block.y - 2 * (block.height + gap) },
      { x: block.x, y: block.y + 2 * (block.height + gap) }
    ];

    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (
        candidate.x < 0 ||
        candidate.y < 0 ||
        candidate.x + block.width > sampler.naturalWidth ||
        candidate.y + block.height > sampler.naturalHeight
      ) {
        continue;
      }

      var probe = {
        x: candidate.x,
        y: candidate.y,
        width: block.width,
        height: block.height
      };
      var energy = sampler.edgeEnergy(probe);
      var delta = Math.abs(sampler.meanLuma(probe) - reference);
      // A donor must be quieter than the lettering we are covering, close in
      // brightness, and a similar size.
      var score = energy * 1.6 + delta * 2.2;
      if (!best || score < best.score) best = { score: score, probe: probe };
    }

    if (!best) return null;
    // On flat artwork a mediocre donor beats a flat colour; on busy line art a
    // wrong donor is more visible than a flat fill, so demand a good match.
    if (target === 0 && best.score < 40) return best.probe;
    if (best.score < 120) return best.probe;
    return null;
  }

  // ------------------------------------------------------------- clustering

  /* Vision returns one box per text run. Dialogue balloons hold several runs
   * side by side, so runs that sit close together are merged into a single
   * block: better translation context and room to typeset a paragraph. */
  function clusterBoxes(boxes) {
    if (!boxes || !boxes.length) return [];

    // Speckle and single stray marks die here, before padding can inflate them
    // into something that looks like a balloon.
    var items = boxes
      .filter(function (box) {
        return box && box.text && box.width >= 10 && box.height >= 10;
      })
      .map(function (box) {
        return { x: box.x, y: box.y, width: box.width, height: box.height, text: box.text };
      });
    if (!items.length) return [];
    var parent = items.map(function (_, index) {
      return index;
    });

    function find(index) {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    }

    function union(a, b) {
      var rootA = find(a);
      var rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    }

    for (var i = 0; i < items.length; i++) {
      for (var j = i + 1; j < items.length; j++) {
        var a = items[i];
        var b = items[j];
        var gap = Math.max(8, Math.min(a.height, b.height) * 0.55);
        var overlapsX = a.x - gap < b.x + b.width && b.x - gap < a.x + a.width;
        var overlapsY = a.y - gap < b.y + b.height && b.y - gap < a.y + a.height;
        if (overlapsX && overlapsY) union(i, j);
      }
    }

    var groups = {};
    items.forEach(function (item, index) {
      var root = find(index);
      if (!groups[root]) groups[root] = [];
      groups[root].push(item);
    });

    var blocks = [];
    Object.keys(groups).forEach(function (root) {
      var members = groups[root];
      var minX = Math.min.apply(null, members.map(function (m) { return m.x; }));
      var minY = Math.min.apply(null, members.map(function (m) { return m.y; }));
      var maxX = Math.max.apply(null, members.map(function (m) { return m.x + m.width; }));
      var maxY = Math.max.apply(null, members.map(function (m) { return m.y + m.height; }));

      // Grow towards the balloon border so the replacement text has air.
      var lineHeight = maxY - minY;
      var padX = Math.min(lineHeight * 0.42, 34);
      var padY = Math.min(lineHeight * 0.3, 22);

      // Typical glyph height of the original lettering, used later to typeset
      // at a comparable size.
      var glyphHeights = members.map(function (m) { return m.height; }).sort(function (a, b) { return a - b; });
      var glyph = glyphHeights[glyphHeights.length >> 1];

      var block = {
        x: Math.max(0, minX - padX),
        y: Math.max(0, minY - padY),
        width: maxX - minX + padX * 2,
        height: maxY - minY + padY * 2,
        vertical: isVertical({ width: maxX - minX, height: maxY - minY }),
        lineHeight: glyph,
        text: ""
      };

      if (block.vertical) {
        // Tategaki reads right to left.
        members.sort(function (a, b) { return b.x - a.x; });
      } else {
        members.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      }
      block.text = members
        .map(function (m) { return m.text.trim(); })
        .filter(Boolean)
        .join("");
      block.width = Math.min(block.width, Math.max(60, lineHeight * 3.2));
      blocks.push(block);
    });

    blocks = resolveOverlaps(blocks);
    blocks.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    return blocks.filter(function (block) {
      return block.text.length > 0 && block.width > 24 && block.height > 18;
    });
  }

  /* Two balloons that overlap after padding must not both eat pixels. Dropping
   * the smaller one loses a line of dialogue outright, so the smaller region is
   * clipped back instead and only discarded if nothing usable is left. */
  function resolveOverlaps(blocks) {
    var sorted = blocks.slice().sort(function (a, b) {
      return b.width * b.height - a.width * a.height;
    });
    var kept = [];

    sorted.forEach(function (block) {
      var box = {
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        vertical: block.vertical,
        lineHeight: block.lineHeight,
        text: block.text,
        id: block.id
      };
      var floorWidth = Math.max(20, Math.min(60, block.width * 0.45));
      var floorHeight = Math.max(14, Math.min(40, block.height * 0.45));
      var right = box.x + box.width;
      var bottom = box.y + box.height;

      for (var i = 0; i < kept.length && box; i++) {
        var other = kept[i];
        var overlapX =
          Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
        var overlapY =
          Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // Trim along whichever axis needs the smaller correction.
        if (overlapX < overlapY) {
          if (box.x + box.width / 2 < other.x + other.width / 2) {
            box.width = other.x - box.x;
          } else {
            box.x = other.x + other.width;
            box.width = right - box.x;
          }
        } else if (box.y + box.height / 2 < other.y + other.height / 2) {
          box.height = other.y - box.y;
        } else {
          box.y = other.y + other.height;
          box.height = bottom - box.y;
        }

        if (box.width < floorWidth || box.height < floorHeight) box = null;
      }

      if (box) kept.push(box);
    });

    return kept;
  }

  // -------------------------------------------------------------- typeset

  function measure(ctx, text) {
    return ctx.measureText(text).width;
  }

  function breakLongWord(ctx, word, available) {
    var parts = [];
    var current = "";
    for (var i = 0; i < word.length; i++) {
      var candidate = current + word[i];
      if (current && measure(ctx, candidate) > available) {
        parts.push(current);
        current = word[i];
      } else {
        current = candidate;
      }
      // A single glyph wider than the box (rare, but a stray mark) is dropped
      // rather than allowed to overflow.
      if (current.length === 1 && measure(ctx, current) > available) {
        parts.push(current);
        current = "";
      }
    }
    if (current) parts.push(current);
    if (!parts.length) parts.push("");
    return parts;
  }

  function wrapText(ctx, text, available) {
    var words = String(text).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [];
    var current = "";

    words.forEach(function (word) {
      if (measure(ctx, word) > available) {
        if (current) {
          lines.push(current);
          current = "";
        }
        breakLongWord(ctx, word, available).forEach(function (part) {
          if (current) {
            lines.push(current);
            current = "";
          }
          lines.push(part);
        });
        return;
      }
      var candidate = current ? current + " " + word : word;
      if (measure(ctx, candidate) > available) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);
    return lines;
  }

  /* Turkish needs to be set at roughly the size of the lettering it replaces, or
   the page stops looking like the same page. `block.lineHeight` is the height of
   a single OCR line in the original, which is a far better size cue than the
   block's height: a three-line balloon and a one-line balloon in the same panel
   get the same treatment only if the line height is respected. */
function fitBlock(ctx, text, block, settings) {
  var padX = block.width * 0.07;
  var padY = block.height * 0.05;
  var availableWidth = Math.max(10, block.width - padX * 2);
  var availableHeight = Math.max(8, block.height - padY * 2);
  var weight = block.vertical ? 700 : 600;
  var stack = fontStack(settings);

  // Original glyph height, with a floor for panels where OCR reported a very
  // short run, and a ceiling so a translation can never overflow its balloon.
  var lineHint = block.lineHeight && block.lineHeight > 0 ? block.lineHeight : block.height;
  var natural = Math.min(block.height * 0.62, lineHint * 1.02);
  var size = clamp(natural, 8, 110) * (settings.fontScale || 1);
  var floor = 7;
  var best = null;

  for (var attempt = 0; attempt < 46 && size >= floor; attempt++, size *= 0.94) {
    ctx.font = weight + " " + size.toFixed(2) + "px " + stack;
    var lines = wrapText(ctx, text, availableWidth);
    var lineHeight = size * 1.14;
    if (lines.length * lineHeight <= availableHeight) {
      best = { size: size, lines: lines, lineHeight: lineHeight };
      break;
    }
  }

  if (!best) {
    size = floor;
    ctx.font = weight + " " + size + "px " + stack;
    var lines = wrapText(ctx, text, availableWidth);
    var lineHeight = size * 1.14;
    var maxLines = Math.max(1, Math.floor(availableHeight / lineHeight));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "\u2026");
    }
    best = { size: size, lines: lines, lineHeight: lineHeight };
  }

  return best;
}

  // ----------------------------------------------------------------- render

  function paintBlock(ctx, sampler, block) {
    var interiorLuma = sampler.meanLuma(block);
    var borderLuma = sampler.meanLuma({
      x: block.x - block.height * 0.25,
      y: block.y - block.height * 0.25,
      width: block.width + block.height * 0.5,
      height: block.height + block.height * 0.5
    });

    // Vision's box is tight around the glyphs, but ink bleeds past it: outlines,
    // drop shadows and the tail of a descender all sit outside. A few extra
    // pixels of cover is the difference between a clean erase and a ghost of
    // the original sentence under the Turkish one.
    var bleed = Math.max(1, block.height * 0.06);
    var area = {
      x: block.x - bleed,
      y: block.y - bleed,
      width: block.width + bleed * 2,
      height: block.height + bleed * 2
    };

    // A balloon is a bright shape on a darker page; a narration box sits on the
    // artwork's own tone and must keep that texture.
    var isBalloon = Math.abs(interiorLuma - borderLuma) > 26 || interiorLuma > 226;
    var fill = sampler.modeColor(block);
    var radius = isBalloon ? Math.min(block.width, block.height) * 0.34 : Math.min(4, block.height * 0.08);

    var donor = isBalloon ? null : findDonor(sampler, block);

    ctx.save();
    if (donor) {
      // Copy real texture across the lettering.
      ctx.drawImage(
        sampler.canvas,
        donor.x * sampler.ratioX,
        donor.y * sampler.ratioY,
        donor.width * sampler.ratioX,
        donor.height * sampler.ratioY,
        area.x,
        area.y,
        area.width,
        area.height
      );
    } else {
      ctx.beginPath();
      roundedRect(ctx, area.x, area.y, area.width, area.height, radius + bleed);
      if (isBalloon) {
        // Never paint a balloon darker than paper stock; manga pages are read
        // on white, and a grey balloon would look like a rendering bug.
        ctx.fillStyle =
          "rgb(" +
          Math.max(240, fill.r) +
          "," +
          Math.max(240, fill.g) +
          "," +
          Math.max(240, fill.b) +
          ")";
      } else {
        ctx.fillStyle = "rgb(" + fill.r + "," + fill.g + "," + fill.b + ")";
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  /* blocks: [{ id, x, y, width, height, text }], translations: { id: text }.
   *
   * The caller sets a transform first, which for a tall webtoon page also carries
   * a vertical offset because the overlay is split across several canvases. The
   * clear has to ignore that transform or it would start at the slice edge and
   * leave stale pixels behind. */
  function render(canvas, sampler, blocks, translations, settings) {
    var ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    var usable = blocks.filter(function (block) {
      return translations[block.id];
    });
    if (!usable.length) return 0;

    // Pass 1: erase every region before a single glyph is drawn, so no patch
    // can cover text that has already been typeset.
    usable.forEach(function (block) {
      paintBlock(ctx, sampler, block);
    });

    // Pass 2: typeset. Ink colour is decided from what is now under the block,
    // which is exactly the patch we just laid down.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    usable.forEach(function (block) {
      var fitted = fitBlock(ctx, translations[block.id], block, settings);
      var backgroundLuma = sampler.meanLuma({
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height
      });
      var dark = backgroundLuma > 132;
      ctx.fillStyle = dark ? "rgb(18,18,20)" : "rgb(250,250,252)";
      // A mid-tone patch defeats a single ink colour either way, so give the
      // glyphs a thin outline of the opposite one. Cheap, and it keeps webtoon
      // panels with screentone backgrounds readable.
      if (backgroundLuma > 96 && backgroundLuma < 170) {
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.lineWidth = Math.max(1.5, fitted.size * 0.09);
        ctx.strokeStyle = dark ? "rgb(252,252,254)" : "rgb(16,16,18)";
      } else {
        ctx.lineWidth = 0;
      }

      var centerX = block.x + block.width / 2;
      var startY = block.y + block.height / 2 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
      fitted.lines.forEach(function (line, index) {
        if (ctx.lineWidth > 0) ctx.strokeText(line, centerX, startY + index * fitted.lineHeight);
        ctx.fillText(line, centerX, startY + index * fitted.lineHeight);
      });
    });

    return usable.length;
  }

  return {
    clusterBoxes: clusterBoxes,
    createSampler: createSampler,
    render: render,
    isVertical: isVertical
  };
})();