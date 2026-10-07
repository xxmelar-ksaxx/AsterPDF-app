import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export default function PageThumbnail({ document, page, rotation = 0 }: { document: PDFDocumentProxy; page: number; rotation?: number }) {
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
    if (!visible) return;
    let cancelled = false;
    let task: { cancel(): void } | undefined;
    (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const width = rotation % 180 ? natural.height : natural.width;
      const height = rotation % 180 ? natural.width : natural.height;
      const viewport = pdfPage.getViewport({ scale: Math.min(44 / width, 58 / height), rotation: natural.rotation + rotation });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) return;
      task = pdfPage.render({ canvas, canvasContext: context, viewport });
      await (task as ReturnType<typeof pdfPage.render>).promise;
    })().catch(() => {});
    return () => { cancelled = true; task?.cancel(); };
  }, [document, page, rotation, visible]);

  return <span className="page-symbol" ref={rootRef}><canvas ref={canvasRef} aria-hidden="true" /></span>;
}
