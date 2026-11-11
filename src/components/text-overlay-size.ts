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
  const lineHeight = object.lineSpacing ? size*object.lineSpacing : Math.max(size*1.4,
    (metrics.fontBoundingBoxAscent || size) + (metrics.fontBoundingBoxDescent || size*.3));
  let offsetY = 0;
  const paragraphs = (object.text || '').replace(/\r\n?/g,'\n').split('\n');
  const lines = paragraphs.flatMap((paragraph, index) => {
    if (index) offsetY += object.paragraphGap ?? (object.breakSpacing || 0)*lineHeight;
    return layoutTextLines(paragraph, text => context.measureText(text).width,
      object.textSizing && object.textSizing !== 'auto' ? object.width*pageWidth : undefined).map(line => {
      const top = offsetY;
      offsetY += lineHeight;
      return { ...line, offsetY:top,
      runs: (object.textAlign === 'justify' || object.textAlign === 'smart-justify') && object.textSizing && object.textSizing !== 'auto'
        ? justifyTextLine(line, object.width * pageWidth, (text) => context.measureText(text).width, style.arabic, object.textAlign === 'smart-justify') : undefined };
    });
  });
  return {lines, lineHeight, height:offsetY};
}

// Measure in page points so the saved frame stays correct at every zoom level.
export function textOverlaySize(object: OverlayObject, pageWidth: number, pageHeight: number, fonts: InstalledFont[]) {
  if (object.textSizing === 'fixed') return { width: object.width, height: object.height };
  const { lines, height } = textOverlayLayout(object, pageWidth, fonts);
  return {
    width: object.textSizing === 'paragraph' ? object.width : Math.max(.01, ...lines.map((line) => line.width / pageWidth)),
    height: Math.max(.01, height / pageHeight),
  };
}

export async function prepareTextForExport(object: OverlayObject, fonts: InstalledFont[], pageWidth: number, pageHeight: number): Promise<OverlayObject[]> {
  if (object.kind !== 'text') return [object];
  const style = resolveTextFont(object.fontChoice || 'helvetica', '', object.text || '', fonts, object);
  const fontSpec = `${style.fontStyle} ${style.fontWeight} ${textSize(object)}px ${style.family}`;
  await window.document.fonts.load(fontSpec);
  const { lines } = textOverlayLayout(object, pageWidth, fonts);
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
  return lines.flatMap((line): OverlayObject[] => {
    const base = { ...object, ...box, y: object.y + line.offsetY / pageHeight, fontChoice: choice, bold, italic };
    if (line.runs) return line.runs.map((run) => ({ ...base, text: run.text, x: object.x + run.x / pageWidth,
      width: run.width / pageWidth, textAdvance: run.width, textAlign: 'left' }));
    return line.text ? [{ ...base, text: line.text, textAdvance: line.width,
      textAlign: object.textAlign === 'justify' || object.textAlign === 'smart-justify' ? style.arabic ? 'right' : 'left' : object.textAlign }] : [];
  });
}
