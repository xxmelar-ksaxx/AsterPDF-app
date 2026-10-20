import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, MessageSquare, X } from 'lucide-react';
import { MARKUP_COLORS, markupKind, type PdfComment } from '../pdf/comments';
import ColorPicker from './ColorPicker';

export default function CommentPin({ comment, left, top, selected, open, viewerRef, onSelect, onClose, onOpenSidebar, onColor, recentColors, colorDisabled }: {
  comment: PdfComment; left: number; top: number; selected: boolean; open: boolean;
  viewerRef: RefObject<HTMLDivElement | null>;
  onSelect: () => void; onClose: () => void; onOpenSidebar: () => void;
  onColor: (color: string, remember?: boolean) => void; recentColors: string[]; colorDisabled: boolean;
}) {
  const pinRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const popupId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 300, maxHeight: 320, visible: false });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const pin = pinRef.current, popup = popupRef.current, viewer = viewerRef.current;
      if (!pin || !popup || !viewer) return;
      const anchor = pin.getBoundingClientRect(), bounds = viewer.getBoundingClientRect();
      const minX = Math.max(8, bounds.left + 8), minY = Math.max(8, bounds.top + 8);
      const maxX = Math.min(window.innerWidth - 8, bounds.right - 8);
      const maxY = Math.min(window.innerHeight - 8, bounds.bottom - 8);
      const width = Math.min(300, Math.max(0, maxX - minX));
      const maxHeight = Math.min(360, Math.max(0, maxY - minY));
      const height = Math.min(popup.offsetHeight, maxHeight);
      const preferredX = anchor.right + 10 + width <= maxX ? anchor.right + 10 : anchor.left - width - 10;
      setPosition({
        left: Math.max(minX, Math.min(maxX - width, preferredX)),
        top: Math.max(minY, Math.min(maxY - height, anchor.top - 8)), width, maxHeight,
        visible: anchor.bottom > bounds.top && anchor.top < bounds.bottom && anchor.right > bounds.left && anchor.left < bounds.right
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (viewerRef.current) observer.observe(viewerRef.current);
    if (popupRef.current) observer.observe(popupRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, viewerRef, left, top]);

  useLayoutEffect(() => {
    if (open && position.visible) popupRef.current?.focus({ preventScroll: true });
  }, [open, position.visible]);

  const close = () => { onClose(); pinRef.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={pinRef} className={`comment-pin ${selected ? 'selected' : ''} ${comment.draft ? 'draft' : ''}${comment.quadPoints?.length ? ' markup-anchor' : ''}`}
      style={{ left, top }} aria-label={`Comment by ${comment.author} on page ${comment.page}`}
      aria-expanded={open} aria-controls={open ? popupId : undefined} aria-haspopup="dialog"
      onClick={(event) => { event.stopPropagation(); onSelect(); }}>
      <MessageSquare size={14} fill="currentColor" />
    </button>
    {open && createPortal(<div ref={popupRef} id={popupId} className="comment-popup" role="dialog" aria-labelledby={titleId} tabIndex={-1}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, visibility: position.visible ? 'visible' : 'hidden' }}
      onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      }}>
      <div className="comment-popup-header">
        <span className="avatar">{comment.author.charAt(0).toUpperCase()}</span>
        <strong id={titleId} className="comment-author">{comment.author}</strong>
        <span className="comment-page">p. {comment.page}</span>
        <button className="icon-button" title="Open in comments" aria-label="Open sidebar and show this comment" onClick={onOpenSidebar}><ArrowRight size={17} /></button>
        <button className="icon-button" title="Close comment" aria-label="Close comment" onClick={close}><X size={17} /></button>
      </div>
      <div className="comment-popup-body">{comment.text || '(Empty note)'}</div>
      {markupKind(comment.kind) && comment.quadPoints?.length && <div className="comment-markup-color">
        <span>{comment.kind === 'Strikeout' ? 'Removal' : comment.kind === 'Underline' ? 'Replacement' : 'Highlight'} color</span>
        {!colorDisabled && <ColorPicker commentId={comment.id} value={comment.color ?? MARKUP_COLORS[comment.kind]} recent={recentColors}
          label="Change markup color" onChange={onColor} />}
      </div>}
    </div>, document.body)}
  </>;
}
