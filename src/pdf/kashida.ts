// Conservative Arabic joining candidates, based on Unicode ArabicShaping.txt:
// https://www.unicode.org/Public/UCD/latest/ucd/ArabicShaping.txt
// Never insert across a non-joining letter, a ZWNJ, or a lam-alef ligature.
const dual = new Set([...'ئبتثجحخسشصضطظعغفقكلمنهىيپچکگی']);
const right = new Set([...'آأؤإاةدذرزوٱژ']);
const graphemes = new Intl.Segmenter('ar', { granularity: 'grapheme' });

function insertionPoint(word: string) {
  if (/الله|ﷲ/u.test(word)) return -1;
  const parts = [...graphemes.segment(word)];
  let candidate = -1;
  for (let index = 0; index + 1 < parts.length; index++) {
    const before = parts[index].segment.replace(/\p{Mark}/gu, '');
    const after = parts[index + 1].segment.replace(/\p{Mark}/gu, '');
    if (!dual.has(before) || !(dual.has(after) || right.has(after))) continue;
    if (before === 'ل' && /[آأإاٱ]/u.test(after)) continue;
    candidate = parts[index + 1].index;
    if (before === 'س' || before === 'ش') return candidate;
  }
  return candidate;
}

// Decorations are added only to display/export runs; the editable text is intact.
export function stretchArabicWords(words: string[], spareWidth: number, measure: (text: string) => number) {
  const result = [...words];
  const positions = words.map(insertionPoint);
  const widths = words.map(measure);
  const candidates = positions.flatMap((position, index) => {
    if (position < 0) return [];
    const word = words[index];
    const render = (count: number) => word.slice(0, position) + 'ـ'.repeat(count) + word.slice(position);
    const step = measure(render(1)) - widths[index];
    return step > .01 ? [{ index, render, count: 0 }] : [];
  });
  if (!Number.isFinite(spareWidth) || spareWidth <= 0) return result;
  const extend = (candidate: typeof candidates[number], budget: number) => {
    if (candidate.count >= 4096 || budget <= 0) return;
    const { index, render } = candidate;
    const growth = (count: number) => measure(render(count)) - widths[index];
    let low = candidate.count, high = Math.max(1, low + 1);
    // Exponential/binary search keeps wide text boxes cheap to update while
    // typing. The ceiling is a pathological-input guard, not a visual limit.
    while (high < 4096 && growth(high) <= budget) { low = high; high = Math.min(4096, high * 2); }
    if (growth(high) <= budget) low = high;
    else while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (growth(middle) <= budget) low = middle; else high = middle;
    }
    const next = render(low), width = measure(next), used = width - widths[index];
    if (used <= 0 || used > budget) return;
    result[index] = next; widths[index] = width; candidate.count = low; spareWidth -= used;
  };
  // Share actual spare pixels between eligible words, keeping normal spaces.
  candidates.forEach((candidate, index) => extend(candidate, spareWidth / (candidates.length - index)));
  // Spend rounding leftovers where another whole Kashida fits.
  for (const candidate of candidates) extend(candidate, spareWidth);
  return result;
}
