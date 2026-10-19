import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { OriginalPdfText } from '../types';
import type { InstalledFont } from './FontPicker';
import type { TextAppearance } from '../pdf/overlays';
import { layoutTextLines } from '../pdf/text-layout';
import { applyTextInput, displayPosition, plainTextInput, smartTextInput, sourcePosition, type TextInputView } from '../pdf/smart-text-input';

export type TextEdit = OriginalPdfText & { value: string; fontChoice: string };

// Match the local paper color rather than covering colored pages with a white box.
function paperColor(canvas: HTMLCanvasElement | null, viewport: PageViewport, box: number[]) {
  if (!canvas?.width) return '#fff';
  const a = viewport.convertToViewportPoint(box[0], box[1]);
  const b = viewport.convertToViewportPoint(box[2], box[3]);
  const ratio = canvas.width / viewport.width;
  const x = Math.max(0, Math.floor(Math.min(a[0], b[0]) * ratio) - 2);
  const y = Math.max(0, Math.floor(Math.min(a[1], b[1]) * ratio) - 2);
  const width = Math.min(canvas.width - x, Math.ceil(Math.abs(a[0] - b[0]) * ratio) + 4);
  const height = Math.min(canvas.height - y, Math.ceil(Math.abs(a[1] - b[1]) * ratio) + 4);
  if (width <= 0 || height <= 0) return '#fff';
  const pixels = canvas.getContext('2d')?.getImageData(x, y, width, height).data;
  if (!pixels) return '#fff';
  const colors = new Map<string, number>();
  let best = '#fff', count = 0;
  const step = Math.max(1, Math.floor(width * height / 12000)) * 4;
  for (let offset = 0; offset < pixels.length; offset += step) {
    const key = `rgb(${pixels[offset]}, ${pixels[offset + 1]}, ${pixels[offset + 2]})`;
    const next = (colors.get(key) || 0) + 1;
    colors.set(key, next);
    if (next > count) { best = key; count = next; }
  }
  return best;
}

export function resolveTextFont(choice: string, pdfName: string, value: string, fonts: InstalledFont[], appearance: TextAppearance = {}) {
  const edit = { fontChoice: choice, fontName: pdfName, value };
  const normalize = (name: string) => name.replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const installed = edit.fontChoice.startsWith('system:') ? fonts.find((font) => `system:${font.id}` === edit.fontChoice)
    : edit.fontChoice === 'original' ? fonts.find((font) => normalize(font.postscriptName) === normalize(edit.fontName)) : undefined;
  const arabic = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(edit.value);
  const name = normalize(edit.fontName);
  const family = installed ? JSON.stringify(installed.family)
    : edit.fontChoice === 'noto-naskh-arabic' || (edit.fontChoice === 'original' && name.includes('notonaskh')) ? 'AsterNaskh'
    : edit.fontChoice === 'noto-serif' || (edit.fontChoice === 'original' && name.includes('notoserif')) ? 'AsterSerif'
    : edit.fontChoice === 'noto-sans' || (edit.fontChoice === 'original' && name.includes('notosans')) ? 'AsterSans'
    : /times/i.test(edit.fontName) ? '"Times New Roman"'
    : /courier/i.test(edit.fontName) ? '"Courier New"'
    : arabic ? 'AsterNaskh' : 'Arial';
  const styleName = installed?.style || (edit.fontChoice === 'original' ? edit.fontName : '');
  const fontStyle = (appearance.italic ?? /italic|oblique/i.test(styleName)) ? 'italic' : 'normal';
  const fontWeight = appearance.bold !== undefined ? appearance.bold ? 700 : 400 : /bold/i.test(styleName) ? 700 : /light/i.test(styleName) ? 300 : /medium/i.test(styleName) ? 500 : 400;
  return { family, fontStyle, fontWeight, arabic };
}

export default function OriginalTextEditor({ edit, viewport, canvas, fonts, onChange, onFinish, mask = true, label = 'Edit original PDF text', appearance = {}, frameWidth }: {
  edit: TextEdit; viewport: PageViewport; canvas: HTMLCanvasElement | null; fonts: InstalledFont[];
  onChange: (value: string) => void; onFinish: (commit: boolean) => void;
  mask?: boolean; label?: string;
  appearance?: TextAppearance; frameWidth?: number;
}) {
  const input = useRef<HTMLDivElement>(null);
  const multilineInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [compositionView, setCompositionView] = useState<TextInputView | null>(null);
  const selection = useRef({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none' });
  const inputHistory = useRef({ entries: [{ value: edit.value, selection: selection.current }], index: 0 });
  const managedHistory = useRef(false);
  const compositionHistoryStart = useRef(0);
  const arrowStart = useRef(0);
  const [fontRevision, setFontRevision] = useState(0);
  const background = useMemo(() => paperColor(canvas, viewport, edit.box), [canvas, viewport, edit.box]);
  const { family, fontStyle, fontWeight, arabic } = resolveTextFont(edit.fontChoice, edit.fontName, edit.value, fonts, appearance);
  const [a, b, c, d, e, f] = edit.matrix;
  const origin = viewport.convertToViewportPoint(e, f);
  const right = viewport.convertToViewportPoint(e + a, f + b);
  const down = viewport.convertToViewportPoint(e - c, f - d);
  // PDF text often uses a 1pt font with a large matrix. Scaling the DOM by that
  // matrix magnifies its native caret as well. Move the scale into the font.
  const textScale = Math.hypot(right[0] - origin[0], right[1] - origin[1]) || 1;
  const size = edit.fontSize * textScale;
  const transform = `matrix(${(right[0] - origin[0]) / textScale}, ${(right[1] - origin[1]) / textScale}, ${(down[0] - origin[0]) / textScale}, ${(down[1] - origin[1]) / textScale}, ${origin[0]}, ${origin[1]})`;
  useEffect(() => {
    let active = true;
    void window.document.fonts.load(`${fontStyle} ${fontWeight} ${size}px ${family}`).then(() => {
      if (active) setFontRevision((revision) => revision + 1);
    }).catch(() => {});
    return () => { active = false; };
  }, [family, fontStyle, fontWeight, size]);
  const metrics = useMemo(() => {
    const context = window.document.createElement('canvas').getContext('2d')!;
    context.font = `${fontStyle} ${fontWeight} ${size}px ${family}`;
    return context.measureText(edit.value || ' ');
  }, [family, fontStyle, fontWeight, size, edit.value, fontRevision]);
  const ascent = metrics.fontBoundingBoxAscent || size;
  const descent = metrics.fontBoundingBoxDescent || size * 0.3;
  const editorAlign = appearance.textAlign === 'smart-justify' ? 'justify' : appearance.textAlign || 'left';
  const smart = !mask && appearance.textAlign === 'smart-justify' && frameWidth !== undefined;
  if (smart) managedHistory.current = true;
  const lineHeight = Math.max(size * 1.4, ascent + descent);
  const lines = useMemo(() => {
    const context = window.document.createElement('canvas').getContext('2d')!;
    context.font = `${fontStyle} ${fontWeight} ${size}px ${family}`;
    return layoutTextLines(edit.value, (text) => context.measureText(text).width, frameWidth);
  }, [edit.value, frameWidth, size, family, fontStyle, fontWeight, fontRevision]);
  const formattedInput = useMemo(() => {
    if (!smart || frameWidth === undefined) return plainTextInput(edit.value);
    const context = window.document.createElement('canvas').getContext('2d')!;
    context.font = `${fontStyle} ${fontWeight} ${size}px ${family}`;
    return smartTextInput(edit.value, (text) => context.measureText(text).width, frameWidth);
  }, [smart, edit.value, frameWidth, size, family, fontStyle, fontWeight, fontRevision]);
  const inputView = compositionView || formattedInput;
  const readSelection = (element: HTMLTextAreaElement, view?: TextInputView) => {
    // React can deliver select immediately after input, before the new render.
    const current = view || (element.value === inputView.text ? inputView : applyTextInput(inputView, element.value));
    return { start: sourcePosition(current, element.selectionStart), end: sourcePosition(current, element.selectionEnd), direction: element.selectionDirection };
  };
  const rememberSelection = (element: HTMLTextAreaElement) => { selection.current = readSelection(element); };
  const changeInput = (value: string, nextSelection: typeof selection.current) => {
    const history = inputHistory.current;
    value = value.slice(0, 10000);
    if (value !== edit.value) {
      history.entries[history.index].selection = selection.current;
      const entry = { value, selection: nextSelection };
      if (composing.current && history.index > compositionHistoryStart.current) history.entries[history.index] = entry;
      else {
        history.entries = history.entries.slice(0, history.index + 1);
        history.entries.push(entry);
        if (history.entries.length > 200) history.entries.shift();
        history.index = history.entries.length - 1;
      }
    }
    selection.current = nextSelection;
    onChange(value);
  };
  const restoreInput = (redo: boolean) => {
    const history = inputHistory.current;
    history.entries[history.index].selection = selection.current;
    const index = history.index + (redo ? 1 : -1);
    if (index < 0 || index >= history.entries.length) return;
    history.index = index;
    selection.current = history.entries[index].selection;
    onChange(history.entries[index].value);
  };
  const first = viewport.convertToViewportPoint(edit.box[0], edit.box[1]);
  const second = viewport.convertToViewportPoint(edit.box[2], edit.box[3]);

  // Let the browser own the text node while typing to retain the native caret,
  // selection, bidi navigation, and composition. Only sync external changes.
  useLayoutEffect(() => {
    if (input.current && input.current.textContent !== edit.value) input.current.textContent = edit.value;
  }, [edit.value]);
  useLayoutEffect(() => {
    const element = multilineInput.current;
    if (!element || composing.current) return;
    const { start, end, direction } = selection.current;
    element.setSelectionRange(displayPosition(inputView, start), displayPosition(inputView, end), direction);
  }, [inputView]);
  useLayoutEffect(() => {
    if (multilineInput.current) { multilineInput.current.focus(); multilineInput.current.select(); return; }
    input.current?.focus();
    if (input.current) window.getSelection()?.selectAllChildren(input.current);
  }, [edit.index]);
  useEffect(() => {
    const element = multilineInput.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (!managedHistory.current || !['historyUndo', 'historyRedo'].includes(event.inputType)) return;
      event.preventDefault();
      restoreInput(event.inputType === 'historyRedo');
    };
    element.addEventListener('beforeinput', beforeInput);
    return () => element.removeEventListener('beforeinput', beforeInput);
  });

  return <div className={`original-text-editor${mask ? '' : ' added-text-editor'}`} onPointerDown={(event) => event.stopPropagation()}>
    {mask && <div className="original-text-mask" aria-hidden="true" style={{
      left: Math.min(first[0], second[0]) - 1, top: Math.min(first[1], second[1]) - 1,
      width: Math.abs(first[0] - second[0]) + 2, height: Math.abs(first[1] - second[1]) + 2, background
    }} />}
    <div className="original-text-input-position" style={{ transform }}>
      {!mask ? <textarea ref={multilineInput} className="original-text-editable added-text-multiline" aria-label={label} aria-multiline="true"
        value={inputView.text} spellCheck={false} wrap={frameWidth === undefined ? 'off' : 'soft'}
        title="Enter for a new line · Click outside or Ctrl/Cmd+Enter to finish"
        onDragStart={(event) => event.preventDefault()}
        style={{ top: -ascent - (lineHeight - ascent - descent) / 2,
          width: frameWidth ?? Math.max(size * .6, ...lines.map((line) => line.width)) + 2,
          height: lines.length * lineHeight + 4, lineHeight: `${lineHeight}px`, fontSize: size,
          fontFamily: family, fontWeight, fontStyle, textAlign: editorAlign,
          textAlignLast: editorAlign === 'justify' ? 'start' : 'auto', textJustify: 'inter-word',
          whiteSpace: frameWidth === undefined ? 'pre' : 'pre-wrap', overflowWrap: 'anywhere',
          textDecoration: [appearance.underline && 'underline', appearance.strikeThrough && 'line-through'].filter(Boolean).join(' ') || 'none',
          color: `rgba(${edit.color.slice(0, 3).join(',')}, ${edit.color[3] / 255})`, direction: arabic ? 'rtl' : 'ltr' }}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onCompositionStart={() => { composing.current = true; compositionHistoryStart.current = inputHistory.current.index; }}
        onCompositionEnd={(event) => {
          const next = applyTextInput(inputView, event.currentTarget.value);
          changeInput(next.source, readSelection(event.currentTarget, next));
          composing.current = false; setCompositionView(null);
        }}
        onChange={(event) => {
          const next = applyTextInput(inputView, event.target.value.replace(/\r\n?/g, '\n'));
          // Keep the IME's unformatted view until its composition is finished.
          if (composing.current) setCompositionView(next);
          changeInput(next.source, readSelection(event.currentTarget, next));
        }}
        onCopy={(event) => {
          if (!smart) return;
          const element = event.currentTarget;
          event.preventDefault();
          event.clipboardData.setData('text/plain', edit.value.slice(sourcePosition(inputView, element.selectionStart), sourcePosition(inputView, element.selectionEnd)));
        }}
        onCut={(event) => {
          if (!smart) return;
          const element = event.currentTarget;
          const from = sourcePosition(inputView, element.selectionStart), to = sourcePosition(inputView, element.selectionEnd);
          event.preventDefault();
          event.clipboardData.setData('text/plain', edit.value.slice(from, to));
          changeInput(edit.value.slice(0, from) + edit.value.slice(to), { start: from, end: from, direction: 'none' });
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (managedHistory.current && (event.ctrlKey || event.metaKey) && !event.altKey &&
            (event.code === 'KeyZ' || event.key.toLowerCase() === 'z')) {
            event.preventDefault(); restoreInput(event.shiftKey); return;
          }
          arrowStart.current = event.currentTarget.selectionStart;
          if (smart && (event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.metaKey && !event.altKey) {
            // Delete a source grapheme, never one of the display-only Kashidas.
            let from = sourcePosition(inputView, event.currentTarget.selectionStart);
            let to = sourcePosition(inputView, event.currentTarget.selectionEnd);
            if (from === to) {
              const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(edit.value)];
              if (event.key === 'Backspace') from = parts.filter((part) => part.index < from).at(-1)?.index ?? from;
              else {
                const part = parts.find((part) => part.index + part.segment.length > to);
                if (part) to = part.index + part.segment.length;
              }
            }
            event.preventDefault();
            changeInput(edit.value.slice(0, from) + edit.value.slice(to), { start: from, end: from, direction: 'none' });
            return;
          }
          if (event.key === 'Escape') { event.preventDefault(); onFinish(false); }
          else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onFinish(true); }
        }}
        onKeyUp={(event) => {
          if (!smart || event.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          const element = event.currentTarget;
          if (element.selectionStart !== element.selectionEnd) return;
          let position = element.selectionStart;
          const logical = sourcePosition(inputView, position);
          if (position < arrowStart.current) while (position > 0 && sourcePosition(inputView, position - 1) === logical) position--;
          else if (position > arrowStart.current) position = displayPosition(inputView, logical);
          element.setSelectionRange(position, position);
          rememberSelection(element);
        }} /> : <div ref={input} className="original-text-editable" contentEditable="plaintext-only" role="textbox"
        aria-label={label} aria-multiline="false" spellCheck={false}
        onDragStart={(event) => event.preventDefault()}
        style={{ top: -ascent, minHeight: ascent + descent,
          lineHeight: `${ascent + descent}px`, fontSize: size, fontFamily: family, fontWeight, fontStyle,
          width: frameWidth, minWidth: frameWidth, textAlign: editorAlign,
          textDecoration: [appearance.underline && 'underline', appearance.strikeThrough && 'line-through'].filter(Boolean).join(' ') || 'none',
          color: `rgba(${edit.color.slice(0, 3).join(',')}, ${edit.color[3] / 255})`, direction: arabic ? 'rtl' : 'ltr' }}
        onInput={(event) => {
          const element = event.currentTarget;
          const text = element.textContent || '';
          const next = text.replace(/[\r\n]/g, ' ').slice(0, 10000);
          if (next !== text) element.textContent = next;
          onChange(next);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const selected = window.getSelection()?.toString().length || 0;
          const remaining = Math.max(0, 10000 - (edit.value.length - selected));
          const text = event.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' ').slice(0, remaining);
          // insertText preserves browser undo and the current bidi selection.
          window.document.execCommand('insertText', false, text);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); onFinish(false); }
          else if (event.key === 'Enter') { event.preventDefault(); onFinish(true); }
        }} />}
    </div>
  </div>;
}
