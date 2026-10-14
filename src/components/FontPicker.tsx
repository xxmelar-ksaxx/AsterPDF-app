import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Star } from 'lucide-react';
import { createPortal } from 'react-dom';

export type InstalledFont = { id: string; family: string; style: string; postscriptName: string };
export type FontSelection = { pageId: string; index: number; fontName: string; choice: string; overlayId?: string; fontSize?: number; color?: string };
export type ColorCommand = { pageId: string; index: number; color: string; sequence: number };
export type FontCommand = { pageId: string; index: number; choice: string; sequence: number; overlayId?: string };

const BASE_FONTS = [
  { id: 'helvetica', label: 'Helvetica' },
  { id: 'noto-sans', label: 'Noto Sans' },
  { id: 'noto-serif', label: 'Noto Serif' },
  { id: 'noto-naskh-arabic', label: 'Noto Naskh Arabic' }
];
const readIds = (key: string) => {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 50) : []; }
  catch { return []; }
};
const saveIds = (key: string, ids: string[]) => { try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Optional history. */ } };

export default function FontPicker({ selection, fonts, loading, onSelect }: {
  selection: FontSelection | null; fonts: InstalledFont[]; loading: boolean; onSelect: (choice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => readIds('asterpdf-favorite-fonts'));
  const [recent, setRecent] = useState<string[]>(() => readIds('asterpdf-recent-fonts'));
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const search = useRef<HTMLInputElement>(null);
  const options = useMemo(() => [
    ...(selection && !selection.overlayId ? [{ id: 'original', label: `Original: ${selection.fontName.replace(/^[A-Z]{6}\+/, '') || 'unknown'}` }] : []),
    ...BASE_FONTS.filter((font) => font.id !== 'helvetica' || selection?.overlayId),
    ...fonts.map((font) => ({ id: `system:${font.id}`, label: `${font.family}${font.style === 'Regular' ? '' : ` ${font.style}`}` }))
  ], [fonts, selection?.fontName, selection?.overlayId]);
  const labels = useMemo(() => new Map(options.map((option) => [option.id, option.label])), [options]);
  const matching = options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const recentOptions = recent.slice(0, 3).filter((id) => labels.has(id)).map((id) => ({ id, label: labels.get(id)! }));
  const favoriteOptions = favorites.filter((id) => labels.has(id)).map((id) => ({ id, label: labels.get(id)! }));
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const place = () => { const rect = root.current?.getBoundingClientRect(); if (rect)
      setPosition({ left: Math.min(rect.left, window.innerWidth - 300), top: rect.bottom + 5 }); };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = (id: string) => {
    onSelect(id);
    if (id !== 'original') setRecent((old) => { const next = [id, ...old.filter((item) => item !== id)].slice(0, 3);
      saveIds('asterpdf-recent-fonts', next); return next; });
    setOpen(false); setQuery('');
  };
  const toggleFavorite = (id: string) => setFavorites((old) => { const next = old.includes(id) ? old.filter((item) => item !== id) : [id, ...old];
    saveIds('asterpdf-favorite-fonts', next); return next; });
  const rows = (items: typeof options) => items.map((option) => <div className="font-option" key={option.id}>
    <button type="button" className={selection?.choice === option.id ? 'selected' : ''} onClick={() => choose(option.id)}
      title={option.label}>{option.label}</button>
    {option.id !== 'original' && <button type="button" className={`font-star${favorites.includes(option.id) ? ' is-favorite' : ''}`}
      aria-label={`${favorites.includes(option.id) ? 'Remove' : 'Add'} ${option.label} ${favorites.includes(option.id) ? 'from' : 'to'} favorites`}
      title={favorites.includes(option.id) ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleFavorite(option.id)}>
      <Star size={15} fill={favorites.includes(option.id) ? 'currentColor' : 'none'} /></button>}
  </div>);
  return <div className="font-picker" data-font-picker ref={root}>
    <button type="button" className="font-picker-trigger" aria-label="Text font" aria-haspopup="dialog" aria-expanded={open}
      disabled={!selection} title={selection ? 'Choose text font' : 'Select text on a page to change its font'}
      onClick={() => setOpen((value) => !value)}><span>{selection ? labels.get(selection.choice) || selection.fontName : loading ? 'Loading fonts…' : 'Font'}</span><ChevronDown size={14} /></button>
    {open && createPortal(<div className="font-picker-menu" data-font-picker ref={menu} role="dialog" aria-label="Text fonts" style={position}>
      <label className="font-search"><Search size={15} /><input ref={search} type="search" aria-label="Search fonts" placeholder="Search fonts" value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }} /></label>
      <div className="font-picker-scroll">
        {!query && recentOptions.length > 0 && <><div className="font-section-title">Recent</div>{rows(recentOptions)}</>}
        {!query && favoriteOptions.length > 0 && <><div className="font-section-title">Favorites</div>{rows(favoriteOptions)}</>}
        <div className="font-section-title">{query ? 'Search results' : 'All fonts'}</div>
        {loading && <p className="font-empty">Loading system fonts…</p>}
        {matching.length ? rows(matching) : <p className="font-empty">No matching fonts</p>}
      </div>
    </div>, document.body)}
  </div>;
}
