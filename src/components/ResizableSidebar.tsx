import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const DEFAULT_WIDTH = 352;
const MIN_WIDTH = 300;
const MAX_WIDTH = 640;
const STORAGE_KEY = 'asterpdf.sidebarWidth';

export default function ResizableSidebar({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const sidebar = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number; preferred: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const [available, setAvailable] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - 400));
  const width = Math.min(preferredWidth, maxWidth);
  const changeWidth = (next: number) => setPreferredWidth(Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, next))));

  useLayoutEffect(() => {
    const workspace = sidebar.current?.parentElement;
    if (!workspace) return;
    const measure = () => setAvailable(workspace.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (resizing) return;
    try { localStorage.setItem(STORAGE_KEY, String(preferredWidth)); } catch { /* Resizing also works without storage. */ }
  }, [preferredWidth, resizing]);
  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add('resizing-sidebar');
    return () => document.body.classList.remove('resizing-sidebar');
  }, [resizing]);
  useEffect(() => {
    if (collapsed) { drag.current = null; setResizing(false); }
  }, [collapsed]);

  return <aside ref={sidebar} className={`sidebar${collapsed ? ' collapsed' : ''}${resizing ? ' resizing' : ''}`}
    style={collapsed ? undefined : { width, minWidth: width }} aria-label="Document sidebar">
    {!collapsed && <div className="sidebar-resize" role="separator" aria-label="Resize feature sidebar" aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width} aria-valuetext={`${width} pixels`} tabIndex={0}
      title="Drag to resize · Double-click to reset"
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = { pointer: event.pointerId, x: event.clientX, width, preferred: preferredWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      onPointerMove={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        changeWidth(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = null; setResizing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (drag.current) setPreferredWidth(drag.current.preferred);
        drag.current = null; setResizing(false);
      }}
      onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
      onDoubleClick={() => changeWidth(DEFAULT_WIDTH)}
      onKeyDown={event => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') changeWidth(width + step);
        else if (event.key === 'ArrowRight') changeWidth(width - step);
        else if (event.key === 'Home') changeWidth(MIN_WIDTH);
        else if (event.key === 'End') changeWidth(maxWidth);
        else if (event.key === 'Escape' && drag.current) {
          setPreferredWidth(drag.current.preferred);
          const pointer = drag.current.pointer;
          drag.current = null; setResizing(false);
          event.currentTarget.releasePointerCapture(pointer);
        } else return;
        event.preventDefault(); event.stopPropagation();
      }} />}
    {children}
  </aside>;
}
