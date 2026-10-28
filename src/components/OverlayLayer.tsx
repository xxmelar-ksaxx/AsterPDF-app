import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { onFinishInlineEdit } from '../finish-inline-edit';
import { Trash2 } from 'lucide-react';
import { isDrawingObject, textSize, type OverlayKind, type OverlayObject, type TextAppearance } from '../pdf/overlays';
import TextFrame from './TextFrame';
import OriginalTextEditor, { resolveTextFont } from './OriginalTextEditor';
import type { PageViewport } from 'pdfjs-dist';
import type { FontCommand, FontSelection, InstalledFont } from './FontPicker';
import { imagePlacement, resizeImage, type ResizeHandle } from '../pdf/image-geometry';
import { constrainDraw, shapePath } from '../pdf/draw-geometry';
import { textOverlayLayout, textOverlaySize } from './text-overlay-size';
import VideoPlayer from './VideoPlayer';

export type OverlayTool = 'select' | 'eraser' | OverlayKind;
export type PendingImage = { dataUrl: string; aspect: number; videoId?: string; videoFile?: File; name?: string };
type Props = {
  pageId: string; width: number; height: number; scale: number;
  tool: OverlayTool | null; color: string; lineWidth: number;
  drawActive: boolean;
  drawStyle: Pick<OverlayObject, 'fill' | 'fillHidden' | 'opacity' | 'radius'>;
  fontSize: number; fontChoice: OverlayObject['fontChoice']; viewport: PageViewport; fonts: InstalledFont[];
  textAppearance: TextAppearance;
  fontCommand: FontCommand | null; onFontEditChange: (selection: FontSelection | null) => void;
  image: PendingImage | null;
  objects: OverlayObject[]; selectedId: string | null;
  showVideoPlayers?: boolean;
  onAdd: (object: OverlayObject) => void;
  onUpdate: (object: OverlayObject) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string | null) => void;
};
type Gesture = { kind: 'create'; start: { x: number; y: number }; points: { x: number; y: number }[] }
  | { kind: 'move' | 'resize'; start: { x: number; y: number }; original: OverlayObject; handle?: ResizeHandle };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

type TextEdit = { object: OverlayObject; isNew: boolean; value: string };

export default function OverlayLayer({ pageId, width, height, scale, tool, drawActive, color, lineWidth, drawStyle, fontSize, fontChoice, textAppearance, viewport, fonts, fontCommand, onFontEditChange, image,
  objects, selectedId, onAdd, onUpdate, onDelete, onSelect, showVideoPlayers = true }: Props) {
  const layer = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreviewState] = useState<OverlayObject | null>(null);
  const previewRef = useRef<OverlayObject | null>(null);
  const setPreview = (value: OverlayObject | null) => { previewRef.current = value; setPreviewState(value); };
  useEffect(() => { gesture.current = null; setPreview(null); setImageMenu(null); }, [tool, drawActive]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { gesture.current = null; setPreview(null); setImageMenu(null); }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);
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
    fontName: 'Added text', choice: object.fontChoice || 'noto-sans', fontSize: textSize(object), color: object.color,
    appearance: { bold: object.bold, italic: object.italic, underline: object.underline, strikeThrough: object.strikeThrough, textAlign: object.textAlign, textSizing: object.textSizing } });
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
    const updated = { ...current.object, text: current.value,
      ...textOverlaySize({ ...current.object, text: current.value }, width / scale, height / scale, fonts) };
    if (current.isNew) onAdd(updated);
    else {
      const original = objects.find((object) => object.id === updated.id);
      if (!original || original.text !== updated.text || original.fontChoice !== updated.fontChoice ||
        textSize(original) !== textSize(updated) || original.color !== updated.color ||
        original.width !== updated.width || original.height !== updated.height ||
        ['bold', 'italic', 'underline', 'strikeThrough', 'textAlign', 'textSizing'].some((key) => original[key as keyof OverlayObject] !== updated[key as keyof OverlayObject])) onUpdate(updated);
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
    const unsubscribe = onFinishInlineEdit(() => finishText(true));
    return () => { document.removeEventListener('pointerdown', outside); unsubscribe(); };
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
    const next = { ...current, object: { ...current.object, ...textAppearance } };
    editingRef.current = next; setEditing(next);
  }, [textAppearance]);
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
      onAdd({ id: crypto.randomUUID(), pageId, kind: image.videoId ? 'video' : 'image', ...imagePlacement(start, image.aspect, width, height),
        color, lineWidth, image: image.dataUrl, videoId: image.videoId, name: image.name });
      setImageCursor(null);
      return;
    }
    if (tool === 'text') {
      const object: OverlayObject = { id: crypto.randomUUID(), pageId, kind: tool, x: start.x, y: start.y,
        width: Math.min(0.34, 1 - start.x), height: Math.min(0.06, 1 - start.y),
        color, lineWidth, fontSize, fontChoice: fontChoice || 'noto-sans', ...textAppearance, textSizing: 'auto' };
      event.preventDefault(); startEventRef.current = event.nativeEvent; startText(object, true);
      return;
    }
    gesture.current = { kind: 'create', start, points: [start] };
    event.preventDefault(); onSelect(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    let current = point(event, active?.kind !== 'create');
    if (!active) {
      if (tool === 'image' && image) setImageCursor(current);
      if (tool === 'eraser' && event.buttons === 1) {
        const element = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-overlay-id]');
        if (element) onDelete(element.getAttribute('data-overlay-id')!);
      }
      return;
    }
    if (active.kind === 'create') {
      if (event.shiftKey && tool !== 'pen') current = constrainDraw(active.start, current, width, height, tool === 'line');
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
        color, lineWidth, points, ...drawStyle });
    } else {
      const { original, start } = active;
      const dx = current.x - start.x; const dy = current.y - start.y;
      if (Math.hypot(dx * width, dy * height) < 2 && !previewRef.current) return;
      setPreview(active.kind === 'move'
        ? { ...original, x: original.x + dx, y: original.y + dy }
        : { ...original, ...resizeImage(original, active.handle || 'se', dx, dy, event.shiftKey), ...(original.kind === 'text' ? { textSizing: 'fixed' as const } : {}) });
    }
  };
  const end = () => {
    let preview = previewRef.current;
    if (gesture.current?.kind === 'create' && (!preview || preview.width * width + preview.height * height < 8) &&
      (tool === 'rectangle' || tool === 'ellipse' || tool === 'line')) {
      preview = { id: 'preview', pageId, kind: tool, ...gesture.current.start,
        width: 100 * scale / width, height: tool === 'line' ? .001 : 100 * scale / height,
        color, lineWidth, ...drawStyle, points: tool === 'line' ? [{ x: 0, y: 0 }, { x: 1, y: 0 }] : undefined };
    }
    if (gesture.current?.kind === 'create' && preview) {
      if (preview.kind === 'pen' && (preview.points?.length || 0) > 1 || preview.kind !== 'pen' && preview.width * width + preview.height * height > 8) {
        onAdd({ ...preview, id: crypto.randomUUID() });
      }
    } else if (gesture.current && preview) onUpdate(preview);
    gesture.current = null; setPreview(null);
  };
  const beginObject = (event: PointerEvent<SVGElement>, object: OverlayObject, kind: 'move' | 'resize', handle?: ResizeHandle) => {
    event.stopPropagation();
    if (object.locked || !tool || (!drawActive && isDrawingObject(object))) return;
    if (tool === 'eraser' && event.button === 0) { onDelete(object.id); return; }
    if (editingRef.current) finishText(true);
    onSelect(object.id);
    if (event.button !== 0 || tool !== 'select' && !(object.kind === 'text' && tool === 'text')) return;
    event.preventDefault(); window.getSelection()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (object.kind === 'text') object = { ...object, ...textOverlaySize(object, width / scale, height / scale, fonts) };
    gesture.current = { kind, start: point(event, true), original: object, handle };
    layer.current?.setPointerCapture(event.pointerId);
  };
  const render = (object: OverlayObject) => {
    const x = object.x * width; const y = object.y * height;
    const w = object.width * width; const h = object.height * height;
    const sw = Math.max(0, object.lineWidth * scale);
    const common = { stroke: object.color, strokeWidth: sw, fill: 'none' };
    if (object.kind === 'rectangle' || object.kind === 'ellipse') return <path d={shapePath(object.kind, w, h, (object.radius ?? 0) * scale)}
      transform={`translate(${x} ${y})`} {...common} fill={object.fillHidden ? 'none' : object.fill || 'none'} />;
    if (object.kind === 'line') return <line x1={x + (object.points?.[0]?.x || 0) * w} y1={y + (object.points?.[0]?.y || 0) * h}
      x2={x + (object.points?.[1]?.x ?? 1) * w} y2={y + (object.points?.[1]?.y ?? 1) * h} {...common} />;
    if (object.kind === 'pen') return <polyline points={(object.points || []).map((p) => `${x + p.x * w},${y + p.y * h}`).join(' ')}
      {...common} strokeLinecap="round" strokeLinejoin="round" />;
    if (object.kind === 'text') {
      const style = resolveTextFont(object.fontChoice || 'helvetica', '', object.text || '', fonts, object);
      const align = object.textAlign === 'justify' || object.textAlign === 'smart-justify' ? style.arabic ? 'right' : 'left' : object.textAlign || 'left';
      const { lines, lineHeight } = textOverlayLayout(object, width / scale, fonts);
      const textX = x + (align === 'center' ? w / 2 : align === 'right' ? w : 0);
      return <text fill={object.color} xmlSpace="preserve"
        fontSize={textSize(object) * scale} fontFamily={style.family} fontWeight={style.fontWeight} fontStyle={style.fontStyle}
        textDecoration={[object.underline && 'underline', object.strikeThrough && 'line-through'].filter(Boolean).join(' ') || 'none'}
        direction={style.arabic ? 'rtl' : 'ltr'} textAnchor={align === 'center' ? 'middle' : (align === 'right') !== style.arabic ? 'end' : 'start'}>
        {lines.map((line, index) => line.runs ? line.runs.map((run, runIndex) => {
          const rtl = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(run.text);
          return <tspan key={`${index}-${runIndex}`} x={x + run.x * scale} y={y + (textSize(object) + index * lineHeight) * scale}
            direction={rtl ? 'rtl' : 'ltr'} textAnchor={rtl ? 'end' : 'start'}>{run.text}</tspan>;
        }) : <tspan key={index} x={textX} y={y + (textSize(object) + index * lineHeight) * scale}>{line.text}</tspan>)}</text>;
    }
    return <image href={object.image} x={x} y={y} width={w} height={h} preserveAspectRatio="none" />;
  };
  return <><svg ref={layer} className={`overlay-layer${tool === 'select' ? ' overlay-select' : ''}${tool === 'image' ? ' overlay-image' : ''}${tool === 'text' ? ' overlay-text' : ''}${tool && ['pen', 'rectangle', 'ellipse', 'line'].includes(tool) ? ' overlay-drawing' : ''}${tool ? ' overlay-active' : ''}`}
    width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Editable PDF objects"
    onPointerDown={begin} onPointerMove={move} onPointerUp={end}
    onPointerLeave={() => setImageCursor(null)} onDragStart={(event) => event.preventDefault()}
    onPointerCancel={() => { gesture.current = null; setPreview(null); }}>
    {objects.filter((object) => !object.hidden).map((object) => {
      const current = preview?.id === object.id ? preview : object;
      const shown = current.kind === 'text' ? { ...current, ...textOverlaySize(current, width / scale, height / scale, fonts) } : current;
      const readOnly = !tool || (!drawActive && isDrawingObject(object));
      return <g key={object.id} data-overlay-id={object.id} data-overlay-kind={object.kind} className={`overlay-object${object.locked ? ' overlay-locked' : ''}${readOnly ? ' overlay-readonly' : ''}`}
        onContextMenu={(event) => {
          if (object.locked || readOnly || tool !== 'select') return;
          event.preventDefault(); event.stopPropagation(); onSelect(object.id);
          setImageMenu({ id: object.id, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 52)) });
        }}
        onPointerDown={object.kind === 'text' ? undefined : (event) => beginObject(event, object, 'move')}>
        {editing?.object.id !== object.id && <g opacity={shown.opacity ?? 1} pointerEvents={object.kind === 'text' ? 'none' : undefined}>{render(shown)}</g>}
        {!readOnly && (object.kind === 'text' ? editing?.object.id !== object.id && <TextFrame x={shown.x * width} y={shown.y * height}
          width={Math.max(16, shown.width * width)} height={Math.max(16, shown.height * height)} selected={selectedId === object.id}
          onInteriorClick={(event) => { event.stopPropagation(); if (tool === 'eraser') onDelete(object.id); else startText(object, false); }}
          onBorderPointerDown={(event) => beginObject(event, object, 'move')} />
          : <rect x={shown.x * width} y={shown.y * height} width={Math.max(16, shown.width * width)} height={Math.max(16, shown.height * height)}
            fill="transparent" stroke={selectedId === object.id ? '#5c922c' : 'transparent'} strokeDasharray="5 3" strokeWidth="2" />)}
        {!object.locked && !readOnly && editing?.object.id !== object.id && selectedId === object.id && (tool === 'select' || (object.kind === 'text' && tool === 'text')) && <g className="image-resize-frame">
          <title>{object.kind === 'text' ? 'Drag an edge or corner to resize the text container without changing font size.' : 'Drag to move. Drag an edge or corner to resize. Hold Shift to keep proportions.'}</title>
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
      </g>;
    })}
    {preview?.id === 'preview' && <g opacity={preview.opacity ?? 1}>{render(preview)}</g>}
    {tool === 'image' && image && imageCursor && (() => {
      const box = imagePlacement(imageCursor, image.aspect, width, height);
      return <image className="image-placement-preview" href={image.dataUrl} x={box.x * width} y={box.y * height}
        width={box.width * width} height={box.height * height} opacity="0.5" pointerEvents="none" />;
    })()}
  </svg>
    {showVideoPlayers && objects.filter(object => object.kind === 'video' && !object.hidden).map(object =>
      <VideoPlayer key={object.id} object={preview?.id === object.id ? preview : object} width={width} height={height} />)}
    {imageMenu && createPortal(<div className="image-context-menu" role="menu" aria-label="Object actions"
      style={{ left: imageMenu.x, top: imageMenu.y }} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === 'Escape' || event.key === 'Tab') { setImageMenu(null); if (event.key === 'Escape') event.preventDefault(); } }}>
      <button role="menuitem" autoFocus onClick={() => { onDelete(imageMenu.id); setImageMenu(null); }}><Trash2 size={15} />Delete {({ image: 'image', video: 'video' } as Record<string, string>)[objects.find(object => object.id === imageMenu.id)?.kind || ''] || 'object'}</button>
    </div>, document.body)}
    {editing && (() => {
      const object = editing.object, size = textSize(object);
      const x = object.x * width, y = object.y * height + size * scale;
      const origin = viewport.convertToPdfPoint(x, y), right = viewport.convertToPdfPoint(x + scale, y), up = viewport.convertToPdfPoint(x, y - scale);
      return <OriginalTextEditor key={object.id} mask={false} label="Edit text on page" canvas={null} viewport={viewport} fonts={fonts}
        appearance={object} frameWidth={object.textSizing === 'fixed' ? object.width * width : undefined}
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
