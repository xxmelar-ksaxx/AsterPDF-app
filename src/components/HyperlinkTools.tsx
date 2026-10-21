import { useEffect, useRef, useState } from 'react';
import { Copy, Link2, TextSelect, X } from 'lucide-react';
import { normalizeLink } from '../pdf/links';
import type { TextMarkupSelection } from '../pdf/comments';

export function HyperlinkMenu({ x, y, selection, onAdd, onSelectText, onClose }: {
  x: number; y: number; selection: TextMarkupSelection[]; onAdd: () => void; onSelectText: () => void; onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div ref={root} className="hyperlink-menu" role="menu" aria-label="Text options"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 220)), top: Math.max(8, Math.min(y, window.innerHeight - 150)) }}
    onContextMenu={event => event.preventDefault()}>
    <button role="menuitem" autoFocus disabled={!selection.length} onClick={onAdd}><Link2 size={16} />Add hyperlink</button>
    <button role="menuitem" disabled={!selection.length} onClick={() => { void navigator.clipboard.writeText(selection.map(item => item.text).join('\n')).then(onClose).catch(() => {}); }}><Copy size={16} />Copy text</button>
    <button role="menuitem" onClick={onSelectText}><TextSelect size={16} />Select PDF text</button>
  </div>;
}

export function HyperlinkDialog({ selection, onSave, onClose }: {
  selection: TextMarkupSelection[]; onSave: (url: string) => Promise<void>; onClose: () => void;
}) {
  const text = selection.map(item => item.text).join(' ');
  const [url, setUrl] = useState(/^https?:\/\/\S+$/i.test(text.trim()) ? text.trim() : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <div className="modal-backdrop" onKeyDown={event => {
    event.stopPropagation(); if (event.key === 'Escape' && !saving) onClose();
  }}><form className="settings-modal hyperlink-dialog" role="dialog" aria-modal="true" aria-labelledby="hyperlink-title"
    onSubmit={async event => {
      event.preventDefault(); setError('');
      try { const normalized = normalizeLink(url); setSaving(true); await onSave(normalized); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setSaving(false); }
    }}>
    <div className="modal-head"><Link2 size={22} /><button type="button" disabled={saving} aria-label="Close hyperlink dialog" onClick={onClose}><X size={18} /></button></div>
    <h2 id="hyperlink-title">Add hyperlink</h2><p className="hyperlink-selected" dir="auto">{text}</p>
    <label htmlFor="hyperlink-url">Link destination</label><input id="hyperlink-url" autoFocus value={url} disabled={saving}
      placeholder="https://example.com" autoComplete="off" spellCheck={false} onChange={event => setUrl(event.target.value)} />
    {error && <p className="hyperlink-error" role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="button outline" onClick={onClose} disabled={saving}>Cancel</button>
      <button className="button primary" type="submit" disabled={saving || !url.trim()}>{saving ? 'Adding…' : 'Add link'}</button></div>
  </form></div>;
}
