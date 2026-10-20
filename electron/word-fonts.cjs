const fs = require('node:fs/promises');
const path = require('node:path');
const fontkit = require('@pdf-lib/fontkit');
const { normalize, extractCollectionFace } = require('./installed-fonts.cjs');

function createWordFonts(catalog = []) {
  const faces = new Map(), matches = new Map(), embedded = new Map(), issues = new Set();
  const styleOf = value => ({ bold: /bold|black|semibold|demi/i.test(value), italic: /italic|oblique/i.test(value) });
  const load = entry => {
    if (!faces.has(entry.id)) faces.set(entry.id, (async () => {
      const source = await fs.readFile(entry.file);
      const collection = fontkit.create(source);
      const index = Array.isArray(collection.fonts) ? collection.fonts.findIndex(face => face.postscriptName === entry.postscriptName) : 0;
      if (index < 0) return null;
      const bytes = extractCollectionFace(source, index);
      return { bytes, face: fontkit.create(bytes), entry };
    })().catch(() => null));
    return faces.get(entry.id);
  };
  async function resolve(run) {
    const rawName = run.font.replace(/^[A-Z]{6}\+/, '');
    const wantedStyle = styleOf(rawName);
    wantedStyle.bold ||= run.bold;
    const key = `${normalize(rawName)}:${wantedStyle.bold}:${wantedStyle.italic}`;
    if (!matches.has(key)) matches.set(key, (async () => {
      const base = normalize(rawName.replace(/[-,](bolditalic|boldoblique|semibold|bold|italic|oblique|regular|medium|light).*$/i, ''));
      const candidates = catalog.map(entry => {
        const style = styleOf(entry.style);
        let score = normalize(entry.postscriptName) === normalize(rawName) ? 100 :
          normalize(`${entry.family} ${entry.style}`) === normalize(rawName) ? 95 :
            normalize(entry.family) === base ? 70 : 0;
        if (score && style.bold === wantedStyle.bold && style.italic === wantedStyle.italic) score += 10;
        return { entry, score };
      }).filter(item => item.score).sort((a, b) => b.score - a.score);
      for (const { entry } of candidates) {
        const result = await load(entry);
        if (result) return result;
      }
      return null;
    })());
    let loaded = await matches.get(key);
    if (!loaded || !Array.from(run.text).every(character => /\s/u.test(character) || loaded.face.hasGlyphForCodePoint(character.codePointAt(0)))) {
      // Resolve and measure a real fallback, rather than writing an unavailable
      // name and leaving Word to choose an unpredictable font at open time.
      const fallbackEntries = catalog.filter(entry => ['arial', 'tahoma', 'noto sans arabic'].includes(entry.family.toLowerCase()))
        .sort((a, b) => {
          const score = entry => Number(styleOf(entry.style).bold === wantedStyle.bold) * 4 +
            Number(styleOf(entry.style).italic === wantedStyle.italic) * 2 + Number(entry.family.toLowerCase() === 'arial');
          return score(b) - score(a);
        });
      const arabic = /\p{Script=Arabic}/u.test(run.text);
      fallbackEntries.push({ id: arabic ? 'bundled-arabic' : 'bundled-sans',
        family: arabic ? 'Noto Naskh Arabic' : 'Noto Sans', style: 'Regular',
        file: path.join(__dirname, '..', 'assets', 'fonts', arabic ? 'NotoNaskhArabic.ttf' : 'NotoSans.ttf') });
      loaded = null;
      for (const entry of fallbackEntries) {
        const candidate = await load(entry);
        if (candidate && Array.from(run.text).every(character => /\s/u.test(character) || candidate.face.hasGlyphForCodePoint(character.codePointAt(0)))) {
          loaded = candidate; break;
        }
      }
      if (!loaded) {
        issues.add(`Font "${rawName || 'unknown'}" has no available font covering this text. Review missing characters.`);
        return null;
      }
      issues.add(`"${rawName || 'unknown'}" is unavailable; "${loaded.entry.family}" was used and fitted to the source positions. Install the original font for matching letter shapes.`);
    }
    const { face, bytes, entry } = loaded;
    const style = styleOf(entry.style);
    const rights = face['OS/2']?.fsType;
    // Editable DOCX needs editable/installable embedding rights, which are
    // stricter than the preview/print permission used for PDF rendering.
    const canEmbed = rights && !rights.noEmbedding && !rights.bitmapOnly && (!rights.viewOnly || rights.editable);
    if (canEmbed) {
      const record = embedded.get(entry.family) || { name: entry.family, data: bytes };
      const slot = style.bold && style.italic ? 'boldItalic' : style.bold ? 'bold' : style.italic ? 'italic' : 'data';
      if (record[slot] && record[slot] !== bytes && slot !== 'data') {
        issues.add(`Multiple "${entry.family}" font weights share one Word style. Some text may use a different weight.`);
      } else record[slot] = bytes;
      embedded.set(entry.family, record);
    } else issues.add(`Font "${entry.family}" cannot be embedded for editing. It must be installed on the machine opening the Word file.`);
    return { face, family: entry.family, bold: style.bold, italic: style.italic };
  }

  return {
    async prepare(runs) {
      for (const run of runs) {
        const match = await resolve(run);
        if (!match) continue;
        try {
          const layout = match.face.layout(run.text);
          const size = Math.max(1, Math.min(800, Math.round(run.size * 2) / 2));
          const unit = size / match.face.unitsPerEm;
          let pen = 0, left = Infinity, right = -Infinity;
          layout.glyphs.forEach((glyph, index) => {
            const position = layout.positions[index], box = glyph.bbox;
            if (box.maxX > box.minX) {
              left = Math.min(left, pen + position.xOffset + box.minX);
              right = Math.max(right, pen + position.xOffset + box.maxX);
            }
            pen += position.xAdvance;
          });
          if (!Number.isFinite(left) || right <= left || pen <= 0) continue;
          const desiredWidth = run.box[2] - run.box[0];
          const requested = Math.round(100 * desiredWidth / ((right - left) * unit));
          const scale = Math.max(50, Math.min(200, requested));
          if (scale !== requested) issues.add('Some PDF text has unusual horizontal scaling. Review those lines in Word.');
          run.word = { family: match.family, bold: match.bold, italic: match.italic, size, scale,
            advance: pen * unit * scale / 100, leftBearing: left * unit * scale / 100,
            ascent: match.face.ascent * unit, descent: Math.abs(match.face.descent * unit),
            space: match.face.layout(' ').advanceWidth * unit * scale / 100 };
        } catch {
          issues.add(`Could not measure "${match.family}" precisely. Review line wrapping for this font.`);
        }
      }
    },
    embedded: () => [...embedded.values()],
    warnings: () => [...issues]
  };
}

// Frame widths need advance widths (including side bearings), not just ink.
// The same fitting is used inside cells, where Word otherwise wraps too soon.
function fitLine(line, maxWidth = Infinity) {
  let advance = 0;
  for (let index = 0; index < line.runs.length; index++) {
    const run = line.runs[index], previous = line.runs[index - 1];
    if (previous && !/\s$/.test(previous.text) && !/^\s/.test(run.text)) {
      const gap = line.rtl ? previous.box[0] - run.box[2] : run.box[0] - previous.box[2];
      if (gap > Math.min(previous.size, run.size) * .15) advance += run.word?.space || run.size * .3;
    }
    advance += run.word?.advance || run.box[2] - run.box[0] + run.size * .3;
  }
  const available = Math.max(1, maxWidth - 1);
  return { advance, width: Math.min(maxWidth, Math.max(1, advance + 1)),
    fit: advance > available ? Math.max(.1, available / advance) : 1 };
}

module.exports = { createWordFonts, fitLine };
