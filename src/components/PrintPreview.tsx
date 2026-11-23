import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';

function selectedPages(range: string, count: number): number[] {
  const selection = new Set<number>();
  for (const part of range.replace(/[–—]/g, '-').split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) return [];
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > count) return [];
    for (let page = first; page <= last; page++) selection.add(page - 1);
  }
  return [...selection].sort((a, b) => a - b);
}

const paper = { A4: [210,297], Letter: [216,279], Legal: [216,356], A3: [297,420] };

export default function PrintPreview({ pages, initialPage, name, onFinish }: {
  pages: readonly string[]; initialPage: number; name: string; onFinish: (job: PrintSelection | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = Math.max(0, Math.min(initialPage - 1, pages.length - 1));
  const [index, setIndex] = useState(current);
  const [printers, setPrinters] = useState<Awaited<ReturnType<typeof window.aster.listPrinters>>>([]);
  const [device, setDevice] = useState('');
  const [printerStatus, setPrinterStatus] = useState('Loading printers…');
  const [refresh, setRefresh] = useState(0);
  const [mode, setMode] = useState('all');
  const [range, setRange] = useState('');
  const [copies, setCopies] = useState('1');
  const [size, setSize] = useState<PrinterSettings['pageSize']>('A4');
  const [landscape, setLandscape] = useState(false);
  const [color, setColor] = useState(true);
  const [duplex, setDuplex] = useState<PrinterSettings['duplexMode']>('simplex');
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setPrinterStatus('Loading printers…');
    window.aster.listPrinters().then(list => {
      if (!active) return;
      setPrinters(list);
      setDevice(previous => list.some(p => p.name === previous) ? previous : list[0]?.name ?? '');
      setPrinterStatus(list.length ? '' : 'No installed printers found.');
    }).catch(() => { if (active) setPrinterStatus('Could not load printers.'); });
    return () => { active = false; };
  }, [refresh]);
  const indices = mode === 'all' ? pages.map((_, i) => i) : mode === 'current' ? [current] : selectedPages(range, pages.length);
  const position = Math.max(0, indices.indexOf(index));
  const shown = indices[position];
  const validCopies = Number.isInteger(Number(copies)) && Number(copies) >= 1 && Number(copies) <= 99;
  const ratio = paper[size][landscape ? 1 : 0] / paper[size][landscape ? 0 : 1];
  function step(delta: number) {
    if (indices.length) setIndex(indices[Math.max(0, Math.min(position + delta, indices.length - 1))]);
  }
  return <dialog ref={dialog} className="print-preview" aria-labelledby="print-preview-title"
    onCancel={event => { event.preventDefault(); onFinish(null); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) &&
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }}>
    <header><h2 id="print-preview-title">Print preview</h2><span>{name}</span></header>
    <div className="print-options-layout"><div className="print-options">
      <label>Printer<select aria-label="Printer" value={device} onChange={e => setDevice(e.target.value)}>
        {!printers.length && <option value="">Select printer</option>}
        {printers.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}</select></label>
      {printerStatus && <p role="status">{printerStatus} {printerStatus !== 'Loading printers…' && <button onClick={() => setRefresh(r => r+1)}>Refresh</button>}</p>}
      <label>Pages<select aria-label="Pages" value={mode} onChange={e => setMode(e.target.value)}>
        <option value="all">All pages</option><option value="current">Current page ({current + 1})</option><option value="custom">Custom range</option></select></label>
      {mode === 'custom' && <label>Page range<input value={range} onChange={e => setRange(e.target.value)} placeholder="1–3, 5" aria-invalid={!!range && !indices.length}/></label>}
      <label>Copies<input type="number" min="1" max="99" value={copies} onChange={e => setCopies(e.target.value)}/></label>
      <label>Paper size<select aria-label="Paper size" value={size} onChange={e => setSize(e.target.value as typeof size)}>{Object.keys(paper).map(s => <option key={s}>{s}</option>)}</select></label>
      <label>Orientation<select aria-label="Orientation" value={landscape ? 'landscape' : 'portrait'} onChange={e => setLandscape(e.target.value === 'landscape')}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <label>Color<select aria-label="Color" value={color ? 'color' : 'gray'} onChange={e => setColor(e.target.value === 'color')}><option value="color">Color</option><option value="gray">Grayscale</option></select></label>
      <label>Sides<select aria-label="Sides" value={duplex} onChange={e => setDuplex(e.target.value as typeof duplex)}><option value="simplex">One-sided</option><option value="longEdge">Two-sided · long edge</option><option value="shortEdge">Two-sided · short edge</option></select></label>
    </div><div className="print-preview-sheet">{shown === undefined ? <p>Enter a page range from 1 to {pages.length}.</p> :
      <img style={{width: `min(100cqw, ${ratio * 100}cqh)`, aspectRatio: ratio, background: 'white', filter: color ? undefined : 'grayscale(1)'}} src={pages[shown]} alt={`Print preview of page ${shown + 1}`}/>}</div></div>
    <footer><nav aria-label="Preview pages"><button className="icon-button" aria-label="Previous preview page" disabled={!position} onClick={() => step(-1)}><ChevronLeft size={18}/></button>
      <span aria-live="polite">{shown === undefined ? 'No pages selected' : `Page ${shown + 1} of ${pages.length}`}</span>
      <button className="icon-button" aria-label="Next preview page" disabled={position >= indices.length-1} onClick={() => step(1)}><ChevronRight size={18}/></button></nav>
      <div><button className="button" onClick={() => onFinish(null)}>Cancel</button><button className="button primary" disabled={!device || !!printerStatus || !validCopies || !indices.length}
        onClick={() => onFinish({ indices, settings: { deviceName: device, copies: Number(copies), landscape, color, pageSize: size, duplexMode: duplex } })}><Printer size={16}/>Print</button></div></footer>
  </dialog>;
}
