import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import type { OriginalPdfText } from '../types';
import type { InstalledFont } from './FontPicker';

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

export function resolveTextFont(choice: string, pdfName: string, value: string, fonts: InstalledFont[]) {
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
  const fontStyle = /italic|oblique/i.test(styleName) ? 'italic' : 'normal';
  const fontWeight = /bold/i.test(styleName) ? 700 : /light/i.test(styleName) ? 300 : /medium/i.test(styleName) ? 500 : 400;
  return { family, fontStyle, fontWeight, arabic };
}

export default function OriginalTextEditor({ edit, viewport, canvas, fonts, onChange, onFinish, mask = true, label = 'Edit original PDF text' }: {
  edit: TextEdit; viewport: PageViewport; canvas: HTMLCanvasElement | null; fonts: InstalledFont[];
  onChange: (value: string) => void; onFinish: (commit: boolean) => void;
  mask?: boolean; label?: string;
}) {
  const input = useRef<HTMLDivElement>(null);
  const [fontRevision, setFontRevision] = useState(0);
  const background = useMemo(() => paperColor(canvas, viewport, edit.box), [canvas, viewport, edit.box]);
  const { family, fontStyle, fontWeight, arabic } = resolveTextFont(edit.fontChoice, edit.fontName, edit.value, fonts);
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
  const first = viewport.convertToViewportPoint(edit.box[0], edit.box[1]);
  const second = viewport.convertToViewportPoint(edit.box[2], edit.box[3]);

  // Let the browser own the text node while typing to retain the native caret,
  // selection, bidi navigation, and composition. Only sync external changes.
  useLayoutEffect(() => {
    if (input.current && input.current.textContent !== edit.value) input.current.textContent = edit.value;
  }, [edit.value]);
  useLayoutEffect(() => {
    input.current?.focus();
    if (input.current) window.getSelection()?.selectAllChildren(input.current);
  }, [edit.index]);

  return <div className={`original-text-editor${mask ? '' : ' added-text-editor'}`} onPointerDown={(event) => event.stopPropagation()}>
    {mask && <div className="original-text-mask" aria-hidden="true" style={{
      left: Math.min(first[0], second[0]) - 1, top: Math.min(first[1], second[1]) - 1,
      width: Math.abs(first[0] - second[0]) + 2, height: Math.abs(first[1] - second[1]) + 2, background
    }} />}
    <div className="original-text-input-position" style={{ transform }}>
      <div ref={input} className="original-text-editable" contentEditable="plaintext-only" role="textbox"
        aria-label={label} aria-multiline="false" spellCheck={false}
        onDragStart={(event) => event.preventDefault()}
        style={{ top: -ascent, minHeight: ascent + descent,
          lineHeight: `${ascent + descent}px`, fontSize: size, fontFamily: family, fontWeight, fontStyle,
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
        }} />
    </div>
  </div>;
}
