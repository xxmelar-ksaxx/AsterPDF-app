import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { textSize, type OverlayKind, type OverlayObject } from '../pdf/overlays';
import TextFrame from './TextFrame';
import OriginalTextEditor, { resolveTextFont } from './OriginalTextEditor';
import type { PageViewport } from 'pdfjs-dist';
import type { FontCommand, FontSelection, InstalledFont } from './FontPicker';
import { imagePlacement, resizeImage, type ResizeHandle } from '../pdf/image-geometry';

export type OverlayTool = 'select' | 'eraser' | OverlayKind;
export type PendingImage = { dataUrl: string; aspect: number };
type Props = {
  pageId: string; width: number; height: number; scale: number;
  tool: OverlayTool | null; color: string; lineWidth: number;
  fontSize: number; fontChoice: OverlayObject['fontChoice']; viewport: PageViewport; fonts: InstalledFont[];
  fontCommand: FontCommand | null; onFontEditChange: (selection: FontSelection | null) => void;
  image: PendingImage | null;
  objects: OverlayObject[]; selectedId: string | null;
  onAdd: (object: OverlayObject) => void;
  onUpdate: (object: OverlayObject) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string | null) => void;
};
type Gesture = { kind: 'create'; start: { x: number; y: number }; points: { x: number; y: number }[] }
  | { kind: 'move' | 'resize'; start: { x: number; y: number }; original: OverlayObject; handle?: ResizeHandle };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

type TextEdit = { object: OverlayObject; isNew: boolean; value: string };

export default function OverlayLayer({ pageId, width, height, scale, tool, color, lineWidth, fontSize, fontChoice, viewport, fonts, fontCommand, onFontEditChange, image,
  objects, selectedId, onAdd, onUpdate, onDelete, onSelect }: Props) {
  const layer = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<OverlayObject | null>(null);
  const [imageCursor, setImageCursor] = useState<{ x: number; y: number } | null>(null);
  const [imageMenu, setImageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (imageMenu && (imageMenu.id !== selectedId || !objects.some((object) => object.id === imageMenu.id))) setImageMenu(null);
  }, [selectedId, objects, imageMenu]);
  useEffect(() => {
    if (!imageMenu) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element).closest('.image-context-menu')) setImageMenu(null);
    };
    const close = () => setImageMenu(null);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [imageMenu]);
  useEffect(() => { setImageCursor(null); }, [image, tool]);
  const [editing, setEditing] = useState<TextEdit | null>(null);
  const editingRef = useRef<TextEdit | null>(null);
  const startEventRef = useRef<Event | null>(null);
  const reportTextStyle = (object: OverlayObject) => onFontEditChange({ pageId, index: -1, overlayId: object.id,
    fontName: 'Added text', choice: object.fontChoice || 'noto-sans', fontSize: textSize(object), color: object.color });
  const startText = (object: OverlayObject, isNew: boolean) => {
    const next = { object, isNew, value: isNew ? '' : object.text || '' };
    editingRef.current = next; setEditing(next); onSelect(isNew ? null : object.id);
    reportTextStyle(object);
  };
  const finishText = (commit: boolean) => {
    const current = editingRef.current;
    if (!current) return;
    editingRef.current = null; setEditing(null);
    onFontEditChange(null);
    if (!commit) { onSelect(null); return; }
    if (!current.value.trim()) { if (!current.isNew) onDelete(current.object.id); onSelect(null); return; }
    const size = textSize(current.object);
    const style = resolveTextFont(current.object.fontChoice || 'helvetica', '', current.value, fonts);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${size * scale}px ${style.family}`;
    const metrics = context.measureText(current.value);
    const updated = { ...current.object, text: current.value,
      width: Math.max(0.01, metrics.width / width), height: Math.max(0.01, size * scale * 1.4 / height) };
    if (current.isNew) onAdd(updated);
    else {
      const original = objects.find((object) => object.id === updated.id);
      if (!original || original.text !== updated.text || original.fontChoice !== updated.fontChoice ||
        textSize(original) !== textSize(updated) || original.color !== updated.color) onUpdate(updated);
    }
    onSelect(null);
  };
  useEffect(() => {
    if (!editing) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event === startEventRef.current) return;
      if ((event.target as Element).closest('.added-text-editor, [data-font-picker], [data-added-text-controls]')) return;
      finishText(true);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [editing]);
  useLayoutEffect(() => {
    const current = editingRef.current;
    if (!current || !fontCommand || fontCommand.pageId !== pageId || fontCommand.overlayId !== current.object.id) return;
    const next = { ...current, object: { ...current.object, fontChoice: fontCommand.choice as OverlayObject['fontChoice'] } };
    editingRef.current = next; setEditing(next);
  }, [fontCommand, pageId]);
  useLayoutEffect(() => {
    const current = editingRef.current;
    if (!current) return;
    const next = { ...current, object: { ...current.object, fontSize } };
    editingRef.current = next; setEditing(next);
  }, [fontSize]);
  useLayoutEffect(() => {
    const current = editingRef.current;
    if (!current) return;
    const next = { ...current, object: { ...current.object, color } };
    editingRef.current = next; setEditing(next);
  }, [color]);
  const point = (event: PointerEvent<SVGElement>, unbounded = false) => {
    const bounds = layer.current!.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
    return { x: unbounded ? x : clamp(x), y: unbounded ? y : clamp(y) };
  };
  const begin = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !tool) return;
    // A click away completes this text. It does not also create another draft.
    if (editingRef.current) { finishText(true); return; }
    if (tool === 'select') { onSelect(null); return; }
    if (tool === 'eraser') return;
    const start = point(event);
    if (tool === 'image') {
      if (!image) return;
      event.preventDefault();
      onAdd({ id: crypto.randomUUID(), pageId, kind: 'image', ...imagePlacement(start, image.aspect, width, height),
        color, lineWidth, image: image.dataUrl });
      setImageCursor(null);
      return;
    }
    if (tool === 'text') {
      const object: OverlayObject = { id: crypto.randomUUID(), pageId, kind: tool, x: start.x, y: start.y,
        width: Math.min(0.34, 1 - start.x), height: Math.min(0.06, 1 - start.y),
        color, lineWidth, fontSize, fontChoice: fontChoice || 'noto-sans' };
      event.preventDefault(); startEventRef.current = event.nativeEvent; startText(object, true);
      return;
    }
    gesture.current = { kind: 'create', start, points: [start] };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    const current = point(event, active?.kind !== 'create' && active?.original.kind === 'image');
    if (!active) {
      if (tool === 'image' && image) setImageCursor(current);
      if (tool === 'eraser' && event.buttons === 1) {
        const element = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-overlay-id]');
        if (element) onDelete(element.getAttribute('data-overlay-id')!);
      }
      return;
    }
    if (active.kind === 'create') {
      if (tool === 'pen') active.points.push(current);
      const path = tool === 'pen' ? active.points : [active.start, current];
      const left = Math.min(...path.map((p) => p.x));
      const top = Math.min(...path.map((p) => p.y));
      const boxWidth = Math.max(0.001, Math.max(...path.map((p) => p.x)) - left);
      const boxHeight = Math.max(0.001, Math.max(...path.map((p) => p.y)) - top);
      const points = tool === 'pen' ? active.points.map((p) => ({ x: (p.x - left) / boxWidth, y: (p.y - top) / boxHeight }))
        : tool === 'line' ? [{ x: active.start.x <= current.x ? 0 : 1, y: active.start.y <= current.y ? 0 : 1 },
          { x: active.start.x <= current.x ? 1 : 0, y: active.start.y <= current.y ? 1 : 0 }] : undefined;
      setPreview({ id: 'preview', pageId, kind: tool as OverlayKind, x: left, y: top, width: boxWidth, height: boxHeight,
        color, lineWidth, points });
    } else {
      const { original, start } = active;
      const dx = current.x - start.x; const dy = current.y - start.y;
      setPreview(active.kind === 'move'
        ? { ...original, x: original.kind === 'image' ? original.x + dx : clamp(Math.min(1 - original.width, original.x + dx)),
          y: original.kind === 'image' ? original.y + dy : clamp(Math.min(1 - original.height, original.y + dy)) }
        : original.kind === 'image' ? { ...original, ...resizeImage(original, active.handle || 'se', dx, dy, event.shiftKey) }
        : { ...original, width: Math.max(0.015, Math.min(1 - original.x, original.width + dx)),
          height: Math.max(0.015, Math.min(1 - original.y, original.height + dy)) });
    }
  };
  const end = () => {
    if (gesture.current?.kind === 'create' && preview) {
      if (preview.kind === 'pen' && (preview.points?.length || 0) > 1 || preview.kind !== 'pen' && preview.width * width + preview.height * height > 8) {
        onAdd({ ...preview, id: crypto.randomUUID() });
      }
    } else if (gesture.current && preview) onUpdate(preview);
    gesture.current = null; setPreview(null);
  };
  const beginObject = (event: PointerEvent<SVGElement>, object: OverlayObject, kind: 'move' | 'resize', handle?: ResizeHandle) => {
    event.stopPropagation();
    if (tool === 'eraser' && event.button === 0) { onDelete(object.id); return; }
    onSelect(object.id);
    if (event.button !== 0 || tool !== 'select' && !(object.kind === 'text' && tool === 'text')) return;
    event.preventDefault(); window.getSelection()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    gesture.current = { kind, start: point(event, object.kind === 'image'), original: object, handle };
    layer.current?.setPointerCapture(event.pointerId);
  };
  const render = (object: OverlayObject) => {
    const x = object.x * width; const y = object.y * height;
    const w = object.width * width; const h = object.height * height;
    const sw = Math.max(1, object.lineWidth * scale);
    const common = { stroke: object.color, strokeWidth: sw, fill: 'none' };
    if (object.kind === 'rectangle') return <rect x={x} y={y} width={w} height={h} {...common} />;
    if (object.kind === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    if (object.kind === 'line') return <line x1={x + (object.points?.[0]?.x || 0) * w} y1={y + (object.points?.[0]?.y || 0) * h}
      x2={x + (object.points?.[1]?.x ?? 1) * w} y2={y + (object.points?.[1]?.y ?? 1) * h} {...common} />;
    if (object.kind === 'pen') return <polyline points={(object.points || []).map((p) => `${x + p.x * w},${y + p.y * h}`).join(' ')}
      {...common} strokeLinecap="round" strokeLinejoin="round" />;
    if (object.kind === 'text') {
      const style = resolveTextFont(object.fontChoice || 'helvetica', '', object.text || '', fonts);
      return <text x={x} y={y + textSize(object) * scale} fill={object.color}
        fontSize={textSize(object) * scale} fontFamily={style.family} fontWeight={style.fontWeight} fontStyle={style.fontStyle}
        direction={style.arabic ? 'rtl' : 'ltr'} textAnchor={style.arabic ? 'end' : 'start'}>{object.text}</text>;
    }
    return <image href={object.image} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />;
  };
  return <><svg ref={layer} className={`overlay-layer${tool === 'select' ? ' overlay-select' : ''}${tool === 'image' ? ' overlay-image' : ''}${tool === 'text' ? ' overlay-text' : ''}${tool ? ' overlay-active' : ''}`}
    width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Editable PDF objects"
    onPointerDown={begin} onPointerMove={move} onPointerUp={end}
    onPointerLeave={() => setImageCursor(null)} onDragStart={(event) => event.preventDefault()}
    onPointerCancel={() => { gesture.current = null; setPreview(null); }}>
    {objects.map((object) => {
      const shown = preview?.id === object.id ? preview : object;
      return <g key={object.id} data-overlay-id={object.id} data-overlay-kind={object.kind} className="overlay-object"
        onContextMenu={(event) => {
          if (object.kind !== 'image' || !tool || tool === 'image') return;
          event.preventDefault(); event.stopPropagation(); onSelect(object.id);
          setImageMenu({ id: object.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 52)) });
        }}
        onPointerDown={object.kind === 'text' ? undefined : (event) => beginObject(event, object, 'move')}>
        {editing?.object.id !== object.id && <g pointerEvents={object.kind === 'text' ? 'none' : undefined}>{render(shown)}</g>}
        {object.kind === 'text' ? editing?.object.id !== object.id && <TextFrame x={shown.x * width} y={shown.y * height}
          width={Math.max(16, shown.width * width)} height={Math.max(16, shown.height * height)} selected={selectedId === object.id}
          onInteriorClick={(event) => { event.stopPropagation(); if (tool === 'eraser') onDelete(object.id); else startText(object, false); }}
          onBorderPointerDown={(event) => beginObject(event, object, 'move')} />
          : <rect x={shown.x * width} y={shown.y * height} width={Math.max(16, shown.width * width)} height={Math.max(16, shown.height * height)}
            fill="transparent" stroke={selectedId === object.id ? '#5c922c' : 'transparent'} strokeDasharray="5 3" strokeWidth="2" />}
        {object.kind === 'image' && selectedId === object.id && tool === 'select' && <g className="image-resize-frame">
          <title>Drag the image to move. Drag an edge or corner to resize. Hold Shift to keep proportions.</title>
          {(['n', 'e', 's', 'w'] as const).map((handle) => <rect key={`edge-${handle}`} className={`image-resize-edge resize-${handle}`}
            x={(shown.x + (handle === 'e' ? shown.width : 0)) * width - 4}
            y={(shown.y + (handle === 's' ? shown.height : 0)) * height - 4}
            width={handle === 'n' || handle === 's' ? shown.width * width + 8 : 8}
            height={handle === 'e' || handle === 'w' ? shown.height * height + 8 : 8}
            onPointerDown={(event) => beginObject(event, object, 'resize', handle)} />)}
          {selectedId === object.id && (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => <rect key={handle}
            className={`overlay-resize image-resize-handle resize-${handle}`} data-resize-handle={handle}
            x={(shown.x + (handle.includes('e') ? shown.width : handle.includes('w') ? 0 : shown.width / 2)) * width - 5}
            y={(shown.y + (handle.includes('s') ? shown.height : handle.includes('n') ? 0 : shown.height / 2)) * height - 5}
            width="10" height="10" rx="2" onPointerDown={(event) => beginObject(event, object, 'resize', handle)} />)}
        </g>}
        {object.kind !== 'text' && object.kind !== 'image' && selectedId === object.id && tool === 'select' && <circle className="overlay-resize" cx={(shown.x + shown.width) * width}
          cy={(shown.y + shown.height) * height} r="7" fill="#7fae38" stroke="white" strokeWidth="2"
          onPointerDown={(event) => beginObject(event, object, 'resize')} />}
      </g>;
    })}
    {preview?.id === 'preview' && render(preview)}
    {tool === 'image' && image && imageCursor && (() => {
      const box = imagePlacement(imageCursor, image.aspect, width, height);
      return <image className="image-placement-preview" href={image.dataUrl} x={box.x * width} y={box.y * height}
        width={box.width * width} height={box.height * height} opacity="0.5" pointerEvents="none" />;
    })()}
  </svg>
    {imageMenu && createPortal(<div className="image-context-menu" role="menu" aria-label="Image actions"
      style={{ left: imageMenu.x, top: imageMenu.y }} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === 'Escape' || event.key === 'Tab') { setImageMenu(null); if (event.key === 'Escape') event.preventDefault(); } }}>
      <button role="menuitem" autoFocus onClick={() => { onDelete(imageMenu.id); setImageMenu(null); }}><Trash2 size={15} />Delete image</button>
    </div>, document.body)}
    {editing && (() => {
      const object = editing.object, size = textSize(object);
      const x = object.x * width, y = object.y * height + size * scale;
      const origin = viewport.convertToPdfPoint(x, y), right = viewport.convertToPdfPoint(x + scale, y), up = viewport.convertToPdfPoint(x, y - scale);
      return <OriginalTextEditor key={object.id} mask={false} label="Edit text on page" canvas={null} viewport={viewport} fonts={fonts}
        edit={{ index: -1, text: object.text || '', value: editing.value, box: [0, 0, 0, 0], fontName: '', fontChoice: object.fontChoice || 'helvetica',
          fontSize: size, color: [1, 3, 5].map((offset) => Number.parseInt(object.color.slice(offset, offset + 2), 16)).concat(255),
          matrix: [right[0] - origin[0], right[1] - origin[1], up[0] - origin[0], up[1] - origin[1], ...origin] }}
        onChange={(value) => {
          const current = editingRef.current!;
          const choice = current.object.fontChoice;
          const next = { ...current, value, object: /[\u0600-\u06ff]/u.test(value) && (!choice || choice === 'helvetica' || choice === 'noto-sans')
            ? { ...current.object, fontChoice: 'noto-naskh-arabic' as const } : current.object };
          editingRef.current = next; setEditing(next);
          if (next.object.fontChoice !== choice) reportTextStyle(next.object);
        }} onFinish={finishText} />;
    })()}
  </>;
}
