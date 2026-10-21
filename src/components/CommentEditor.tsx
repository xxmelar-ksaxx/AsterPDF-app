import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { commentDirection, commentHtml, commentSegments, normalizeBold, type BoldRanges } from '../pdf/comment-text';

function readEditor(root: HTMLElement) {
  let text = ''; const bold: BoldRanges = [];
  const append = (value: string, weight: boolean) => { const start = text.length; text += value; if (weight) bold.push([start, text.length]); };
  const walk = (node: Node, weight = false) => {
    if (node.nodeType === Node.TEXT_NODE) { append(node.textContent || '', weight); return; }
    if (!(node instanceof HTMLElement)) return;
    const style = node.style.fontWeight;
    weight = style ? style === 'bold' || Number(style) >= 600 : weight || node.tagName === 'B' || node.tagName === 'STRONG';
    if (node.tagName === 'BR') { append('\n', weight); return; }
    const block = node !== root && /^(DIV|P)$/.test(node.tagName);
    if (block && text && !text.endsWith('\n')) append('\n', false);
    node.childNodes.forEach(child => walk(child, weight));
    if (block && node.nextSibling && !text.endsWith('\n')) append('\n', false);
  };
  walk(root);
  return { text, bold: normalizeBold(text, bold) };
}

export function CommentBody({ text, bold }: { text: string; bold?: BoldRanges }) {
  return <span className="comment-formatted-text" dir={commentDirection(text)}>{commentSegments(text, bold).map((part, index) =>
    part.bold ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>)}</span>;
}

export default function CommentEditor({ value, bold, onChange, label, placeholder, disabled, onKeyDown }: {
  value: string; bold?: BoldRanges; onChange: (text: string, bold: BoldRanges) => void;
  label: string; placeholder?: string; disabled?: boolean; onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const last = useRef('');
  const serialized = JSON.stringify({ text: value, bold: normalizeBold(value, bold) });
  useLayoutEffect(() => {
    if (editor.current && serialized !== last.current) {
      editor.current.innerHTML = commentHtml(value, bold);
      last.current = serialized;
    }
  }, [serialized, value, bold]);
  useLayoutEffect(() => { editor.current?.focus(); }, []);
  const update = () => {
    if (!editor.current) return;
    const current = readEditor(editor.current);
    if (current.text.length > 10000) {
      current.text = current.text.slice(0, 10000); current.bold = normalizeBold(current.text, current.bold);
      editor.current.innerHTML = commentHtml(current.text, current.bold);
    }
    last.current = JSON.stringify(current); onChange(current.text, current.bold);
  };
  return <div ref={editor} className="comment-editor" role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled}
    contentEditable={!disabled} suppressContentEditableWarning dir={commentDirection(value)} data-placeholder={placeholder}
    onInput={update} onDrop={event => { event.preventDefault(); event.stopPropagation(); }}
    onPaste={event => {
      event.preventDefault();
      const selected = window.getSelection()?.toString().length || 0;
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain').slice(0, Math.max(0, 10000 - value.length + selected)));
      update();
    }} onKeyDown={event => {
      event.stopPropagation();
      if (!event.nativeEvent.isComposing && !event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault(); document.execCommand('bold'); update(); return;
      }
      onKeyDown?.(event);
    }} />;
}
