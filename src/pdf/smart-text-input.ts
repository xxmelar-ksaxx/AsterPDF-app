import { stretchArabicWords } from './kashida';
import { layoutTextLines } from './text-layout';

// The textarea displays real shaped glyphs, so native caret/selection geometry
// stays accurate. Generated Kashidas map to zero-length source ranges and never
// become part of the user's text, clipboard, or editable PDF metadata.
export type TextInputView = { source: string; text: string; boundaries: number[] };

export function plainTextInput(source: string): TextInputView {
  return { source, text: source, boundaries: Array.from({ length: source.length + 1 }, (_, index) => index) };
}

export function smartTextInput(source: string, measure: (text: string) => number, width: number): TextInputView {
  const inserts = new Map<number, number>();
  let offset = 0;
  for (const line of layoutTextLines(source, measure, width)) {
    const start = source.indexOf(line.text, offset);
    if (start < 0) continue;
    offset = start + line.text.length;
    const words = [...line.text.matchAll(/\S+/gu)];
    if (line.paragraphEnd || words.length < 2 || line.width >= width) continue;
    const displayed = stretchArabicWords(words.map((word) => word[0]), width - line.width, measure);
    words.forEach((word, index) => {
      let original = 0;
      for (const character of displayed[index]) {
        if (character === 'ـ' && word[0][original] !== 'ـ') {
          const position = start + word.index! + original;
          inserts.set(position, (inserts.get(position) || 0) + 1);
        } else original += character.length;
      }
    });
  }
  let text = '';
  const boundaries = [0];
  for (let index = 0; index < source.length; index++) {
    const count = inserts.get(index) || 0;
    text += 'ـ'.repeat(count) + source[index];
    for (let extra = 0; extra < count; extra++) boundaries.push(index);
    boundaries.push(index + 1);
  }
  return { source, text, boundaries };
}

export function sourcePosition(view: TextInputView, position: number) {
  return view.boundaries[Math.max(0, Math.min(position, view.text.length))];
}

export function displayPosition(view: TextInputView, position: number) {
  // Prefer the end of a generated stretch at the same logical insertion point.
  let low = 0, high = view.boundaries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (view.boundaries[middle] <= position) low = middle + 1; else high = middle;
  }
  return Math.max(0, low - 1);
}

export function applyTextInput(view: TextInputView, text: string): TextInputView {
  let start = 0, oldEnd = view.text.length, newEnd = text.length;
  while (start < oldEnd && start < newEnd && view.text[start] === text[start]) start++;
  while (oldEnd > start && newEnd > start && view.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  const from = sourcePosition(view, start), to = sourcePosition(view, oldEnd);
  const inserted = text.slice(start, newEnd);
  const delta = inserted.length - (to - from);
  return {
    source: view.source.slice(0, from) + inserted + view.source.slice(to), text,
    boundaries: [
      ...view.boundaries.slice(0, start + 1),
      ...Array.from({ length: inserted.length }, (_, index) => from + index + 1),
      ...view.boundaries.slice(oldEnd + 1).map((position) => position + delta),
    ],
  };
}
