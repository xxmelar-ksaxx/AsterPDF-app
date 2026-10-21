import { useEffect, useState } from 'react';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';

export default function PdfLinks({ pdf, sourcePage, viewport, selecting, onNavigate, onError }: {
  pdf: PDFDocumentProxy; sourcePage: number; viewport: PageViewport; selecting: boolean;
  onNavigate: (sourcePage: number) => void; onError: (message: string) => void;
}) {
  const [links, setLinks] = useState<{ id: string; rect: number[]; url?: string; dest?: string | unknown[]; action?: string }[]>([]);
  const [modifier, setModifier] = useState(false);
  useEffect(() => {
    let cancelled = false; setLinks([]);
    void pdf.getPage(sourcePage).then(page => page.getAnnotations({ intent: 'display' })).then(annotations => {
      if (!cancelled) setLinks(annotations.filter(item => item.annotationType === 2 && (item.url || item.dest || item.action)));
    }).catch(error => { if (!cancelled) onError(`Could not load PDF links: ${String(error)}`); });
    return () => { cancelled = true; };
  }, [pdf, sourcePage, onError]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => setModifier(event.ctrlKey || event.metaKey);
    const clear = () => setModifier(false);
    window.addEventListener('keydown', key); window.addEventListener('keyup', key); window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); window.removeEventListener('blur', clear); };
  }, []);
  const open = async (link: typeof links[number]) => {
    try {
      if (link.url) { await window.aster.openLink(link.url); return; }
      const destination = typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
      if (destination?.length) {
        const target = destination[0];
        const index = typeof target === 'number' ? target : await pdf.getPageIndex(target as { num: number; gen: number });
        if (Number.isInteger(index) && index >= 0 && index < pdf.numPages) onNavigate(index + 1);
      } else {
        const target = { NextPage: sourcePage + 1, PrevPage: sourcePage - 1, FirstPage: 1, LastPage: pdf.numPages }[link.action ?? ''];
        if (target) onNavigate(Math.max(1, Math.min(pdf.numPages, target)));
      }
    } catch (error) { onError(`Could not open link: ${error instanceof Error ? error.message : String(error)}`); }
  };
  return <div className="pdf-links" style={{ pointerEvents: 'none' }}>
    {links.map(link => {
      const [left, top] = viewport.convertToViewportPoint(link.rect[0], link.rect[1]);
      const [right, bottom] = viewport.convertToViewportPoint(link.rect[2], link.rect[3]);
      return <a key={link.id} href={link.url || '#'} className="pdf-link" aria-label={link.url || 'Go to linked page'}
        title={`${link.url || 'Go to linked page'}${selecting ? ' · Ctrl/Cmd+click to follow' : ''}`}
        style={{ left: Math.min(left, right), top: Math.min(top, bottom), width: Math.abs(right - left), height: Math.abs(bottom - top),
          pointerEvents: selecting && !modifier ? 'none' : 'auto' }}
        onDragStart={event => event.preventDefault()}
        onClick={event => { event.preventDefault(); event.stopPropagation(); void open(link); }}
        onAuxClick={event => { event.preventDefault(); if (event.button === 1) void open(link); }} />;
    })}
  </div>;
}
