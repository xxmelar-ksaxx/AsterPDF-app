import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Blend, Circle, Copy, Eye, EyeOff, Image, Layers, Lock, Minus, Pencil, Square, Trash2, Unlock, X, AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter } from 'lucide-react';
import type { OverlayObject } from '../pdf/overlays';
import ColorPicker from './ColorPicker';
import type { CornerRadii } from '../pdf/draw-geometry';

export type DrawStyle = Pick<OverlayObject, 'color' | 'lineWidth' | 'fill' | 'fillHidden' | 'radius' | 'radiusCorners' | 'opacity'>;
export const layerName = (object: OverlayObject) => object.name || ({ rectangle: 'Rectangle', ellipse: 'Ellipse', line: 'Line', pen: 'Pen stroke', image: 'Image', video: 'Video', text: 'Text' }[object.kind]);

export function NumberField({ label, value, mixed = false, min = -100000, max = 100000, icon, unit, onChange, onPreview }: {
  label: string; value: number; mixed?: boolean; min?: number; max?: number; icon?: ReactNode; unit?: string;
  onChange: (value: number) => void; onPreview?: (value: number) => void;
}) {
  const typing = useRef(false);
  const drag = useRef<{ x: number; start: number; value: number; pointerId: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const bound = (next: number) => Math.max(min, Math.min(max, next));
  const format = (next: number) => String(Math.round(next * 10) / 10);
  const [draft, setDraft] = useState(mixed ? '' : format(value));
  useEffect(() => { if (!typing.current && !drag.current) setDraft(mixed ? '' : format(value)); }, [value, mixed]);
  useEffect(() => {
    if (!scrubbing) return;
    document.body.classList.add('draw-value-scrubbing');
    return () => document.body.classList.remove('draw-value-scrubbing');
  }, [scrubbing]);
  const commit = () => {
    typing.current = false;
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next)) { const bounded = bound(next); if (mixed || bounded !== value) onChange(bounded); setDraft(String(bounded)); }
    else setDraft(mixed ? '' : format(value));
  };
  const finishDrag = (cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null; setScrubbing(false);
    const next = cancel ? current.start : current.value;
    setDraft(format(next)); onChange(next);
  };
  return <div className={`draw-number${icon ? ' draw-number-compact' : ''}`} title={icon ? `${label}${unit === '%' ? ' (%)' : ' (pt)'}` : undefined}>
    {icon ? <button type="button" className="draw-number-icon" aria-label={`Adjust ${label.toLowerCase()}`}
      title={`${label}: drag left or right. Shift for fine adjustment.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus();
        window.getSelection()?.removeAllRanges();
        drag.current = { x: event.clientX, start: value, value, pointerId: event.pointerId };
        setScrubbing(true); event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const step = event.shiftKey && unit !== '%' ? .1 : 1;
        const pixelsPerStep = event.shiftKey && unit === '%' ? 10 : 2;
        const next = bound(Math.round((current.start + Math.trunc((event.clientX - current.x) / pixelsPerStep) * step) * 10) / 10);
        if (next === current.value) return;
        current.value = next; setDraft(format(next)); (onPreview ?? onChange)(next);
      }} onPointerUp={(event) => {
        finishDrag();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => finishDrag()} onLostPointerCapture={() => finishDrag()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); finishDrag(true); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation();
          onChange(bound(value + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey && unit !== '%' ? .1 : 1)));
        }
      }}>{icon}</button> : <span>{label}</span>}<input type="number" aria-label={label} value={draft} placeholder={mixed ? 'Mixed' : undefined} min={min} max={max} step="1"
    onFocus={() => { typing.current = true; }} onChange={(event) => {
      const text = event.target.value;
      setDraft(text);
      if (text.trim() && Number.isFinite(Number(text))) {
        const next = bound(Number(text));
        if (mixed || next !== value) onChange(next);
      }
    }} onBlur={commit} onKeyDown={(event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') { setDraft(mixed ? '' : format(value)); event.stopPropagation(); }
    }} />{unit && <span className="draw-number-unit" aria-hidden="true">{unit}</span>}</div>;
}

type Props = {
  objects: OverlayObject[]; selected: OverlayObject | undefined; page: number; pageWidth: number; pageHeight: number;
  style: DrawStyle; recent: string[]; busy: boolean;
  onStyle: (patch: Partial<DrawStyle>, commit?: boolean) => void;
  onUpdate: (object: OverlayObject) => void; onSelect: (id: string) => void;
  onDelete: (id: string) => void; onDuplicate: () => void;
  onOrder: (id: string, direction: 'forward' | 'backward' | string) => void; onClose: () => void;
};

export default function DrawInspector({ objects, selected, page, pageWidth, pageHeight, style, recent, busy,
  onStyle, onUpdate, onSelect, onDelete, onDuplicate, onOrder, onClose }: Props) {
  const dragId = useRef<string | null>(null);
  const [cornersExpanded, setCornersExpanded] = useState(false);
  const radii: CornerRadii = style.radiusCorners ?? [style.radius ?? 0, style.radius ?? 0, style.radius ?? 0, style.radius ?? 0];
  const radiusIcon = (rotation = 0) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ transform: `rotate(${rotation}deg)` }}><path d="M5 20V12a7 7 0 0 1 7-7h8" /></svg>;
  const setCorner = (index: number, value: number, commit = true) => {
    const next = [...radii] as CornerRadii; next[index] = value;
    onStyle({ radiusCorners: next }, commit);
  };
  const paintMemory = useRef(new Map<string, { lineWidth?: number }>());
  const fillColor = style.fill ?? '#e7f0d9';
  const fillVisible = Boolean(style.fill) && !style.fillHidden;
  const togglePaint = (paint: 'fill' | 'stroke') => {
    const key = selected?.id ?? 'defaults';
    const previous = paintMemory.current.get(key) ?? {};
    if (paint === 'fill') {
      onStyle({ fill: fillColor, fillHidden: fillVisible });
    } else {
      if (style.lineWidth > 0) paintMemory.current.set(key, { ...previous, lineWidth: style.lineWidth });
      onStyle({ lineWidth: style.lineWidth > 0 ? 0 : previous.lineWidth ?? 2 });
    }
  };
  const [dropId, setDropId] = useState<string | null>(null);
  const [name, setName] = useState(selected ? layerName(selected) : '');
  useEffect(() => { setName(selected ? layerName(selected) : ''); }, [selected?.id, selected?.name]);
  const shape = !selected || selected.kind === 'rectangle' || selected.kind === 'ellipse';
  const colors = selected?.kind !== 'image';
  return <div className="draw-inspector" aria-label="Drawing properties and layers">
    <div className="sidebar-heading"><div><h2>Draw</h2><p>{selected ? layerName(selected) : 'Create something on the page'}</p></div>
      <button className="icon-button" onClick={onClose} title="Hide drawing panel" aria-label="Hide drawing panel"><X size={17} /></button></div>
    <div className="draw-inspector-scroll">
      <fieldset disabled={busy || selected?.locked} className="draw-properties">
        {selected ? <>
          <div className="draw-section-title"><h3>Selection</h3><span>pt</span></div>
          <label className="draw-name">Name<input aria-label="Layer name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)}
            onBlur={() => { if (name.trim() !== selected.name && name.trim() !== layerName(selected)) onUpdate({ ...selected, name: name.trim() || undefined }); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
          <div className="draw-number-grid">
            {(['x', 'y', 'width', 'height'] as const).map((key) => {
              const extent = key === 'x' || key === 'width' ? pageWidth : pageHeight;
              return <NumberField key={key} label={{ x: 'X', y: 'Y', width: 'Width', height: 'Height' }[key]}
                value={selected[key] * extent} min={key === 'width' || key === 'height' ? 1 : -100000}
                onChange={(value) => onUpdate({ ...selected, [key]: value / extent })} />;
            })}
          </div>
          <div className="draw-actions">
            <button title="Center horizontally on page" aria-label="Center horizontally" onClick={() => onUpdate({ ...selected, x: (1 - selected.width) / 2 })}><AlignHorizontalJustifyCenter size={17} /></button>
            <button title="Center vertically on page" aria-label="Center vertically" onClick={() => onUpdate({ ...selected, y: (1 - selected.height) / 2 })}><AlignVerticalJustifyCenter size={17} /></button>
            <span />
            <button title="Duplicate (Ctrl/Cmd+D)" aria-label="Duplicate drawing" onClick={onDuplicate}><Copy size={16} /></button>
            <button title="Delete" aria-label="Delete drawing" onClick={() => onDelete(selected.id)}><Trash2 size={16} /></button>
          </div>
        </> : <div className="draw-empty-hint"><Square size={22} /><p>Choose a tool, then click or drag on the page.</p><small>V select · R rectangle · O ellipse · L line · P pen</small></div>}
        <div className="draw-section-title"><h3>{selected ? 'Appearance' : 'New shape style'}</h3></div>
        {shape && <div className="draw-paint-row"><button type="button" className="draw-paint-toggle" aria-label={fillVisible ? 'Hide fill' : 'Show fill'}
          title={fillVisible ? 'Hide fill' : 'Show fill'} aria-pressed={fillVisible} onClick={() => togglePaint('fill')}>
          {fillVisible ? <Eye size={16} /> : <EyeOff size={16} />}</button><span className="draw-paint-label">Fill</span>
          <code>{fillColor.toUpperCase()}</code><ColorPicker label="Fill color" value={fillColor} recent={recent}
            onChange={(value, commit) => onStyle({ fill: value, fillHidden: !fillVisible }, commit)} /></div>}
        {colors && <div className="draw-paint-row"><button type="button" className="draw-paint-toggle" aria-label={style.lineWidth > 0 ? 'Hide stroke' : 'Show stroke'}
          title={style.lineWidth > 0 ? 'Hide stroke' : 'Show stroke'} aria-pressed={style.lineWidth > 0} onClick={() => togglePaint('stroke')}>
          {style.lineWidth > 0 ? <Eye size={16} /> : <EyeOff size={16} />}</button><span className="draw-paint-label">Stroke</span><code>{style.color.toUpperCase()}</code>
          <ColorPicker label="Stroke color" value={style.color} recent={recent} onChange={(value, commit) => onStyle({ color: value }, commit)} /></div>}
        <div className="draw-appearance-grid">
          {colors && <NumberField label="Stroke width" icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 5h16" /><path d="M4 12h16" strokeWidth="2" /><path d="M4 19h16" strokeWidth="3" /></svg>}
            value={style.lineWidth} min={0} max={100} onChange={(value) => onStyle({ lineWidth: value })} onPreview={(value) => onStyle({ lineWidth: value }, false)} />}
          {(!selected || selected.kind === 'rectangle') && <div className="draw-radius-control"><NumberField label="Corner radius" icon={radiusIcon()}
            value={radii[0]} mixed={radii.some(value => value !== radii[0])} min={0} max={1000}
            onChange={(value) => onStyle({ radius: value, radiusCorners: undefined })} onPreview={(value) => onStyle({ radius: value, radiusCorners: undefined }, false)} />
            <button type="button" className="draw-radius-expand" aria-label="Individual corner radii" title="Individual corner radii" aria-expanded={cornersExpanded} onClick={() => setCornersExpanded(!cornersExpanded)}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" style={{ transform: cornersExpanded ? 'rotate(180deg)' : undefined }}><path d="m3 4 3 3 3-3" /></svg>
            </button></div>}
          <NumberField label="Opacity" icon={<Blend size={14} />} unit="%" value={Math.round((style.opacity ?? 1) * 100)} min={0} max={100} onChange={(value) => onStyle({ opacity: value / 100 })} onPreview={(value) => onStyle({ opacity: value / 100 }, false)} />
        </div>
        {cornersExpanded && (!selected || selected.kind === 'rectangle') && <div className="draw-corner-grid" aria-label="Individual corner radii">
          {[0, 1, 3, 2].map(index => <NumberField key={index} label={`${['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'][index]} radius`}
            icon={radiusIcon(index * 90)} value={radii[index]} min={0} max={1000}
            onChange={value => setCorner(index, value)} onPreview={value => setCorner(index, value, false)} />)}
        </div>}
        {selected?.locked && <p className="draw-lock-hint">Unlock this layer to edit its properties.</p>}
      </fieldset>
      <section className="draw-layers" aria-label="Drawing layers">
        <div className="draw-section-title"><h3><Layers size={15} />Layers</h3><span>Page {page} · {objects.length}</span></div>
        <p className="draw-layer-hint">Top layer is in front. Drag to reorder.</p>
        {!objects.length && <p className="draw-layer-empty">Your shapes and images will appear here.</p>}
        {[...objects].reverse().map((object) => {
          const Icon = { rectangle: Square, ellipse: Circle, line: Minus, pen: Pencil, image: Image, video: Image, text: Pencil }[object.kind];
          return <div key={object.id} data-layer-id={object.id} className={`draw-layer${object.id === selected?.id ? ' selected' : ''}${object.hidden ? ' hidden-layer' : ''}${dropId === object.id ? ' drop-target' : ''}`}
            draggable={!busy && !object.locked} onDragStart={(event) => { dragId.current = object.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', object.id); }}
            onDragOver={(event) => { if (dragId.current && dragId.current !== object.id) { event.preventDefault(); setDropId(object.id); } }}
            onDrop={(event) => { if (dragId.current) { event.preventDefault(); event.stopPropagation(); onOrder(dragId.current, object.id); } dragId.current = null; setDropId(null); }}
            onDragEnd={() => { dragId.current = null; setDropId(null); }}>
            <button className="draw-layer-select" aria-label={`Select layer ${layerName(object)}`} aria-pressed={object.id === selected?.id} disabled={busy} onClick={() => onSelect(object.id)}><Icon size={15} /><span>{layerName(object)}</span></button>
            <button className="draw-layer-toggle" title={object.hidden ? 'Show layer' : 'Hide layer'} aria-label={`${object.hidden ? 'Show' : 'Hide'} layer ${layerName(object)}`} disabled={busy}
              onClick={() => onUpdate({ ...object, hidden: !object.hidden })}>{object.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button className="draw-layer-toggle" title={object.locked ? 'Unlock layer' : 'Lock layer'} aria-label={`${object.locked ? 'Unlock' : 'Lock'} layer ${layerName(object)}`} disabled={busy}
              onClick={() => onUpdate({ ...object, locked: !object.locked })}>{object.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
          </div>;
        })}
        {selected && <div className="draw-order"><button disabled={busy || selected.locked || objects.at(-1)?.id === selected.id} onClick={() => onOrder(selected.id, 'forward')}><ArrowUp size={14} />Bring forward</button>
          <button disabled={busy || selected.locked || objects[0]?.id === selected.id} onClick={() => onOrder(selected.id, 'backward')}><ArrowDown size={14} />Send backward</button></div>}
      </section>
    </div>
    <div className="draw-panel-footer">Shift constrains proportions · Esc deselects<br />Save PDF to keep your changes.</div>
  </div>;
}
