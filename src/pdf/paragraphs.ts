import type { PageViewport } from 'pdfjs-dist';
import type { OriginalPdfText } from '../types';
import type { InstalledFont } from '../components/FontPicker';
import type { OverlayObject } from './overlays';

type Fragment = { source: OriginalPdfText; left: number; right: number; baseline: number; size: number };
type Row = { fragments: Fragment[]; left: number; right: number; baseline: number };
export type Paragraph = { sources: OriginalPdfText[]; object: OverlayObject; overlayIds?: string[] };

const fontKey = (name: string) => name.replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const arabic = /\p{Script=Arabic}/u;

function editableFont(name: string, text: string, fonts: InstalledFont[]): OverlayObject['fontChoice'] {
  const key = fontKey(name);
  const match = fonts.find(font => fontKey(font.postscriptName) === key)
    ?? fonts.find(font => fontKey(font.family) === key && /regular|normal|book/i.test(font.style));
  if (match) return `system:${match.id}`;
  if (arabic.test(text)) return 'noto-naskh-arabic';
  if (/times|serif|georgia/i.test(name)) return 'noto-serif';
  return /helvetica|arial/i.test(name) ? 'helvetica' : 'noto-sans';
}

function rowText(row: Row, rtl: boolean) {
  const parts = rtl ? [...row.fragments].reverse() : row.fragments;
  return parts.reduce((text, part, index) => {
    const prior = parts[index - 1];
    const gap = prior && (rtl ? prior.left - part.right : part.left - prior.right);
    const space = prior && gap > part.size * .12 && !/\s$/u.test(text) && !/^\s/u.test(part.source.text);
    return text + (space ? ' ' : '') + part.source.text;
  }, '').trim();
}

// Work in displayed page points, including crop offsets, rotation and staged moves.
// A paragraph has one text style. Baseline, gutter and alignment checks keep
// columns and unrelated captions independent even when their PDF indices interleave.
export function detectParagraphs(objects: OriginalPdfText[], viewport: PageViewport, scale: number, pageId: string, fonts: InstalledFont[], explicit = false): Paragraph[] {
  const width = viewport.width / scale, height = viewport.height / scale;
  const styles = new Map<string, Fragment[]>();
  for (const source of objects) {
    const [a,b,c,d,x,y] = source.matrix;
    const origin = viewport.convertToViewportPoint(x,y);
    const advance = viewport.convertToViewportPoint(x+a,y+b);
    const up = viewport.convertToViewportPoint(x+c,y+d);
    const horizontal = advance[0] - origin[0], vertical = origin[1] - up[1];
    if (horizontal <= 0 || vertical <= 0 || Math.abs(advance[1] - origin[1]) > horizontal * .035 ||
      Math.abs(up[0] - origin[0]) > vertical * .35 || Math.abs(horizontal / vertical - 1) > .15) continue;
    const size = source.fontSize * vertical / scale;
    if (size < 4 || size > 500) continue;
    const [left] = viewport.convertToViewportPoint(source.box[0], source.box[1]);
    const [right] = viewport.convertToViewportPoint(source.box[2], source.box[3]);
    const key = [source.fontName, Math.round(size * 10), ...source.color].join('|');
    if (!styles.has(key)) styles.set(key, []);
    styles.get(key)!.push({ source, size, left: Math.min(left,right)/scale, right: Math.max(left,right)/scale, baseline: origin[1]/scale });
  }
  if (explicit && styles.size !== 1) return [];
  const allText = Array.from(styles.values()).flat();
  const result: Paragraph[] = [];
  for (const fragments of styles.values()) {
    const size = fragments[0].size;
    const bands: Fragment[][] = [];
    for (const fragment of fragments.sort((a,b) => a.baseline-b.baseline)) {
      const band = bands.at(-1);
      if (band && fragment.baseline-band[0].baseline < size*.22) band.push(fragment);
      else bands.push([fragment]);
    }
    // Track each column independently, including columns with staggered baselines.
    const blocks: Row[][] = [];
    const bounds = new Map<Row[],{left:number; right:number; length:number}>();
    for (const band of bands) {
      const rows: Row[] = [];
      for (const fragment of band.sort((a,b) => a.left-b.left)) {
        const row = rows.at(-1);
        if (row && (explicit || fragment.left-row.right <= size*.8) && fragment.left >= row.right-size*.2) {
          row.fragments.push(fragment); row.right = Math.max(row.right,fragment.right);
        } else rows.push({ fragments:[fragment], left:fragment.left, right:fragment.right, baseline:fragment.baseline });
      }
      const used = new Set<Row[]>();
      for (const row of rows) {
        const aligned = blocks.filter(block => {
          const last = block[block.length-1], step = row.baseline-last.baseline;
          const column = bounds.get(block)!;
          const overlap = Math.min(row.right,column.right)-Math.max(row.left,column.left);
          const edge = Math.min(Math.abs(row.left-column.left),Math.abs(row.right-column.right));
          const centered = Math.abs((row.left + row.right - last.left - last.right) / 2) <= size*.35;
          if (used.has(block) || step < size*.72) return false;
          if (column.length + row.fragments.reduce((n,f)=>n+f.source.text.length+1,0) > 10000) return false;
          if (explicit) return true;
          if (step > size*3.5 || overlap < Math.min(column.right-column.left,row.right-row.left)*.45 || (edge > size*1.8 && !centered)) return false;
          const left = Math.max(column.left,row.left), right = Math.min(column.right,row.right);
          return !allText.some(other => other.baseline > last.baseline+size*.24 && other.baseline < row.baseline-size*.24 &&
            other.right > left && other.left < right);
        });
        // Prefer the nearest preceding row if two vertically separated blocks align.
        const block = aligned.sort((a,b) => b.at(-1)!.baseline - a.at(-1)!.baseline)[0] ?? [];
        if (!block.length) blocks.push(block);
        block.push(row); used.add(block);
        const previous = bounds.get(block);
        bounds.set(block,{left:Math.min(previous?.left ?? row.left,row.left), right:Math.max(previous?.right ?? row.right,row.right),
          length:(previous?.length ?? 0) + row.fragments.reduce((n,f)=>n+f.source.text.length+1,0)});
      }

    }
    for (const block of blocks) {
      const sources = block.flatMap(row => row.fragments.map(fragment => fragment.source));
      const rtl = arabic.test(sources.map(source => source.text).join(''));
      const steps = block.slice(1).map((row, i) => row.baseline - block[i].baseline);
      const sorted = [...steps].sort((a,b) => a-b);
      // A lower quantile estimates normal leading without counting the larger
      // gaps between paragraphs as ordinary line spacing.
      const typical = sorted[Math.floor((sorted.length-1)*.35)] ?? size*1.4;
      const leading = typical > size*1.95 && !explicit ? size*1.4 : typical;
      const gaps = steps.map(step => step-leading).filter(extra => extra > size*.2).sort((a,b) => a-b);
      const gap = gaps.length ? Math.round(gaps[Math.floor(gaps.length/2)]*100)/100 : undefined;
      const text = block.map(row => rowText(row,rtl)).reduce((joined, line, i) => {
        if (i && steps[i-1] - leading > size*.2) return joined + '\n' + line;
        if (!joined) return line;
        if (joined.endsWith('\u00ad')) return joined.slice(0, -1) + line;
        return joined + (/\p{L}[-\u2010]$/u.test(joined) ? '' : ' ') + line;
      }, '');
      if (!text || text.length > 10000) continue;
      const left = Math.min(...block.map(row => row.left)), right = Math.max(...block.map(row => row.right));
      const first = sources[0], multiplier = leading / size;
      const spread = (positions: number[]) => Math.max(...positions) - Math.min(...positions);
      const leftSpread = spread(block.map(row => row.left)), rightSpread = spread(block.map(row => row.right));
      const centerSpread = spread(block.map(row => (row.left + row.right) / 2));
      let textAlign: OverlayObject['textAlign'] = rtl ? 'right' : 'left';
      if (leftSpread + size*.25 < rightSpread) textAlign = 'left';
      if (rightSpread + size*.25 < leftSpread) textAlign = 'right';
      if (centerSpread + size*.25 < Math.min(leftSpread, rightSpread)) textAlign = 'center';
      result.push({sources, object:{ id:'', pageId, kind:'text', editingTool:'edit', text, textSizing:'paragraph',
        x:left/width, y:(block[0].baseline-size)/height, width:Math.max(size,right-left+size*.12)/width,
        height:(size+block.at(-1)!.baseline-block[0].baseline)/height,
        lineSpacing:Math.min(3,Math.max(.75,Math.round(multiplier*100)/100)), ...(gap !== undefined ? {paragraphGap:gap} : {breakSpacing:1}), fontSize:size, lineWidth:1,
        fontChoice:editableFont(first.fontName,text,fonts), bold:/bold/i.test(first.fontName), italic:/italic|oblique/i.test(first.fontName),
        textAlign, color:'#'+first.color.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join(''), opacity:first.color[3]/255 }});
    }
  }
  return result;
}
