import { textSize, type OverlayObject } from '../pdf/overlays';
import type { InstalledFont } from './FontPicker';
import { resolveTextFont } from './OriginalTextEditor';
import { justifyTextLine, layoutTextLines } from '../pdf/text-layout';

export function textOverlayLayout(object: OverlayObject, pageWidth: number, fonts: InstalledFont[]) {
  const size = textSize(object);
  const style = resolveTextFont(object.fontChoice || 'helvetica', '', object.text || '', fonts, object);
  const context = window.document.createElement('canvas').getContext('2d')!;
  context.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.family}`;
  const metrics = context.measureText('Mgأ');
  return { lines: layoutTextLines(object.text || '', (text) => context.measureText(text).width,
    object.textSizing === 'fixed' ? object.width * pageWidth : undefined).map((line) => ({ ...line,
      runs: (object.textAlign === 'justify' || object.textAlign === 'smart-justify') && object.textSizing === 'fixed'
        ? justifyTextLine(line, object.width * pageWidth, (text) => context.measureText(text).width, style.arabic, object.textAlign === 'smart-justify') : undefined })),
    lineHeight: Math.max(size * 1.4, (metrics.fontBoundingBoxAscent || size) + (metrics.fontBoundingBoxDescent || size * .3)) };
}

// Measure in page points so the saved frame stays correct at every zoom level.
export function textOverlaySize(object: OverlayObject, pageWidth: number, pageHeight: number, fonts: InstalledFont[]) {
  if (object.textSizing === 'fixed') return { width: object.width, height: object.height };
  const { lines, lineHeight } = textOverlayLayout(object, pageWidth, fonts);
  return {
    width: Math.max(.01, ...lines.map((line) => line.width / pageWidth)),
    height: Math.max(.01, lines.length * lineHeight / pageHeight),
  };
}

export async function prepareTextForExport(object: OverlayObject, fonts: InstalledFont[], pageWidth: number, pageHeight: number): Promise<OverlayObject[]> {
  if (object.kind !== 'text') return [object];
  const style = resolveTextFont(object.fontChoice || 'helvetica', '', object.text || '', fonts, object);
  const fontSpec = `${style.fontStyle} ${style.fontWeight} ${textSize(object)}px ${style.family}`;
  await window.document.fonts.load(fontSpec);
  const { lines, lineHeight } = textOverlayLayout(object, pageWidth, fonts);
  const box = textOverlaySize(object, pageWidth, pageHeight, fonts);
  let choice = object.fontChoice;
  const installed = fonts.find((font) => `system:${font.id}` === choice);
  let bold = object.bold, italic = object.italic;
  if (installed) {
    const variant = fonts.find((font) => font.family === installed.family &&
      /bold/i.test(font.style) === (style.fontWeight >= 600) && /italic|oblique/i.test(font.style) === (style.fontStyle === 'italic'));
    const selected = variant || installed;
    choice = `system:${selected.id}`;
    bold = style.fontWeight >= 600 && !/bold/i.test(selected.style);
    italic = style.fontStyle === 'italic' && !/italic|oblique/i.test(selected.style);
  }
  return lines.flatMap((line, index): OverlayObject[] => {
    const base = { ...object, ...box, y: object.y + index * lineHeight / pageHeight, fontChoice: choice, bold, italic };
    if (line.runs) return line.runs.map((run) => ({ ...base, text: run.text, x: object.x + run.x / pageWidth,
      width: run.width / pageWidth, textAdvance: run.width, textAlign: 'left' }));
    return line.text ? [{ ...base, text: line.text, textAdvance: line.width,
      textAlign: object.textAlign === 'justify' || object.textAlign === 'smart-justify' ? style.arabic ? 'right' : 'left' : object.textAlign }] : [];
  });
}
