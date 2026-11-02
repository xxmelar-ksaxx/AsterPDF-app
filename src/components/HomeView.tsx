import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileText, FolderOpen, LayoutGrid, List, MessageSquare, MoreHorizontal, Pin, PinOff, Search, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import type { RecentPdf } from '../types';

function openedDate(timestamp: number) {
  const date = new Date(timestamp), now = new Date();
  const calendarDay = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const days = Math.max(0, Math.round((calendarDay(now) - calendarDay(date)) / 86400000));
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days} days ago` : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) });
}

type Props = { files: RecentPdf[]; onOpen: () => void; onOpenPath: (path: string) => void; onChange: (files: RecentPdf[]) => void; onError: (message: string) => void };
export default function HomeView({ files, onOpen, onOpenPath, onChange, onError }: Props) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'grid'>(() => { try { return localStorage.getItem('aster-home-view') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } });
  const [menu, setMenu] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0), menuRef = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { try { localStorage.setItem('aster-home-view', view); } catch { /* View preference is optional. */ } }, [view]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); menuTrigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const action = async (file: RecentPdf, kind: 'pin' | 'unpin' | 'remove' | 'reveal') => {
    setMenu(null); setPending(file.path);
    try { onChange(await window.aster.recentAction(file.path, kind)); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(null); }
  };
  const filtered = files.filter(file => file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.openedAt - a.openedAt);
  const groups = [{ title: 'Pinned', files: filtered.filter(file => file.pinned) }, { title: 'Recently opened', files: filtered.filter(file => !file.pinned) }];
  const openButton = <button className="button primary home-open" onClick={onOpen}><FolderOpen size={18} />Open a file</button>;
  return <main className={`home-view${files.length ? '' : ' home-empty'}`} onDragEnter={event => {
    if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDropping(true); }
  }} onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
    onDrop={() => { dragDepth.current = 0; setDropping(false); }}>
    <div className="home-inner">
      <header className="home-header">
        <div className="home-heading"><div className="home-brand"><img src="./icon.png" alt="" /><span>Aster<span>PDF</span></span><span className="home-offline"><ShieldCheck size={13} />Works offline</span></div>
          <h1>{files.length ? 'Your documents' : 'Every detail, in view.'}</h1>
          <p>{files.length ? 'Pick up where you left off.' : 'Read, edit, and make your mark. Your files stay on your device.'}</p></div>
        <div className="home-open-area">{openButton}<span>or drop a file anywhere to open</span></div>
      </header>
      {files.length ? <>
        <div className="home-library-tools">
          <label className="home-search"><Search size={17} /><input type="search" aria-label="Search recent files" placeholder="Search recent files" value={query} onChange={event => { setQuery(event.target.value); setMenu(null); }} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={15} /></button>}</label>
          <div className="home-view-switch" role="group" aria-label="Document view"><button aria-label="List view" title="List view" aria-pressed={view === 'list'} onClick={() => { setView('list'); setMenu(null); }}><List size={18} /></button><button aria-label="Grid view" title="Grid view" aria-pressed={view === 'grid'} onClick={() => { setView('grid'); setMenu(null); }}><LayoutGrid size={17} /></button></div>
        </div>
        {groups.filter(group => group.files.length).map(group => <section className="home-group" key={group.title} aria-label={group.title}>
          <h2>{group.title === 'Pinned' && <Pin size={13} />}{group.title}<span>{group.files.length}</span></h2>
          <div className={`home-files home-files-${view}`}>{group.files.map(file => <article className={`home-file${menu === file.path ? ' menu-open' : ''}`} key={file.path}>
            <button className="home-file-open" onClick={() => onOpenPath(file.path)} aria-label={`Open ${file.name}`} title={file.path}>
              <span className="home-preview">{file.preview ? <img src={file.preview} alt="" loading="lazy" /> : <FileText size={27} strokeWidth={1.3} />}</span>
              <span className="home-file-info"><span className="home-filename"><bdi dir="auto">{file.name.replace(/\.pdf$/i, '')}</bdi><span className="home-extension">.pdf</span></span><span className="home-file-meta">PDF document<span>·</span><time dateTime={new Date(file.openedAt).toISOString()} title={new Date(file.openedAt).toLocaleString()}>{openedDate(file.openedAt)}</time></span></span>
            </button>
            <div className="home-file-actions">
              <button className={`home-pin${file.pinned ? ' is-pinned' : ''}`} aria-label={`${file.pinned ? 'Unpin' : 'Pin'} ${file.name}`} title={file.pinned ? 'Unpin document' : 'Pin document'} disabled={pending !== null} onClick={() => void action(file, file.pinned ? 'unpin' : 'pin')}><Pin size={15} /></button>
              <button aria-label={`Options for ${file.name}`} title="More options" aria-expanded={menu === file.path} onClick={event => { menuTrigger.current = event.currentTarget; setMenu(menu === file.path ? null : file.path); }}><MoreHorizontal size={18} /></button>
            </div>
            {menu === file.path && <div className="home-file-menu" ref={menuRef} aria-label={`Actions for ${file.name}`}>
              <button disabled={pending !== null} onClick={() => void action(file, file.pinned ? 'unpin' : 'pin')}>{file.pinned ? <PinOff size={15} /> : <Pin size={15} />}{file.pinned ? 'Unpin document' : 'Pin document'}</button>
              <button onClick={() => void action(file, 'reveal')}><FolderOpen size={15} />Show in folder</button>
              <button disabled={pending !== null} onClick={() => void action(file, 'remove')}><Trash2 size={15} />Remove from recent</button>
              <small>The file stays on your device.</small>
            </div>}
          </article>)}</div>
        </section>)}
        {!filtered.length && <div className="home-no-results"><Search size={26} /><h2>No matching documents</h2><p>Try another filename or open a file from your device.</p><button className="button outline" onClick={() => setQuery('')}>Clear search</button></div>}
      </> : <div className="home-empty-features"><span><FileText size={18} />Read and edit</span><span><MessageSquare size={18} />Comment and review</span><span><ArrowDownToLine size={18} />Save locally</span></div>}
      <footer className="home-footnote">PDF, Word, PNG, JPEG, and WebP<span>Local files. No uploads.</span></footer>
    </div>
    {dropping && <div className="home-drop-overlay"><div><Upload size={36} /><strong>Drop to open</strong><span>PDF, Word, or an image</span></div></div>}
  </main>;
}
