import { useEffect, useLayoutEffect, useRef } from 'react';

/** Temporary presentation ink. Keep pointer updates out of the PDF render path. */
export default function PresentationInk({ enabled, paths, viewBox }: { enabled: boolean; paths: string[]; viewBox: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const stroke = useRef<{ path: SVGPathElement; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const finish = () => {
    const active = stroke.current;
    stroke.current = null;
    if (!active) return;
    if (!active.moved) active.path.remove();
    else paths.push(active.path.getAttribute('d')!);
    if (svg.current?.hasPointerCapture(active.pointerId)) svg.current.releasePointerCapture(active.pointerId);
  };
  useLayoutEffect(() => {
    svg.current!.replaceChildren();
    for (const data of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data); svg.current!.appendChild(path);
    }
    return finish;
  }, [paths]);
  useEffect(() => {
    if (!enabled) finish();
    window.addEventListener('blur', finish);
    return () => { window.removeEventListener('blur', finish); finish(); };
  }, [enabled]);

  const point = (clientX: number, clientY: number) => new DOMPoint(clientX, clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
  return <svg ref={svg} className="presentation-ink" viewBox={viewBox} preserveAspectRatio="none" aria-hidden="true" style={{ pointerEvents: enabled ? 'auto' : 'none' }}
    onClick={event => event.stopPropagation()}
    onPointerDown={event => {
      if (!enabled || event.button !== 0 || stroke.current) return;
      event.preventDefault(); event.stopPropagation();
      const { x, y } = point(event.clientX, event.clientY);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x} ${y}`);
      event.currentTarget.appendChild(path);
      stroke.current = { path, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const active = stroke.current;
      if (!active || active.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { finish(); return; }
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < 2) return;
      const { x, y } = point(event.clientX, event.clientY);
      active.path.setAttribute('d', `${active.path.getAttribute('d')} L ${x} ${y}`);
      active.x = event.clientX; active.y = event.clientY; active.moved = true;
    }}
    onPointerUp={event => { if (event.pointerId === stroke.current?.pointerId && event.button === 0) finish(); }}
    onPointerCancel={finish} onLostPointerCapture={finish}
    onContextMenu={event => {
      if (!enabled) return;
      event.preventDefault(); event.stopPropagation(); finish();
      paths.length = 0;
      svg.current?.replaceChildren();
    }} />;
}
