export type SearchRun = { str: string; hasEOL?: boolean };
export type SearchSpan = { run: number; start: number; end: number };
export type SearchHit = { spans: SearchSpan[]; overlayId?: string };
export type FindOptions = { matchCase: boolean; wholeWords: boolean };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const ignored = /[\u00ad\u061c\u0640\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wrappedWord = /(?<=\p{L})[-\u2010\u00ad]\n(?=\p{Ll})/gu;

function fold(value: string, matchCase: boolean) {
  let text = value.normalize('NFKC').replace(ignored, '');
  // Arabic vowel marks are optional. Preserve meaningful marks in other scripts.
  text = text.replace(/[\u064b-\u0652\u0670]/gu, '');
  if (!matchCase) text = text.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  return text.replace(/\s+/gu, ' ');
}

export function searchQuery(value: string, matchCase: boolean) {
  return fold(value, matchCase).trim();
}

type SearchPage = { raw: string; starts: number[]; wraps: Set<number>; folded: Map<string, string> };
const indexed = new WeakMap<SearchRun[], SearchPage>();

function indexPage(runs: SearchRun[]): SearchPage {
  const cached = indexed.get(runs);
  if (cached) return cached;
  let raw = '';
  const starts: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    starts.push(raw.length);
    raw += runs[i].str;
    if (runs[i].hasEOL) {
      const next = runs[i + 1]?.str || '';
      if (!(eastAsian.test(raw.slice(-1)) && eastAsian.test(next.charAt(0)))) raw += '\n';
    }
  }
  const wraps = new Set(Array.from(raw.matchAll(wrappedWord), match => match.index!));
  const page = { raw, starts, wraps, folded: new Map<string, string>() };
  indexed.set(runs, page);
  return page;
}

export function findInRuns(runs: SearchRun[], needle: string, options: FindOptions): SearchHit[] {
  if (!needle) return [];
  const page = indexPage(runs);
  const { raw, starts, wraps } = page;
  const keepHyphen = wraps.size > 0 && /[-\u2010]/u.test(needle);
  const key = String(options.matchCase) + '/' + keepHyphen;
  let searchable = page.folded.get(key);
  if (searchable === undefined) {
    const joined = wraps.size ? raw.replace(wrappedWord, match => keepHyphen ? match[0] : '') : raw;
    searchable = fold(joined, options.matchCase);
    page.folded.set(key, searchable);
  }
  if (!searchable.includes(needle)) return [];

  // Only matching pages need a UTF-16 offset map for painting the original glyphs.
  const offsets: number[] = [], ends: number[] = [];
  let text = '';
  function append(value: string, from: number, to: number) {
    if (wraps.size && (wraps.has(from - 1) || (!keepHyphen && wraps.has(from)))) return;
    if (value === ' ' && text.endsWith(' ')) { ends[ends.length - 1] = to; return; }
    text += value;
    for (let k = 0; k < value.length; k++) { offsets.push(from); ends.push(to); }
  }
  if (/^[\x00-\x7f]*$/.test(raw)) {
    const ascii = options.matchCase ? raw : raw.toLowerCase();
    for (let i = 0; i < raw.length; i++) append(/\s/.test(ascii[i]) ? ' ' : ascii[i], i, i + 1);
  } else {
    for (const { segment, index } of graphemes.segment(raw))
      append(fold(segment, options.matchCase), index, index + segment.length);
  }
  let boundaries: Set<number> | undefined;
  if (options.wholeWords) {
    boundaries = new Set([text.length]);
    for (const token of words.segment(text)) boundaries.add(token.index);
  }
  const hits: SearchHit[] = [];
  let run = 0;
  for (let at = text.indexOf(needle); at >= 0;) {
    const stop = at + needle.length;
    if ((!boundaries || (boundaries.has(at) && boundaries.has(stop))) &&
        offsets[at] !== offsets[at - 1] && ends[stop - 1] !== ends[stop]) {
      const from = offsets[at], to = ends[stop - 1];
      while (run + 1 < starts.length && starts[run + 1] <= from) run++;
      const spans: SearchSpan[] = [];
      for (let i = run; i < runs.length && starts[i] < to; i++) {
        const start = Math.max(0, from - starts[i]);
        const end = Math.min(runs[i].str.length, to - starts[i]);
        if (start < end) spans.push({ run: i, start, end });
      }
      if (spans.length) hits.push({ spans });
      at = text.indexOf(needle, stop);
    } else at = text.indexOf(needle, at + 1);
  }
  return hits;
}
