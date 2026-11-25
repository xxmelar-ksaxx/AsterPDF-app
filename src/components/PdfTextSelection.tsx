import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import type { TextMarkupSelection } from '../pdf/comments';

const layers = new Map<HTMLElement, { page: number; viewport: PageViewport }>();
const previewName = 'pdf-markup-drag';

// PDF text runs can be stored in a different order from their positions on the page.
// Measure visible characters so a drag cannot include intervening DOM siblings.
function markupDrag(startX: number, startY: number) {
  const candidates = Array.from(layers, ([layer, entry]) => ({
    layer, ...entry, spans: Array.from(layer.querySelectorAll<HTMLSpanElement>('span[role="presentation"]')),
  }));
  const cache = new Map<HTMLElement, { range: Range; x: number; y: number }[]>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return (x: number, y: number) => {
    const preview = new Highlight();
    const selections: TextMarkupSelection[] = [];
    const left = Math.min(startX, x), right = Math.max(startX, x);
    const top = Math.min(startY, y), bottom = Math.max(startY, y);
    for (const { layer, spans, viewport, page } of candidates) {
      const origin = layer.parentElement!.getBoundingClientRect();
      const quadPoints: number[] = [], words: string[] = [];
      for (const span of spans) {
        const box = span.getBoundingClientRect();
        if (box.right < left || box.left > right || box.bottom < top || box.top > bottom) continue;
        const node = span.firstChild;
        if (!(node instanceof Text)) continue;
        let glyphs = cache.get(span);
        if (!glyphs) {
          glyphs = Array.from(segmenter.segment(node.data), ({ index, segment }) => {
            const range = document.createRange();
            range.setStart(node, index); range.setEnd(node, index + segment.length);
            const rect = range.getBoundingClientRect();
            return { range, x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
          });
          cache.set(span, glyphs);
        }
        let run: Range | undefined;
        const flush = () => {
          if (!run) return;
          preview.add(run);
          words.push(run.toString());
          for (const rect of run.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            for (const [cx, cy] of [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]])
              quadPoints.push(...viewport.convertToPdfPoint(cx - origin.left, cy - origin.top));
          }
          run = undefined;
        };
        for (const glyph of glyphs) {
          const cx = box.left + glyph.x, cy = box.top + glyph.y;
          // A horizontal stroke anywhere inside a line can select its characters.
          const inset = Math.min(box.height * .4, Math.max(0, box.height / 2 - 1));
          if (cx < left || cx > right || cy + inset < top || cy - inset > bottom) { flush(); continue; }
          run ??= glyph.range.cloneRange();
          run.setEnd(node, glyph.range.endOffset);
        }
        flush();
      }
      if (quadPoints.length) selections.push({ page, text: words.join(' '), quadPoints });
    }
    CSS.highlights.set(previewName, preview);
    return selections;
  };
}
const pages = new Map<HTMLElement, { page: number; viewport: PageViewport }>();
export function registerSelectionPage(stage: HTMLElement, page: number, viewport: PageViewport) {
  pages.set(stage, { page, viewport });
  return () => { pages.delete(stage); };
}

function selectedEditorText(): TextMarkupSelection[] {
  const input = document.activeElement;
  let mirror: HTMLElement | undefined;
  let range: Range | undefined;
  let stage: HTMLElement | null = null;
  if (input instanceof HTMLTextAreaElement && input.matches('.original-text-editable') && input.selectionStart !== input.selectionEnd) {
    stage = input.closest('.page-stage');
    mirror = document.createElement('div');
    const style = getComputedStyle(input);
    for (const key of Array.from(style)) mirror.style.setProperty(key, style.getPropertyValue(key));
    mirror.style.visibility = 'hidden'; mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = input.wrap === 'off' ? 'pre' : 'pre-wrap';
    mirror.textContent = input.value;
    input.parentElement!.append(mirror);
    mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft;
    range = document.createRange();
    range.setStart(mirror.firstChild!, input.selectionStart); range.setEnd(mirror.firstChild!, input.selectionEnd);
  } else {
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const element = selection.anchorNode?.parentElement?.closest('.original-text-editable');
      if (element) { stage = element.closest('.page-stage'); range = selection.getRangeAt(0); }
    }
  }
  try {
    const entry = stage && pages.get(stage);
    if (!entry || !range || !range.toString().trim()) return [];
    const bounds = stage!.getBoundingClientRect();
    const quadPoints = Array.from(range.getClientRects()).filter(rect => rect.width > .5 && rect.height > .5).flatMap(rect => [
      ...entry.viewport.convertToPdfPoint(rect.left - bounds.left, rect.top - bounds.top),
      ...entry.viewport.convertToPdfPoint(rect.right - bounds.left, rect.top - bounds.top),
      ...entry.viewport.convertToPdfPoint(rect.left - bounds.left, rect.bottom - bounds.top),
      ...entry.viewport.convertToPdfPoint(rect.right - bounds.left, rect.bottom - bounds.top)
    ]);
    return quadPoints.length ? [{ page: entry.page, text: range.toString(), quadPoints }] : [];
  } finally { mirror?.remove(); }
}

/** Read only selected text runs, never the large bounding rectangle of a paragraph. */
export function selectedPdfText(): TextMarkupSelection[] {
  const editor = selectedEditorText();
  if (editor.length) return editor;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  const selected = selection.getRangeAt(0);
  const result: TextMarkupSelection[] = [];
  for (const [container, { page, viewport }] of layers) {
    if (!selected.intersectsNode(container)) continue;
    const origin = container.parentElement!.getBoundingClientRect();
    const fragments: { left: number; top: number; right: number; bottom: number }[] = [];
    const words: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!selected.intersectsNode(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (range.compareBoundaryPoints(Range.START_TO_START, selected) < 0) range.setStart(selected.startContainer, selected.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, selected) > 0) range.setEnd(selected.endContainer, selected.endOffset);
      if (range.collapsed || !range.toString().trim()) continue;
      words.push(range.toString());
      for (const rect of range.getClientRects()) {
        if (rect.width > .5 && rect.height > .5) fragments.push({ left: Math.max(0, rect.left - origin.left), top: Math.max(0, rect.top - origin.top),
          right: Math.min(viewport.width, rect.right - origin.left), bottom: Math.min(viewport.height, rect.bottom - origin.top) });
      }
    }
    fragments.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines: typeof fragments = [];
    for (const rect of fragments) {
      if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
      const height = rect.bottom - rect.top;
      const previous = lines.find(line => Math.abs(line.top - rect.top) < height * .2 && Math.abs(line.bottom - rect.bottom) < height * .2 &&
        rect.left <= line.right + height * .3 && rect.right >= line.left - height * .3);
      if (previous) {
        previous.left = Math.min(previous.left, rect.left); previous.right = Math.max(previous.right, rect.right);
        previous.top = Math.min(previous.top, rect.top); previous.bottom = Math.max(previous.bottom, rect.bottom);
      } else lines.push({ ...rect });
    }
    const quadPoints = lines.flatMap(rect => [
      ...viewport.convertToPdfPoint(rect.left, rect.top), ...viewport.convertToPdfPoint(rect.right, rect.top),
      ...viewport.convertToPdfPoint(rect.left, rect.bottom), ...viewport.convertToPdfPoint(rect.right, rect.bottom)
    ]);
    if (quadPoints.length) result.push({ page, text: words.join(' ').trim(), quadPoints });
  }
  return result;
}

export default function PdfTextSelection({ pdf, sourcePage, page, viewport, marking, inserting, onMark, onError, onClickMarkup }: {
  pdf: PDFDocumentProxy; sourcePage: number; page: number; viewport: PageViewport; marking: boolean; inserting: boolean;
  onError: (message: string) => void; onClickMarkup: (x: number, y: number) => boolean;
  onMark: (selection: TextMarkupSelection[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<ReturnType<typeof markupDrag> | null>(null);
  const moved = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  useEffect(() => () => { drag.current = null; CSS.highlights.delete(previewName); }, [marking, viewport]);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    const container = ref.current!;
    let cancelled = false;
    let layer: TextLayer | undefined;
    container.replaceChildren();
    container.style.setProperty('--total-scale-factor', String(viewport.scale));
    setEmpty(false);
    void (async () => {
      const pdfPage = await pdf.getPage(sourcePage);
      const content = await pdfPage.getTextContent();
      if (cancelled) return;
      layer = new TextLayer({ textContentSource: content, container, viewport });
      await layer.render();
      if (cancelled) return;
      setEmpty(!layer.textContentItemsStr.some(text => text.trim()));
      layers.set(container, { page, viewport });
    })().catch(cause => { if (!cancelled) onError(`Could not prepare text selection: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; layer?.cancel(); layers.delete(container); container.replaceChildren(); };
  }, [pdf, sourcePage, page, viewport, onError]);
  return <>
    <div ref={ref} className="pdf-selection-layer" onPointerDown={event => {
      moved.current = false;
      if (inserting) { if (event.button === 0) event.preventDefault(); return; }
      if (!marking || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      start.current = { x: event.clientX, y: event.clientY };
      drag.current = markupDrag(event.clientX, event.clientY);
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      if (!drag.current || !event.isPrimary) return;
      moved.current ||= Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) >= 2;
      if (moved.current) drag.current(event.clientX, event.clientY);
    }} onPointerUp={event => {
      if (!drag.current || !event.isPrimary) return;
      if (moved.current) onMark(drag.current(event.clientX, event.clientY));
      drag.current = null;
      CSS.highlights.delete(previewName);
    }} onLostPointerCapture={() => {
      drag.current = null; CSS.highlights.delete(previewName);
    }} onDragStart={event => event.preventDefault()} onClick={event => {
      event.stopPropagation();
      if (moved.current) return;
      if (inserting) {
        const layer = event.currentTarget;
        const origin = layer.parentElement!.getBoundingClientRect();
        if (onClickMarkup(event.clientX - origin.left, event.clientY - origin.top)) return;
        const range = document.caretRangeFromPoint(event.clientX, event.clientY);
        const caret = range?.getBoundingClientRect();
        const nearText = range && layer.contains(range.startContainer) && caret && caret.height > 0 &&
          Math.abs(caret.left - event.clientX) < caret.height && event.clientY >= caret.top && event.clientY <= caret.bottom;
        const x = (nearText ? caret.left : event.clientX) - origin.left;
        const height = nearText ? caret.height : 12 * viewport.scale;
        const top = (nearText ? caret.top : event.clientY - height / 2) - origin.top;
        const halfWidth = .8 * viewport.scale;
        const quadPoints = [top, top + height].flatMap(y =>
          [x - halfWidth, x + halfWidth].flatMap(edge => viewport.convertToPdfPoint(edge, y)));
        onMark([{ page, text: '', quadPoints }]);
        return;
      }
      if (window.getSelection()?.isCollapsed) {
        const origin = event.currentTarget.parentElement!.getBoundingClientRect();
        onClickMarkup(event.clientX - origin.left, event.clientY - origin.top);
      }
    }} />
    {empty && marking && <span className="markup-no-text" role="status">{t("No selectable text on this page")}</span>}
  </>;
}
