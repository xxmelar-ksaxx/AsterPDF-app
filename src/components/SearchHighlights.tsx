import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import type { SearchHit } from '../pdf/search';

type Box = { left: number; top: number; width: number; height: number; hit: SearchHit };

// The editable SVG wraps text into tspans and may insert decorative Kashida.
// Walk the displayed characters so offsets still refer to the authored string.
function overlayRangeNodes(group: Element, original: string) {
  const glyphs: { node: Text; start: number; end: number; offset: number }[] = [];
  for (const span of group.querySelectorAll('tspan')) {
    let offset = Number(span.getAttribute('data-text-offset'));
    const node = span.firstChild;
    if (!(node instanceof Text)) continue;
    for (let i = 0; i < node.length;) {
      const char = String.fromCodePoint(node.data.codePointAt(i)!);
      const start = i;
      i += char.length;
      if (/[\s\u0640]/u.test(char)) continue;
      while (offset < original.length && /[\s\u0640]/u.test(original[offset])) offset++;
      if (!original.startsWith(char, offset)) continue;
      glyphs.push({ node, start, end: i, offset }); offset += char.length;
    }
  }
  return glyphs.sort((a, b) => a.offset - b.offset);
}

export default function SearchHighlights({ pdf, sourcePage, viewport, hits, active, reveal, overlayText }: {
  pdf: PDFDocumentProxy; sourcePage: number; viewport: PageViewport; hits: SearchHit[]; active?: SearchHit;
  reveal: (hit: SearchHit, marker: HTMLElement) => void; overlayText: Map<string, string>;
}) {
  const layerRoot = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    const container = layerRoot.current!;
    let cancelled = false;
    let next: TextLayer | undefined;
    setLayer(null);
    container.style.setProperty('--total-scale-factor', String(viewport.scale));
    void (async () => {
      const page = await pdf.getPage(sourcePage);
      const content = await page.getTextContent();
      if (cancelled) return;
      next = new TextLayer({ textContentSource: content, container, viewport });
      await next.render();
      if (!cancelled) setLayer(next);
    })().catch(() => { /* A page can be destroyed while leaving a document. */ });
    return () => { cancelled = true; next?.cancel(); container.replaceChildren(); };
  }, [pdf, sourcePage, viewport]);

  useEffect(() => {
    const stage = plane.current?.parentElement;
    if (!stage) return;
    const origin = stage.getBoundingClientRect(), result: Box[] = [];
    const glyphsById = new Map<string, ReturnType<typeof overlayRangeNodes>>();
    function measure(node: Text, start: number, end: number, hit: SearchHit) {
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, end);
      for (const rect of range.getClientRects()) if (rect.width && rect.height)
        result.push({ hit, left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height });
    }
    for (const hit of hits) {
      for (const span of hit.spans) {
        if (hit.overlayId) {
          let glyphs = glyphsById.get(hit.overlayId);
          if (!glyphs) {
            const group = stage.querySelector('[data-overlay-id="' + CSS.escape(hit.overlayId) + '"]');
            glyphs = group ? overlayRangeNodes(group, overlayText.get(hit.overlayId) ?? '') : [];
            glyphsById.set(hit.overlayId, glyphs);
          }
          let first: typeof glyphs[number] | undefined, last: typeof first;
          for (const glyph of glyphs) {
            if (glyph.offset < span.start) continue;
            if (glyph.offset >= span.end) break;
            if (first && last && glyph.node !== first.node) { measure(first.node, first.start, last.end, hit); first = undefined; }
            first ??= glyph; last = glyph;
          }
          if (first && last) measure(first.node, first.start, last.end, hit);
        } else {
          const node = layer?.textDivs[span.run]?.firstChild;
          if (node instanceof Text && span.end <= node.length) measure(node, span.start, span.end, hit);
        }
      }
    }
    setBoxes(result);
  }, [layer, hits, viewport, overlayText]);
  useEffect(() => {
    const marker = plane.current?.querySelector<HTMLElement>('.current');
    if (active && marker) reveal(active, marker);
  }, [active, boxes, reveal]);
  return <>
    <div ref={layerRoot} className="pdf-selection-layer pdf-find-text" aria-hidden="true" />
    <div ref={plane} className="pdf-find-highlights" aria-hidden="true">{boxes.map(({ hit, ...style }, i) =>
      <span key={i} className={hit === active ? 'current' : ''} style={style} />)}</div>
  </>;
}
