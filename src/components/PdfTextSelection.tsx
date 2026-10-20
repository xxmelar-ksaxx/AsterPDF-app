import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import type { TextMarkupSelection } from '../pdf/comments';

const layers = new Map<HTMLElement, { page: number; viewport: PageViewport }>();

/** Read only selected text runs, never the large bounding rectangle of a paragraph. */
export function selectedPdfText(): TextMarkupSelection[] {
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

export default function PdfTextSelection({ pdf, sourcePage, page, viewport, marking, onError, onClickMarkup }: {
  pdf: PDFDocumentProxy; sourcePage: number; page: number; viewport: PageViewport; marking: boolean;
  onError: (message: string) => void; onClickMarkup: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className="pdf-selection-layer" onDragStart={event => event.preventDefault()} onClick={event => {
      event.stopPropagation();
      if (window.getSelection()?.isCollapsed) {
        const origin = event.currentTarget.parentElement!.getBoundingClientRect();
        onClickMarkup(event.clientX - origin.left, event.clientY - origin.top);
      }
    }} />
    {empty && marking && <span className="markup-no-text" role="status">No selectable text on this page</span>}
  </>;
}
