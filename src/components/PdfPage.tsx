import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { MessageSquare } from 'lucide-react';
import { onFinishInlineEdit } from '../finish-inline-edit';
import { AnnotationType, OPS, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist';
import { markupKind, readPageComments, type PdfComment } from '../pdf/comments';
import type { PlacedSignature, SavedSignature } from '../signatures/library';
import OverlayLayer, { type OverlayTool, type PendingImage } from './OverlayLayer';
import type { OverlayObject, TextAppearance } from '../pdf/overlays';
import TextFrame from './TextFrame';
import CommentPin from './CommentPin';
import CommentMarkup, { markupAtPoint } from './CommentMarkup';
import PdfTextSelection, { registerSelectionPage, selectedPdfText } from './PdfTextSelection';
import PdfLinks from './PdfLinks';
import type { TextMarkupSelection } from '../pdf/comments';
import type { ColorCommand, FontCommand, FontSelection, InstalledFont } from './FontPicker';
import type { OriginalPdfText } from '../types';
import OriginalTextEditor, { type TextEdit } from './OriginalTextEditor';
import OriginalObjectLayer from './OriginalObjectLayer';
import type { OriginalObjectChange, OriginalObjectSelection } from '../types';

export type Zoom = 'fit' | number;
export type PageSize = { width: number; height: number };
export type PendingPoint = { page: number; x: number; y: number; replyTo?: string };

export function pageScale(size: PageSize, zoom: Zoom, viewerWidth: number): number {
  return zoom === 'fit'
    ? Math.max(0.2, Math.min(1.8, (viewerWidth - 96) / size.width))
    : zoom;
}

type Props = {
  document: PDFDocumentProxy;
  onRenderSettled?: (document: PDFDocumentProxy, page: number) => void;
  getSourceBytes: () => Uint8Array;
  inspectOriginalText: boolean;
  objectEditingBusy: boolean;
  originalObjectSelection: OriginalObjectSelection | null;
  onSelectOriginalObject: (selection: OriginalObjectSelection | null) => void;
  onEditOriginalObject: (selection: OriginalObjectSelection, change: OriginalObjectChange) => Promise<void>;
  onCommitOriginalText: (pageIndex: number, objectIndex: number, oldText: string, nextText: string, fontChoice: string, color?: number[]) => Promise<void>;
  onFontEditChange: (selection: FontSelection | null) => void;
  fontCommand: FontCommand | null;
  colorCommand: ColorCommand | null;
  installedFonts: InstalledFont[];
  onMoveOriginalText: (pageIndex: number, objectIndex: number, text: string, dx: number, dy: number) => Promise<void>;
  pageNumber: number;
  sourcePageNumber: number;
  rotation: number;
  size: PageSize;
  zoom: Zoom;
  viewerWidth: number;
  viewerRef: RefObject<HTMLDivElement | null>;
  comments: PdfComment[];
  selectedId: string | null;
  popupCommentId: string | null;
  onCloseComment: () => void;
  onOpenCommentSidebar: (id: string) => void;
  commentsActive: boolean;
  markingText: boolean;
  selectingLinks: boolean;
  editActive: boolean;
  onLinkMenu: (x: number, y: number, selection: TextMarkupSelection[]) => void;
  onNavigateLink: (sourcePage: number) => void;
  onCommentColor: (comment: PdfComment, color: string, remember?: boolean) => void;
  onAddMarkupComment: (comment: PdfComment) => void;
  onDeleteMarkup: (comment: PdfComment) => void;
  onReplyComment: (comment: PdfComment) => void;
  recentColors: string[];
  commentEditingDisabled: boolean;
  placing: boolean;
  pendingPoint: PendingPoint | null;
  pageId: string;
  signatures: PlacedSignature[];
  selectedSignatureId: string | null;
  placingSignature: SavedSignature | null;
  registerPage: (page: number, element: HTMLDivElement | null) => void;
  onMeasure: (page: number, size: PageSize) => void;
  onPlace: (page: number, x: number, y: number) => void;
  onSelectComment: (id: string) => void;
  onAddSignature: (pageId: string, placement: Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'>) => void;
  onUpdateSignature: (id: string, placement: Pick<PlacedSignature, 'x' | 'y' | 'width' | 'height'>) => void;
  onSelectSignature: (id: string | null) => void;
  onDeleteSignature: (id: string) => void;
  overlayTool: OverlayTool | null;
  drawActive: boolean;
  overlayColor: string;
  overlayLineWidth: number;
  drawStyle: Pick<OverlayObject, 'fill' | 'fillHidden' | 'opacity' | 'radius'>;
  overlayFontSize: number;
  textAppearance: TextAppearance;
  overlayFontChoice: OverlayObject['fontChoice'];
  overlayImage: PendingImage | null;
  overlays: OverlayObject[];
  selectedOverlayId: string | null;
  onAddOverlay: (object: OverlayObject) => void;
  onUpdateOverlay: (object: OverlayObject) => void;
  onDeleteOverlay: (id: string) => void;
  onSelectOverlay: (id: string | null) => void;
  onError: (message: string) => void;
};

export default function PdfPage({
  document, getSourceBytes, inspectOriginalText, objectEditingBusy, originalObjectSelection, onSelectOriginalObject, onEditOriginalObject, onCommitOriginalText, onMoveOriginalText, onFontEditChange, fontCommand, colorCommand, installedFonts, pageNumber, sourcePageNumber, rotation, size, zoom, viewerWidth, viewerRef, comments, selectedId,
  popupCommentId, onCloseComment, onOpenCommentSidebar, commentsActive, markingText, selectingLinks, editActive, onLinkMenu, onNavigateLink, onCommentColor, onAddMarkupComment, onDeleteMarkup, onReplyComment, recentColors, commentEditingDisabled,
  placing, pendingPoint, pageId, signatures, selectedSignatureId, placingSignature,
  registerPage, onMeasure, onPlace, onSelectComment, onAddSignature, onUpdateSignature, onSelectSignature, onDeleteSignature,
  overlayTool, drawActive, overlayColor, overlayLineWidth, drawStyle, overlayFontSize, textAppearance, overlayFontChoice, overlayImage, overlays, selectedOverlayId,
  onAddOverlay, onUpdateOverlay, onDeleteOverlay, onSelectOverlay, onError, onRenderSettled
}: Props) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(false);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [ready, setReady] = useState(false);
  const [originalText, setOriginalText] = useState<OriginalPdfText[]>([]);
  const [editingOriginal, setEditingOriginal] = useState<TextEdit | null>(null);
  const editingOriginalRef = useRef<typeof editingOriginal>(null);
  const originalDragRef = useRef<{ index: number; text: string; startX: number; startY: number } | null>(null);
  const [originalDrag, setOriginalDrag] = useState<{ index: number; dx: number; dy: number } | null>(null);
  const [signatureCursor, setSignatureCursor] = useState<{ x: number; y: number } | null>(null);
  const [signatureMenu, setSignatureMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; placement: PlacedSignature } | null>(null);

  useEffect(() => { if (signatureMenu && selectedSignatureId !== signatureMenu.id) setSignatureMenu(null); }, [signatureMenu, selectedSignatureId]);
  useEffect(() => {
    if (!inspectOriginalText || !near) { setOriginalText([]); return; }
    let cancelled = false;
    window.aster.listOriginalText(getSourceBytes(), sourcePageNumber - 1).then((objects) => {
      if (!cancelled) setOriginalText(objects.filter((object) => !/[\r\n]/.test(object.text) && !/^[•●○◦▪▫■□◆◇‣⁃∙·➢➤✓✔]$/u.test(object.text.trim())));
    }).catch((cause) => { if (!cancelled) onError(`Could not inspect original text on page ${pageNumber}: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { cancelled = true; };
  }, [inspectOriginalText, near, getSourceBytes, sourcePageNumber, pageNumber, onError]);
  const finishOriginalText = (commit: boolean) => {
    const current = editingOriginalRef.current;
    if (!current) return;
    editingOriginalRef.current = null; setEditingOriginal(null); onFontEditChange(null);
    const original = originalText.find((object) => object.index === current.index);
    const colorChanged = original && current.color.some((value, index) => value !== original.color[index]);
    if (commit && (current.value !== current.text || current.fontChoice !== 'original' || colorChanged))
      return onCommitOriginalText(sourcePageNumber - 1, current.index, current.text, current.value, current.fontChoice,
        colorChanged ? current.color.slice(0, 3) : undefined);
  };
  useLayoutEffect(() => {
    const current = editingOriginalRef.current;
    if (!current || !colorCommand || colorCommand.pageId !== pageId || colorCommand.index !== current.index) return;
    const next = { ...current, color: [1, 3, 5].map((offset) => parseInt(colorCommand.color.slice(offset, offset + 2), 16)).concat(current.color[3]) };
    editingOriginalRef.current = next; setEditingOriginal(next);
  }, [colorCommand, pageId]);
  useLayoutEffect(() => {
    if (!fontCommand || fontCommand.pageId !== pageId || editingOriginalRef.current?.index !== fontCommand.index) return;
    const next = { ...editingOriginalRef.current, fontChoice: fontCommand.choice };
    editingOriginalRef.current = next; setEditingOriginal(next);
  }, [fontCommand, pageId]);
  useEffect(() => {
    if (!editingOriginal) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest('.original-text-editor, [data-font-picker], [data-added-text-controls]')) return;
      finishOriginalText(true);
    };
    window.document.addEventListener('pointerdown', outside);
    const unsubscribe = onFinishInlineEdit(() => finishOriginalText(true));
    return () => { window.document.removeEventListener('pointerdown', outside); unsubscribe(); };
  }, [editingOriginal]);

  const setSheet = useCallback((element: HTMLDivElement | null) => {
    sheetRef.current = element;
    registerPage(pageNumber, element);
  }, [pageNumber, registerPage]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const sheet = sheetRef.current;
    if (!viewer || !sheet) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: viewer,
      rootMargin: '1000px 0px'
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [viewerRef]);

  useEffect(() => {
    if (!near) {
      setReady(false);
      setViewport(null);
      const canvas = canvasRef.current;
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    (async () => {
      try {
        const page = await document.getPage(sourcePageNumber);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        onMeasure(sourcePageNumber, { width: natural.width, height: natural.height });
        const displaySize = rotation % 180 ? { width: natural.height, height: natural.width } : natural;
        const currentViewport = page.getViewport({ scale: pageScale(displaySize, zoom, viewerWidth), rotation: natural.rotation + rotation });
        // Render offscreen so PDF.js never clears or partially paints the
        // visible page. Publish the complete bitmap in one browser frame.
        const canvas = window.document.createElement('canvas');
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(currentViewport.width * pixelRatio);
        canvas.height = Math.ceil(currentViewport.height * pixelRatio);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas rendering is unavailable.');
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (cancelled) return;
        const noteIds = new Set(annotations.filter((annotation) =>
          annotation.annotationType === AnnotationType.TEXT || annotation.annotationType === AnnotationType.POPUP
        ).map((annotation) => annotation.id));
        for (const comment of readPageComments(annotations, pageNumber)) {
          if (markupKind(comment.kind) && comment.quadPoints?.length) noteIds.add(comment.id);
        }
        let insideNote = false;
        renderTask = page.render({
          canvas, canvasContext: context, viewport: currentViewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
          // Interactive notes and text markups are drawn separately so color,
          // deletion and visibility update immediately without repainting the PDF.
          operationsFilter: (index, operators) => {
            const operation = operators.fnArray[index];
            if (operation === OPS.beginAnnotation) insideNote = noteIds.has(operators.argsArray[index]?.[0]);
            if (operation === OPS.endAnnotation) {
              const render = !insideNote;
              insideNote = false;
              return render;
            }
            return !insideNote;
          }
        });
        await renderTask.promise;
        if (cancelled || !canvasRef.current) return;
        const visible = canvasRef.current;
        const visibleContext = visible.getContext('2d');
        if (!visibleContext) throw new Error('Canvas rendering is unavailable.');
        visible.width = canvas.width;
        visible.height = canvas.height;
        visibleContext.drawImage(canvas, 0, 0);
        setViewport(currentViewport);
        setReady(true);
      } catch (cause) {
        if (!cancelled) onError(`Could not render page ${pageNumber}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!cancelled) onRenderSettled?.(document, pageNumber);
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, sourcePageNumber, pageNumber, rotation, near, zoom, viewerWidth, onMeasure, onError, onRenderSettled]);

  const scale = pageScale(size, zoom, viewerWidth);
  const activeViewport = viewport && Math.abs(viewport.width - size.width * scale) < 1
    && Math.abs(viewport.height - size.height * scale) < 1 ? viewport : null;
  const width = activeViewport?.width ?? size.width * scale;
  const height = activeViewport?.height ?? size.height * scale;
  useEffect(() => {
    if (stageRef.current && activeViewport) return registerSelectionPage(stageRef.current, pageNumber, activeViewport);
  }, [activeViewport, pageNumber]);

  const choosePoint = (event: MouseEvent<HTMLDivElement>) => {
    if (!activeViewport || !stageRef.current) return;
    setSignatureMenu(null);
    const bounds = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(activeViewport.width, event.clientX - bounds.left));
    const y = Math.max(0, Math.min(activeViewport.height, event.clientY - bounds.top));
    if (placingSignature) {
      const box = signatureBox(x, y);
      onAddSignature(pageId, { x: box.left / activeViewport.width, y: box.top / activeViewport.height,
        width: box.width / activeViewport.width, height: box.height / activeViewport.height });
      setSignatureCursor(null);
      return;
    }
    if (!placing) { onSelectSignature(null); return; }
    const [pdfX, pdfY] = activeViewport.convertToPdfPoint(x, y);
    onPlace(pageNumber, pdfX, pdfY);
  };

  const signatureBox = (x: number, y: number) => {
    const maxWidth = Math.min(180 * scale, width * 0.7);
    const aspect = placingSignature?.aspect || 3;
    const boxWidth = Math.min(maxWidth, height * 0.55 * aspect);
    const boxHeight = boxWidth / aspect;
    return { left: Math.max(0, Math.min(width - boxWidth, x - boxWidth / 2)),
      top: Math.max(0, Math.min(height - boxHeight, y - boxHeight / 2)), width: boxWidth, height: boxHeight };
  };

  const moveSignature = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !activeViewport) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const original = drag.placement;
    if (drag.mode === 'move') {
      onUpdateSignature(drag.id, { x: Math.max(0, Math.min(1 - original.width, original.x + dx / width)),
        y: Math.max(0, Math.min(1 - original.height, original.y + dy / height)), width: original.width, height: original.height });
    } else {
      const aspect = original.width * width / (original.height * height);
      const widthDelta = Math.abs(dx) >= Math.abs(dy * aspect) ? dx : dy * aspect;
      const maxWidth = Math.min((1 - original.x) * width, (1 - original.y) * height * aspect);
      const nextWidth = Math.max(Math.min(40, maxWidth), Math.min(maxWidth, original.width * width + widthDelta));
      onUpdateSignature(drag.id, { x: original.x, y: original.y, width: nextWidth / width, height: nextWidth / aspect / height });
    }
  };

  return <div className="page-sheet" data-page-number={pageNumber} ref={setSheet}>
    <span className="page-label">Page {pageNumber}</span>
    <div className={`page-stage ${placing || placingSignature ? 'is-placing' : ''}${editingOriginal ? ' is-editing-text' : ''}`} ref={stageRef} onClick={choosePoint}
      onContextMenuCapture={event => {
        if (!editActive || (event.target as Element).closest('[data-original-object], .original-object-frame, [data-overlay-kind="image"], .editable-signature')) return;
        const selection = selectedPdfText();
        if (!selection.length && !selectingLinks) return;
        event.preventDefault(); event.stopPropagation(); onLinkMenu(event.clientX, event.clientY, selection);
      }}
      onPointerMove={(event) => { if (placingSignature && activeViewport && stageRef.current) {
        const bounds = stageRef.current.getBoundingClientRect();
        setSignatureCursor({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      } }} onPointerLeave={() => setSignatureCursor(null)} style={{ width, height }}>
      <canvas ref={canvasRef} width={0} height={0} style={{ display: ready ? 'block' : 'none', width, height }} />
      {activeViewport && <OriginalObjectLayer enabled={near && editActive && overlayTool === 'select' && !selectingLinks} busy={objectEditingBusy}
        getSourceBytes={getSourceBytes} pageId={pageId} pageIndex={sourcePageNumber-1} viewport={activeViewport}
        selection={originalObjectSelection} onSelect={onSelectOriginalObject} onChange={onEditOriginalObject} onError={onError} />}
      {inspectOriginalText && activeViewport && <div className="original-text-layer" aria-label="Original PDF text">
        {originalText.map((object) => {
          const a = activeViewport.convertToViewportPoint(object.box[0], object.box[1]);
          const b = activeViewport.convertToViewportPoint(object.box[2], object.box[3]);
          const offset = originalDrag?.index === object.index ? originalDrag : null;
          const left = Math.min(a[0], b[0]) + (offset?.dx || 0); const top = Math.min(a[1], b[1]) + (offset?.dy || 0);
          const boxWidth = Math.max(12, Math.abs(a[0] - b[0])); const boxHeight = Math.max(12, Math.abs(a[1] - b[1]));
          return <svg key={object.index} className={`original-text-frames${editingOriginal?.index === object.index ? ' is-editing' : ''}`} width={width} height={height}
            aria-label={`Original text frame: ${object.text}`}>
            <TextFrame x={left} y={top} width={boxWidth} height={boxHeight} selected={editingOriginal?.index === object.index || offset !== null}
              onInteriorClick={(event) => { event.stopPropagation(); const next = { ...object, value: object.text, fontChoice: 'original' as const };
                editingOriginalRef.current = next; setEditingOriginal(next);
                onFontEditChange({ pageId, index: object.index, fontName: object.fontName, choice: 'original',
                  fontSize: object.fontSize * Math.hypot(object.matrix[0], object.matrix[1]),
                  color: '#' + object.color.slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('') }); }}
              onBorderPointerDown={(event) => { event.stopPropagation(); if (event.button !== 0) return;
                originalDragRef.current = { index: object.index, text: object.text, startX: event.clientX, startY: event.clientY };
                event.currentTarget.setPointerCapture(event.pointerId); }}
              onBorderPointerMove={(event) => { const drag = originalDragRef.current;
                if (drag?.index === object.index) setOriginalDrag({ index: object.index, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }); }}
              onBorderPointerUp={(event) => { const drag = originalDragRef.current; originalDragRef.current = null; setOriginalDrag(null);
                if (!drag || drag.index !== object.index || !activeViewport) return;
                const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
                if (Math.hypot(dx, dy) < 2) return;
                const p0 = activeViewport.convertToPdfPoint(0, 0), p1 = activeViewport.convertToPdfPoint(dx, dy);
                void onMoveOriginalText(sourcePageNumber - 1, object.index, object.text, p1[0] - p0[0], p1[1] - p0[1]); }}
              onBorderPointerCancel={() => { originalDragRef.current = null; setOriginalDrag(null); }} />
          </svg>;
        })}
        {editingOriginal && <OriginalTextEditor edit={editingOriginal} viewport={activeViewport} canvas={canvasRef.current} fonts={installedFonts}
          onChange={(value) => { const next = { ...editingOriginalRef.current!, value };
            editingOriginalRef.current = next; setEditingOriginal(next); }} onFinish={finishOriginalText} />}
      </div>}
      {activeViewport && <OverlayLayer pageId={pageId} width={width} height={height} scale={scale} tool={overlayTool} drawActive={drawActive}
        fontSize={overlayFontSize} fontChoice={overlayFontChoice} viewport={activeViewport} fonts={installedFonts}
        textAppearance={textAppearance}
        fontCommand={fontCommand} onFontEditChange={onFontEditChange}
        color={overlayColor} lineWidth={overlayLineWidth} drawStyle={drawStyle} image={overlayImage} objects={overlays}
        selectedId={selectedOverlayId} onAdd={onAddOverlay} onUpdate={onUpdateOverlay} onDelete={onDeleteOverlay} onSelect={onSelectOverlay} />}
      {near && !ready && <span className="page-rendering">Rendering page {pageNumber}…</span>}
      {activeViewport && comments.filter(comment => markupKind(comment.kind) && comment.quadPoints?.length).map(comment =>
        <CommentMarkup key={`markup-${comment.id}`} comment={comment} viewport={activeViewport} selected={selectedId === comment.id}
          onSelect={() => onSelectComment(comment.id)} />)}
      {near && ready && activeViewport && (commentsActive || selectingLinks) && !placing && <PdfTextSelection pdf={document} sourcePage={sourcePageNumber} page={pageNumber}
        viewport={activeViewport} marking={markingText} onError={onError} onClickMarkup={(x, y) => {
          const comment = markupAtPoint(comments, activeViewport, x, y);
          if (comment) onSelectComment(comment.id);
        }} />}
      {near && ready && activeViewport && <PdfLinks pdf={document} sourcePage={sourcePageNumber} viewport={activeViewport}
        selecting={editActive || markingText || placing || Boolean(overlayTool) || Boolean(placingSignature)}
        onNavigate={onNavigateLink} onError={onError} />}
      {activeViewport && comments.map((comment) => {
        const first = activeViewport.convertToViewportPoint(comment.rect[0], comment.rect[1]);
        const second = activeViewport.convertToViewportPoint(comment.rect[2], comment.rect[3]);
        return <CommentPin key={comment.id} comment={comment} left={Math.min(first[0], second[0])} top={Math.min(first[1], second[1])}
          selected={selectedId === comment.id} open={popupCommentId === comment.id && selectedId === comment.id}
          viewerRef={viewerRef} onSelect={() => onSelectComment(comment.id)} onClose={onCloseComment}
          onAddComment={() => onAddMarkupComment(comment)} onDelete={() => onDeleteMarkup(comment)}
          onReply={() => onReplyComment(comment)}
          onOpenSidebar={() => onOpenCommentSidebar(comment.id)} onColor={(color, remember) => onCommentColor(comment, color, remember)} recentColors={recentColors} colorDisabled={commentEditingDisabled} />;
      })}
      {activeViewport && pendingPoint?.page === pageNumber && !pendingPoint.replyTo && (() => {
        const [left, top] = activeViewport.convertToViewportPoint(pendingPoint.x, pendingPoint.y);
        return <span className="pending-pin" style={{ left, top }}><MessageSquare size={14} fill="currentColor" /></span>;
      })()}
      {activeViewport && signatures.map((signature) => <div key={signature.id} data-signature-id={signature.id}
        className={`editable-signature ${selectedSignatureId === signature.id ? 'selected' : ''}`}
        style={{ left: signature.x * width, top: signature.y * height, width: signature.width * width, height: signature.height * height }}
        onClick={(event) => { event.stopPropagation(); onSelectSignature(signature.id); }}
        onPointerDown={(event) => { event.stopPropagation(); if (event.button !== 0) return; onSelectSignature(signature.id); setSignatureMenu(null);
          dragRef.current = { id: signature.id, mode: 'move', startX: event.clientX, startY: event.clientY, placement: signature };
          event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={moveSignature} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onSelectSignature(signature.id);
          const bounds = stageRef.current!.getBoundingClientRect(); setSignatureMenu({ id: signature.id,
            x: Math.max(0, Math.min(width - 140, event.clientX - bounds.left)),
            y: Math.max(0, Math.min(height - 40, event.clientY - bounds.top)) }); }}>
        <img src={signature.dataUrl} alt="Pending signature" draggable={false} />
        {selectedSignatureId === signature.id && <span className="signature-resize" role="button" aria-label="Resize signature"
          onPointerDown={(event) => { event.stopPropagation(); dragRef.current = { id: signature.id, mode: 'resize', startX: event.clientX, startY: event.clientY, placement: signature };
            event.currentTarget.parentElement?.setPointerCapture(event.pointerId); }} />}
      </div>)}
      {activeViewport && placingSignature && signatureCursor && (() => {
        const box = signatureBox(signatureCursor.x, signatureCursor.y);
        return <img className="signature-cursor" src={placingSignature.dataUrl} alt="" aria-hidden="true"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />;
      })()}
      {signatureMenu && <div className="signature-context-menu" style={{ left: signatureMenu.x, top: signatureMenu.y }}>
        <button onClick={(event) => { event.stopPropagation(); onDeleteSignature(signatureMenu.id); setSignatureMenu(null); }}>Delete signature</button>
      </div>}
    </div>
  </div>;
}
