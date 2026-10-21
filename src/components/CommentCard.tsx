import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Check, MoreHorizontal, Pencil, Reply, Trash2, X } from 'lucide-react';
import type { PdfComment } from '../pdf/comments';
import { onFinishInlineEdit } from '../finish-inline-edit';
import CommentEditor, { CommentBody } from './CommentEditor';
import type { BoldRanges } from '../pdf/comment-text';

export default function CommentCard({ comment, selected, label, date, saving, pending, disabled, editingText, editingBold,
  cardRef, onSelect, onEdit, onTextChange, onSave, onCancel, onDelete, onReply }: {
  comment: PdfComment; selected: boolean; label: string; date: string; saving: boolean; pending: boolean; disabled: boolean;
  editingText?: string; editingBold?: BoldRanges; cardRef: Ref<HTMLDivElement>;
  onSelect: () => void; onEdit: () => void; onTextChange: (text: string, bold: BoldRanges) => void;
  onSave: () => void; onCancel: () => void; onDelete: () => void;
  onReply: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const editing = editingText !== undefined;
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [menuOpen]);
  useEffect(() => {
    if (!editing) return;
    return onFinishInlineEdit(() => { if (editingText.trim()) onSave(); else onCancel(); });
  }, [editing, editingText, onSave, onCancel]);
  return <div ref={cardRef} data-comment-id={comment.id} className={`comment-entry${selected ? ' selected' : ''}`}>
    <div className="comment-card-header">
      <button className="comment-jump comment-author-jump" onClick={onSelect} aria-label={`Go to comment by ${comment.author} on page ${comment.page}`}>
        <span className="comment-meta"><span className="avatar">{comment.author.charAt(0).toUpperCase()}</span><span className="comment-author">{comment.author}</span></span>
      </button>
      <span className="comment-page">p. {comment.page}</span>
      <div className="comment-menu-anchor" ref={menuRef} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
      }} onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menuButtonRef.current?.focus();
        }
      }}>
        <button ref={menuButtonRef} className="icon-button comment-menu-toggle" aria-label={`Options for comment by ${comment.author}`} title="Comment options"
          aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} disabled={disabled || editing || confirmDelete}
          onClick={() => setMenuOpen(open => !open)}><MoreHorizontal size={18} /></button>
        {menuOpen && <div className="comment-options" id={menuId}>
          <button autoFocus disabled={disabled} onClick={() => { setMenuOpen(false); onEdit(); }}><Pencil size={15} />Edit</button>
          <button className="comment-delete" disabled={disabled} onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button>
        </div>}
      </div>
    </div>
    {!editing && <button className="comment-jump" onClick={onSelect}><span className="comment-body"><CommentBody text={label} bold={comment.bold} /></span></button>}
    {editing && <div className="comment-edit" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && editingText.trim()) onSave();
    }}>
      <CommentEditor label="Edit comment" value={editingText} bold={editingBold} disabled={disabled}
        onChange={onTextChange} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && editingText.trim()) { event.preventDefault(); onSave(); }
        }} />
      <div className="comment-edit-actions"><button className="icon-button" title="Cancel edit" aria-label="Cancel comment edit" onClick={onCancel}><X size={16} /></button>
        <button className="icon-button comment-save" title="Save changes" aria-label="Save comment changes" disabled={disabled || !editingText.trim()} onClick={onSave}><Check size={17} /></button></div>
    </div>}
    {confirmDelete && <div className="comment-delete-confirm"><span>Delete this comment?</span><button autoFocus className="text-button" onClick={() => { setConfirmDelete(false); menuButtonRef.current?.focus(); }}>Cancel</button>
      <button className="text-button comment-delete" disabled={disabled} onClick={() => { setConfirmDelete(false); onDelete(); }}>Delete</button></div>}
    {!editing && <button className="text-button comment-reply-action" disabled={disabled} onClick={onReply}><Reply size={14} />Reply</button>}
    <div className="comment-bottom"><span role="status">{saving ? 'Saving…' : pending ? 'Unsaved' : ''}</span><span className="comment-date">{date}</span></div>
  </div>;
}
