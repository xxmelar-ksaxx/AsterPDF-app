import { useEffect, useRef, useState } from 'react';
import { FileText, Home, Plus, X, AppWindow, ExternalLink } from 'lucide-react';

export default function Workspace() {
  const [state, setState] = useState<WorkspaceState>({ tabs: [], activeId: null, dragging: false });
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [error, setError] = useState('');
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; started: boolean } | null>(null);
  useEffect(() => {
    const stop = window.aster.onWorkspaceChanged(setState);
    void window.aster.getWorkspace().then(setState).catch(() => setError('Could not load document tabs.'));
    return stop;
  }, []);
  useEffect(() => {
    strip.current?.querySelector(`[data-tab-id="${state.activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.activeId]);
  useEffect(() => window.aster.onWorkspaceDropHint(point => {
    if (!point || point.y < 0 || point.y > 42 || point.x < 0 || point.x > window.innerWidth) { setDropIndex(null); return; }
    const tabs = [...strip.current?.querySelectorAll<HTMLElement>('[data-tab-id]') || []];
    const found = tabs.findIndex(tab => { const rect = tab.getBoundingClientRect(); return point.x < rect.left + rect.width / 2; });
    const index = found < 0 ? tabs.length : found;
    setDropIndex(index); window.aster.workspaceAction('drop-index', undefined, index);
    const container = strip.current;
    if (container) {
      const bounds = container.getBoundingClientRect();
      if (point.x < bounds.left + 32) container.scrollLeft -= 20;
      else if (point.x > bounds.right - 32) container.scrollLeft += 20;
    }
  }), []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current?.started) {
        window.aster.workspaceAction('drag-end', drag.current.id, true); drag.current = null;
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return <nav className={`document-tabs-bar${state.dragging ? ' is-dragging' : ''}`} aria-label="Documents">
    <div className="document-tabs" role="tablist" ref={strip} onWheel={event => { if (strip.current) strip.current.scrollLeft += event.deltaY; }}>
      {state.tabs.map((tab, index) => <div key={tab.id} data-tab-id={tab.id}
        className={`document-tab${tab.id === state.activeId ? ' active' : ''}${dropIndex === index ? ' drop-before' : ''}${dropIndex === state.tabs.length && index === state.tabs.length - 1 ? ' drop-after' : ''}`}
        onPointerDown={event => {
          if (event.button !== 0 || (event.target as Element).closest('.tab-close, .tab-detach')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: tab.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, started: false };
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.pointer !== event.pointerId) return;
          if (!current.started && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6) {
            current.started = true; window.aster.workspaceAction('drag-start', tab.id);
          }
          if (current.started) window.aster.workspaceAction('drag-move', tab.id);
        }}
        onPointerUp={event => {
          const current = drag.current; drag.current = null;
          if (!current) return;
          if (current.started) window.aster.workspaceAction('drag-end', tab.id);
          else window.aster.workspaceAction('select', tab.id);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { if (drag.current?.started) window.aster.workspaceAction('drag-end', tab.id, true); drag.current = null; }}
        onLostPointerCapture={() => { if (drag.current?.started) window.aster.workspaceAction('drag-end', tab.id, true); drag.current = null; }}>
        <button className="tab-select" role="tab" aria-selected={tab.id === state.activeId} title={tab.path || 'Recently opened files'}
          onClick={event => { if (event.detail === 0) window.aster.workspaceAction('select', tab.id); }}>
          {tab.busy ? <span className="inline-spinner" /> : tab.path ? <FileText size={14} /> : <Home size={14} />}
          <span className="tab-name">{tab.crashed ? `${tab.name} (stopped)` : tab.name}</span>
          {tab.dirty && <span className="tab-dirty" aria-label="Unsaved changes" />}
        </button>
        <button className="tab-detach" aria-label={`Move ${tab.name} to a new window`} title="Move to a new window" onClick={() => window.aster.workspaceAction('detach', tab.id)}><ExternalLink size={12} /></button>
        <button className="tab-close" aria-label={`Close ${tab.name}`} onClick={() => window.aster.workspaceAction('close', tab.id)}><X size={14} /></button>
      </div>)}
    </div>
    <button className="workspace-button" aria-label="New tab" title="New tab (Ctrl/Cmd+T)" onClick={() => window.aster.workspaceAction('new-tab')}><Plus size={17} /></button>
    <button className="workspace-button" aria-label="New window" title="New window (Ctrl/Cmd+Shift+N)" onClick={() => window.aster.workspaceAction('new-window')}><AppWindow size={16} /></button>
    {error && <span role="alert">{error}</span>}
  </nav>;
}
