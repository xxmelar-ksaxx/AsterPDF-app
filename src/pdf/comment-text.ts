export type BoldRanges = [number, number][];
export type CommentText = { text: string; bold?: BoldRanges };

export function commentDirection(text: string): 'rtl' | 'ltr' {
  const firstLetter = text.match(/\p{L}/u)?.[0];
  return firstLetter && /\p{Script=Arabic}/u.test(firstLetter) ? 'rtl' : 'ltr';
}

export function normalizeBold(text: string, ranges: BoldRanges = []): BoldRanges {
  const sorted = ranges.filter(pair => Array.isArray(pair) && pair.length === 2 && pair.every(Number.isInteger))
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as [number, number])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const result: BoldRanges = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

export function trimComment({ text, bold }: CommentText): Required<CommentText> {
  const offset = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return { text: trimmed, bold: normalizeBold(trimmed, (bold || []).map(([start, end]) => [start - offset, end - offset])) };
}

export function sameComment(a: CommentText, b: CommentText) {
  const left = trimComment(a), right = trimComment(b);
  return left.text === right.text && JSON.stringify(left.bold) === JSON.stringify(right.bold);
}

export function commentSegments(text: string, bold?: BoldRanges) {
  let cursor = 0;
  const parts: { text: string; bold: boolean }[] = [];
  for (const [start, end] of normalizeBold(text, bold)) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), bold: false });
    parts.push({ text: text.slice(start, end), bold: true }); cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), bold: false });
  return parts;
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
export function commentHtml(text: string, bold?: BoldRanges) {
  return commentSegments(text, bold).map(part => {
    const value = escape(part.text).replace(/\n/g, '<br/>');
    return part.bold ? `<span style="font-weight:bold">${value}</span>` : value;
  }).join('');
}
export function commentRichText(value: CommentText) {
  const { text, bold } = trimComment(value);
  const direction = commentDirection(text);
  // ASCII XML with character references also works in readers that parse /RC
  // directly without decoding a UTF-16 PDF string first.
  return `<body xmlns="http://www.w3.org/1999/xhtml"><p dir="${direction}" style="font-family:Helvetica;font-size:12pt;direction:${direction};text-align:${direction === 'rtl' ? 'right' : 'left'}">${commentHtml(text, bold)}</p></body>`
    .replace(/[^\x00-\x7f]/gu, char => `&#${char.codePointAt(0)};`);
}

// PDF.js exposes a parsed tree, not trusted HTML. Read only text and bold weight.
export type RichNode = { name?: string; value?: string; attributes?: { style?: Record<string, unknown> }; children?: RichNode[] };
export function readRichBold(html: RichNode | undefined, expectedText: string): BoldRanges {
  let text = ''; const bold: BoldRanges = [];
  const append = (value: string, weight: boolean) => { const start = text.length; text += value; if (weight && value) bold.push([start, text.length]); };
  const walk = (node: RichNode, inherited = false) => {
    const style = node.attributes?.style?.fontWeight;
    const weight = style === undefined ? inherited || node.name === 'b' || node.name === 'strong' : style === 'bold' || Number(style) >= 600;
    if (node.name === 'br') { append('\n', weight); return; }
    if (typeof node.value === 'string') append(node.value, weight);
    for (const child of node.children || []) walk(child, weight);
    if (node.name === 'p' || node.name === 'div') append('\n', false);
  };
  if (html) walk(html);
  const normalized = trimComment({ text, bold });
  return normalized.text === expectedText ? normalized.bold : [];
}
