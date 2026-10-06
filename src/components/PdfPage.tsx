import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { PdfComment } from '../pdf/comments';

export type Zoom = 'fit' | number;
export type PageSize = { width: number; height: number };
export type PendingPoint = { page: number; x: number; y: number };

export function pageScale(size: PageSize, zoom: Zoom, viewerWidth: number): number {
  return zoom === 'fit'
    ? Math.max(0.2, Math.min(1.8, (viewerWidth - 96) / size.width))
    : zoom;
}

type Props = {
  document: PDFDocumentProxy;
  pageNumber: number;
  size: PageSize;
  zoom: Zoom;
  viewerWidth: number;
  viewerRef: RefObject<HTMLDivElement | null>;
  comments: PdfComment[];
  selectedId: string | null;
  placing: boolean;
  pendingPoint: PendingPoint | null;
  registerPage: (page: number, element: HTMLDivElement | null) => void;
  onMeasure: (page: number, size: PageSize) => void;
  onPlace: (page: number, x: number, y: number) => void;
  onSelectComment: (id: string) => void;
  onError: (message: string) => void;
};

export default function PdfPage({
  document, pageNumber, size, zoom, viewerWidth, viewerRef, comments, selectedId,
  placing, pendingPoint, registerPage, onMeasure, onPlace, onSelectComment, onError
}: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(false);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [ready, setReady] = useState(false);

  const setSheet = useCallback((element: HTMLDivElement | null) => {
    sheetRef.current = element;
    registerPage(pageNumber, element);
  }, [pageNumber, registerPage]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const sheet = sheetRef.current;
    if (!viewer || !sheet) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: viewer,
      rootMargin: '1000px 0px'
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [viewerRef]);

  useEffect(() => {
    if (!near) {
      setReady(false);
      setViewport(null);
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setReady(false);
    setViewport(null);
    (async () => {
      try {
        const page = await document.getPage(pageNumber);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        onMeasure(pageNumber, { width: natural.width, height: natural.height });
        const currentViewport = page.getViewport({ scale: pageScale(natural, zoom, viewerWidth) });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(currentViewport.width * pixelRatio);
        canvas.height = Math.ceil(currentViewport.height * pixelRatio);
        canvas.style.width = `${currentViewport.width}px`;
        canvas.style.height = `${currentViewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is unavailable.');
        setViewport(currentViewport);
        renderTask = page.render({
          canvas, canvasContext: context, viewport: currentViewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0]
        });
        await renderTask.promise;
        if (!cancelled) setReady(true);
      } catch (cause) {
        if (!cancelled) onError(`Could not render page ${pageNumber}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    };
  }, [document, pageNumber, near, zoom, viewerWidth, onMeasure, onError]);

  const scale = pageScale(size, zoom, viewerWidth);
  const activeViewport = viewport && Math.abs(viewport.width - size.width * scale) < 1
    && Math.abs(viewport.height - size.height * scale) < 1 ? viewport : null;
  const width = activeViewport?.width ?? size.width * scale;
  const height = activeViewport?.height ?? size.height * scale;

  const choosePoint = (event: MouseEvent<HTMLDivElement>) => {
    if (!placing || !activeViewport || !stageRef.current) return;
    const bounds = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(activeViewport.width, event.clientX - bounds.left));
    const y = Math.max(0, Math.min(activeViewport.height, event.clientY - bounds.top));
    const [pdfX, pdfY] = activeViewport.convertToPdfPoint(x, y);
    onPlace(pageNumber, pdfX, pdfY);
  };

  return <div className="page-sheet" data-page-number={pageNumber} ref={setSheet}>
    <span className="page-label">Page {pageNumber}</span>
    <div className={`page-stage ${placing ? 'is-placing' : ''}`} ref={stageRef} onClick={choosePoint} style={{ width, height }}>
      <canvas ref={canvasRef} width={0} height={0} style={{ display: ready && activeViewport ? 'block' : 'none' }} />
      {near && !ready && <span className="page-rendering">Rendering page {pageNumber}…</span>}
      {activeViewport && comments.map((comment) => {
        const first = activeViewport.convertToViewportPoint(comment.rect[0], comment.rect[1]);
        const second = activeViewport.convertToViewportPoint(comment.rect[2], comment.rect[3]);
        return <button key={comment.id} className={`comment-pin ${selectedId === comment.id ? 'selected' : ''} ${comment.draft ? 'draft' : ''}`}
          style={{ left: Math.min(first[0], second[0]), top: Math.min(first[1], second[1]) }}
          title={`${comment.author}: ${comment.text || '(Empty note)'}`}
          onClick={(event) => { event.stopPropagation(); onSelectComment(comment.id); }}>
          <MessageSquare size={14} fill="currentColor" />
        </button>;
      })}
      {activeViewport && pendingPoint?.page === pageNumber && (() => {
        const [left, top] = activeViewport.convertToViewportPoint(pendingPoint.x, pendingPoint.y);
        return <span className="pending-pin" style={{ left, top }}><MessageSquare size={14} fill="currentColor" /></span>;
      })()}
    </div>
  </div>;
}
