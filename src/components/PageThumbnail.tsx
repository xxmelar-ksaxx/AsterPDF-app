import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export default function PageThumbnail({ document, page, rotation = 0, size = 'small' }: { document: PDFDocumentProxy; page: number; rotation?: number; size?: 'small' | 'large' }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '300px' });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) {
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
      return;
    }
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const width = rotation % 180 ? natural.height : natural.width;
      const height = rotation % 180 ? natural.width : natural.height;
      const maxWidth = size === 'large' ? 180 : 44;
      const maxHeight = size === 'large' ? 240 : 58;
      const scale = Math.min(maxWidth / width, maxHeight / height);
      const pixelRatio = size === 'large' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const viewport = pdfPage.getViewport({ scale: scale * pixelRatio, rotation: natural.rotation + rotation });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      task = pdfPage.render({ canvas, canvasContext: context, viewport });
      await (task as ReturnType<typeof pdfPage.render>).promise;
      if (cancelled || !canvasRef.current) return;
      const visibleCanvas = canvasRef.current;
      const visibleContext = visibleCanvas.getContext('2d');
      if (!visibleContext) return;
      visibleCanvas.width = canvas.width;
      visibleCanvas.height = canvas.height;
      visibleContext.drawImage(canvas, 0, 0);
      visibleCanvas.style.width = size === 'large' ? `min(100%, ${viewport.width / pixelRatio}px)` : `${viewport.width / pixelRatio}px`;
      visibleCanvas.style.height = size === 'large' ? 'auto' : `${viewport.height / pixelRatio}px`;
    })().catch(() => {});
    return () => { cancelled = true; task?.cancel(); };
  }, [document, page, rotation, size, visible]);

  return <span className={`page-symbol${size === 'large' ? ' page-symbol-large' : ''}`} ref={rootRef}><canvas ref={canvasRef} aria-hidden="true" /></span>;
}
