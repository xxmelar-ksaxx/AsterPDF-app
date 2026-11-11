import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { applyTextInput, displayPosition, sourcePosition, type TextInputView } from '../pdf/smart-text-input';

type Selection = { start:number; end:number; direction:'forward'|'backward'|'none' };
type Props = {
  view:TextInputView; style:CSSProperties; gap:number; label:string; caret?:{x:number;y:number};
  selection:RefObject<Selection>; onEdit:(value:string, selection:Selection)=>void;
  onFinish:(commit:boolean)=>void; onHistory:(redo:boolean)=>void;
};

// Each paragraph is a DOM block. A newline inside its text node is a soft break.
// Track offsets during the same walk that reads Chromium's native IME edits.
function readField(field:HTMLElement) {
  const native = window.getSelection();
  let text = '', anchor = 0, focus = 0;
  function mark(node:Node, offset:number) {
    if (node === native?.anchorNode && offset === native.anchorOffset) anchor = text.length;
    if (node === native?.focusNode && offset === native.focusOffset) focus = text.length;
  }
  function visit(node:Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === native?.anchorNode) anchor = text.length + native.anchorOffset;
      if (node === native?.focusNode) focus = text.length + native.focusOffset;
      text += (node.textContent || '').replace(/\n/g, '\u2028');
      return;
    }
    const children = Array.from(node.childNodes);
    children.forEach((child,i) => {
      mark(node,i);
      if (i && child instanceof HTMLElement && ['DIV','P'].includes(child.tagName)) text += '\n';
      if (child.nodeName === 'BR') {
        if (i < children.length-1) text += '\u2028';
      } else visit(child);
    });
    mark(node,children.length);
  }
  visit(field);
  return {text, anchor, focus};
}

export default function FlowTextField({view,style,gap,label,caret,selection,onEdit,onFinish,onHistory}:Props) {
  const field = useRef<HTMLDivElement>(null);
  const first = useRef(true), composing = useRef(false);
  const display = useRef(view);
  const currentSelection = (raw = readField(field.current!), mapping = display.current):Selection => {
    const anchor = sourcePosition(mapping,raw.anchor), focus = sourcePosition(mapping,raw.focus);
    return {start:Math.min(anchor,focus),end:Math.max(anchor,focus),direction:anchor>focus?'backward':'forward'};
  };
  const replaceSelection = (insert:string) => {
    const range = currentSelection();
    const room = Math.max(0,10000 - (view.source.length-range.end+range.start));
    const value = insert.slice(0,room);
    const end = range.start+value.length;
    selection.current = range;
    onEdit(view.source.slice(0,range.start)+value+view.source.slice(range.end),{start:end,end,direction:'none'});
  };
  const readInput = () => {
    if (composing.current) return;
    const raw = readField(field.current!);
    const changed = applyTextInput(display.current,raw.text);
    onEdit(changed.source,currentSelection(raw,changed));
  };
  useLayoutEffect(() => {
    const root = field.current!;
    if (composing.current) return;
    const paragraphs = view.text.split('\n');
    const nodes = paragraphs.map(paragraph => {
      const block = document.createElement('div');
      block.append(document.createTextNode(paragraph.replace(/\u2028/g,'\n')));
      if (!paragraph || paragraph.endsWith('\u2028')) block.append(document.createElement('br'));
      return block;
    });
    root.replaceChildren(...nodes);
    display.current = view;
    const native = window.getSelection();
    if (first.current) {
      first.current = false;
      root.focus({preventScroll:true});
      const target = caret && document.caretRangeFromPoint(caret.x,caret.y);
      if (target && root.contains(target.startContainer)) {
        native?.removeAllRanges(); native?.addRange(target);
        selection.current = currentSelection();
        return;
      }
      selection.current = {start:0,end:view.source.length,direction:'forward'};
    }
    if (document.activeElement !== root) return;
    const point = (logical:number):[Node,number] => {
      let offset = displayPosition(view,logical);
      for (const block of nodes) {
        const node = block.firstChild!;
        const length = node.textContent!.length;
        if (offset <= length) return [node,offset];
        offset -= length + 1;
      }
      return [nodes.at(-1)!.firstChild!,paragraphs.at(-1)!.length];
    };
    const {start,end,direction} = selection.current;
    native?.setBaseAndExtent(...point(direction==='backward'?end:start),...point(direction==='backward'?start:end));
  }, [view]);
  const actions = useRef({replaceSelection,onHistory});
  actions.current = {replaceSelection,onHistory};
  useLayoutEffect(() => {
    const root = field.current!;
    const before = (event:InputEvent) => {
      if (event.isComposing) return;
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault(); actions.current.replaceSelection(event.inputType === 'insertParagraph'?'\n':'\u2028');
      } else if (['historyUndo','historyRedo'].includes(event.inputType)) {
        event.preventDefault(); actions.current.onHistory(event.inputType === 'historyRedo');
      } else selection.current = currentSelection();
    };
    root.addEventListener('beforeinput',before);
    return () => root.removeEventListener('beforeinput',before);
  }, []);
  return <div ref={field} contentEditable="plaintext-only" role="textbox" aria-label={label} aria-multiline="true"
    className="original-text-editable flow-text-field" style={{...style,'--paragraph-gap':gap+'px'} as CSSProperties}
    spellCheck={false} onInput={readInput} onCompositionStart={()=>{composing.current=true;}}
    onCompositionEnd={()=>{composing.current=false;readInput();}}
    onDragStart={event=>event.preventDefault()} onDrop={event=>event.preventDefault()}
    onPaste={event=>{event.preventDefault();replaceSelection(event.clipboardData.getData('text/plain').replace(/\r\n?/g,'\n'));}}
    onCopy={event=>{const {start,end}=currentSelection();event.preventDefault();event.clipboardData.setData('text/plain',view.source.slice(start,end));}}
    onCut={event=>{const {start,end}=currentSelection();event.preventDefault();event.clipboardData.setData('text/plain',view.source.slice(start,end));replaceSelection('');}}
    onKeyDown={event=>{
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) onFinish(true);
        else replaceSelection(event.shiftKey?'\u2028':'\n');
      } else if (event.key === 'Escape') {event.preventDefault();onFinish(false);}
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='z') {
        event.preventDefault(); selection.current=currentSelection();onHistory(event.shiftKey);
      }
    }} />;
}
