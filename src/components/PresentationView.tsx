import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnnotationMode, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import type { PlannedPage } from '../pdf/page-plan';
import type { OverlayObject } from '../pdf/overlays';
import type { PlacedSignature } from '../signatures/library';
import type { InstalledFont } from './FontPicker';
import OverlayLayer from './OverlayLayer';
import VideoPlayer from './VideoPlayer';

const noop = () => {};
export default function PresentationView({ pdf, pages, initialPage, objects, signatures, fonts, onExit }: {
  pdf: PDFDocumentProxy; pages: PlannedPage[]; initialPage: number; objects: OverlayObject[];
  signatures: PlacedSignature[]; fonts: InstalledFont[]; onExit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(() => Math.max(0, Math.min(pages.length - 1, initialPage - 1)));
  const [bounds, setBounds] = useState({ width: innerWidth, height: innerHeight });
  const [slide, setSlide] = useState<{ page: PlannedPage; viewport: PageViewport; index: number } | null>(null);
  const [error, setError] = useState('');
  const [cursorVisible, setCursorVisible] = useState(false);
  const [laserEnabled, setLaserEnabled] = useState(false);
  const laser = useRef<HTMLSpanElement>(null);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastWheel = useRef(0);
  const advance = (step: number) => setIndex(value => Math.max(0, Math.min(pages.length - 1, value + step)));

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal(); element.focus();
    const observer = new ResizeObserver(() => setBounds({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => { observer.disconnect(); element.close(); clearTimeout(cursorTimer.current); };
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      // Keep native media controls usable; page navigation remains available
      // with Page Up/Down, and L/Escape always control the presentation.
      if (event.target instanceof Element && event.target.closest('.pdf-video') &&
          !['Escape', 'PageUp', 'PageDown', 'l'].includes(event.key.toLowerCase() === 'l' ? 'l' : event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') onExit();
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'l') { if (!event.repeat) setLaserEnabled(value => !value); }
      else if (['ArrowRight', 'ArrowDown', 'PageDown', 'Enter'].includes(event.key)) advance(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) advance(-1);
      else if (event.key === ' ') advance(event.shiftKey ? -1 : 1);
      else if (event.key === 'Home') setIndex(0);
      else if (event.key === 'End') setIndex(pages.length - 1);
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [pages.length, onExit]);
  useEffect(() => {
    const hide = () => { if (laser.current) laser.current.style.visibility = 'hidden'; };
    window.addEventListener('blur', hide);
    return () => window.removeEventListener('blur', hide);
  }, []);
  useEffect(() => {
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setError('');
    void (async () => {
      try {
        const planned = pages[index];
        const page = await pdf.getPage(planned.sourceIndex + 1);
        if (cancelled) return;
        const rotation = page.rotate + planned.turns * 90;
        const natural = page.getViewport({ scale: 1, rotation });
        const scale = Math.min(bounds.width / natural.width, bounds.height / natural.height);
        if (!(scale > 0)) return;
        const viewport = page.getViewport({ scale, rotation });
        const canvas = document.createElement('canvas');
        const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        render = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport,
          transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: AnnotationMode.DISABLE });
        await render.promise;
        if (cancelled) return;
        // Swap only when ready: navigation never clears the current slide.
        canvasHost.current?.replaceChildren(canvas);
        setSlide({ page: planned, viewport, index });
      } catch (cause) {
        if (!cancelled) setError(`Could not display page ${index + 1}. Press Escape to return to the document.`);
      }
    })();
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pages, index, bounds.width, bounds.height]);

  return <dialog ref={dialog} className={`presentation-view${cursorVisible ? ' cursor-visible' : ''}${laserEnabled ? ' laser-enabled' : ''}`} aria-label="PDF presentation" tabIndex={-1}
    onCancel={event => { event.preventDefault(); onExit(); }}
    onClick={() => { if (!laserEnabled) advance(1); }} onContextMenu={event => { event.preventDefault(); if (!laserEnabled) advance(-1); }}
    onPointerLeave={() => { if (laser.current) laser.current.style.visibility = 'hidden'; }}
    onPointerMove={event => {
      // Move just the dot, without rerendering the slide or its artwork.
      if (laser.current) {
        laser.current.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
        laser.current.style.visibility = 'visible';
      }
      setCursorVisible(true); clearTimeout(cursorTimer.current); cursorTimer.current = setTimeout(() => setCursorVisible(false), 1500);
    }}
    onWheel={event => { if (Math.abs(event.deltaY) < 10 || Date.now() - lastWheel.current < 350) return; lastWheel.current = Date.now(); advance(event.deltaY > 0 ? 1 : -1); }}>
    <div className="presentation-slide" data-page={slide ? slide.index + 1 : undefined}
      style={slide ? { width: slide.viewport.width, height: slide.viewport.height } : undefined}>
      <div ref={canvasHost} />
      {slide && <div className="presentation-artwork" inert>
        <OverlayLayer key={slide.page.id} pageId={slide.page.id} width={slide.viewport.width} height={slide.viewport.height}
          scale={slide.viewport.scale} viewport={slide.viewport} fonts={fonts} objects={objects.filter(object => object.pageId === slide.page.id)}
          tool={null} drawActive={false} selectedId={null} image={null} fontCommand={null} onFontEditChange={noop}
          showVideoPlayers={false}
          color="#000000" lineWidth={1} drawStyle={{}} fontSize={16} fontChoice="helvetica" textAppearance={{}}
          onAdd={noop} onUpdate={noop} onDelete={noop} onSelect={noop} />
        {signatures.filter(signature => signature.pageId === slide.page.id).map(signature => <img key={signature.id}
          className="presentation-signature" src={signature.dataUrl} alt="Signature" draggable={false}
          style={{ left: `${signature.x * 100}%`, top: `${signature.y * 100}%`, width: `${signature.width * 100}%`, height: `${signature.height * 100}%` }} />)}
      </div>}
      {slide && objects.filter(object => object.kind === 'video' && !object.hidden && object.pageId === slide.page.id).map(object =>
        <VideoPlayer key={`${slide.page.id}-${object.id}`} object={object} width={slide.viewport.width} height={slide.viewport.height} />)}
    </div>
    <span ref={laser} className="presentation-laser" hidden={!laserEnabled} aria-hidden="true" />
    <span className="presentation-announcement" aria-live="polite">Page {slide ? slide.index + 1 : index + 1} of {pages.length}. Use arrow keys to navigate. Laser pointer {laserEnabled ? 'on' : 'off'}; press L to toggle. Escape exits presentation.</span>
    {error && <p className="presentation-error" role="alert">{error}</p>}
  </dialog>;
}
