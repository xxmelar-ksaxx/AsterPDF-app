import bidiFactory from 'bidi-js';
import { stretchArabicWords } from './kashida';
const bidi = bidiFactory();

export type TextLine = { text: string; width: number; paragraphEnd: boolean };

// Shared by the editor, page preview and PDF export. Explicit empty lines count.
export function layoutTextLines(text: string, measure: (text: string) => number, wrapWidth?: number): TextLine[] {
  const lines: TextLine[] = [];
  const add = (value: string, paragraphEnd = false) => lines.push({ text: value, width: measure(value), paragraphEnd });
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  for (const paragraph of paragraphs) {
    if (!wrapWidth || measure(paragraph) <= wrapWidth) { add(paragraph, true); continue; }
    let line = '';
    for (const word of paragraph.match(/\S+\s*|\s+/gu) || []) {
      if (line && measure((line + word).trimEnd()) > wrapWidth) { add(line.trimEnd()); line = ''; }
      if (measure(word.trimEnd()) <= wrapWidth) { line += word; continue; }
      const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word);
      for (const { segment } of segments) {
        if (line && measure(line + segment) > wrapWidth) { add(line); line = ''; }
        line += segment;
      }
    }
    add(line.trimEnd(), true);
  }
  return lines;
}

export function justifyTextLine(line: TextLine, width: number, measure: (text: string) => number, rtl: boolean, smart = false) {
  const words = [...line.text.matchAll(/\S+/gu)];
  if (line.paragraphEnd || words.length < 2 || line.width >= width) return undefined;
  const levels = bidi.getEmbeddingLevels(line.text, rtl ? 'rtl' : 'ltr');
  const ranks = new Map(bidi.getReorderedIndices(line.text, levels).map((index, rank) => [index, rank]));
  const displayed = smart ? stretchArabicWords(words.map((word) => word[0]), width - line.width, measure) : words.map((word) => word[0]);
  const runs = words.map((word, index) => ({ text: displayed[index], width: measure(displayed[index]), x: 0,
    rank: Math.min(...Array.from({ length: word[0].length }, (_, index) => ranks.get(word.index! + index) ?? 0)) }))
    .sort((a, b) => a.rank - b.rank);
  const gap = Math.max(0, (width - runs.reduce((total, run) => total + run.width, 0)) / (runs.length - 1));
  let x = 0;
  for (const run of runs) { run.x = x; x += run.width + gap; }
  return runs;
}
