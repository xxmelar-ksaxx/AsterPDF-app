import { concatTransformationMatrix, decodePDFRawStream, degrees, LineCapStyle, PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts,
  pushGraphicsState, popGraphicsState, setLineWidth, setStrokingColor, setTextRenderingMode, TextRenderingMode } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import fontkit from '@pdf-lib/fontkit';
import { shapePath } from './draw-geometry';
import { restoreEditableAnnotations } from './editable-annotations';
import { pruneUnusedObjects } from './prune-unused';

export type OverlayKind = 'pen' | 'rectangle' | 'ellipse' | 'line' | 'text' | 'image';
export type TextAppearance = { bold?: boolean; italic?: boolean; underline?: boolean; strikeThrough?: boolean; textAlign?: 'left' | 'center' | 'right' | 'justify' | 'smart-justify'; textSizing?: 'auto' | 'fixed' };
export type OverlayObject = TextAppearance & {
  id: string;
  pageId: string;
  kind: OverlayKind;
  editingTool?: 'draw' | 'edit';
  x: number; y: number; width: number; height: number;
  color: string;
  lineWidth: number;
  fill?: string | null;
  fillHidden?: boolean;
  opacity?: number;
  radius?: number;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  fontSize?: number;
  textAdvance?: number;
  points?: { x: number; y: number }[];
  text?: string;
  fontChoice?: 'helvetica' | 'noto-sans' | 'noto-serif' | 'noto-naskh-arabic' | `system:${string}`;
  image?: string;
};

export type OverlayPage = { pageId: string; index: number; viewport: PageViewport };
export const isDrawingObject = (object: OverlayObject) => object.editingTool === 'draw' ||
  (!object.editingTool && ['pen', 'line', 'rectangle', 'ellipse'].includes(object.kind));
// Older editable PDFs stored text size as eight times the drawing width.
export const textSize = (object: OverlayObject) => object.fontSize ?? Math.max(8, object.lineWidth * 8);
const BASE_KEY = PDFName.of('AsterPDFEditableBaseV1');
const OBJECTS_KEY = PDFName.of('AsterPDFEditableObjectsV1');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function readOverlayPackage(bytes: Uint8Array, loaded?: PDFDocument): Promise<{ base: Uint8Array; objects: OverlayObject[] } | null> {
  const pdf = loaded ?? await PDFDocument.load(bytes);
  const baseRef = pdf.catalog.get(BASE_KEY);
  const objectsRef = pdf.catalog.get(OBJECTS_KEY);
  if (!baseRef && !objectsRef) return null;
  if (!baseRef || !objectsRef) throw new Error('This PDF has incomplete AsterPDF editing data.');
  try {
    const baseStream = pdf.context.lookup(baseRef);
    const objectsStream = pdf.context.lookup(objectsRef);
    if (!(baseStream instanceof PDFRawStream) || !(objectsStream instanceof PDFRawStream)) throw new Error('Invalid editing streams');
    const base = decodePDFRawStream(baseStream).decode();
    const parsed: unknown = JSON.parse(decoder.decode(decodePDFRawStream(objectsStream).decode()));
    if (!base.length || !Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' ||
      typeof item.id !== 'string' || typeof item.pageId !== 'string' || typeof item.kind !== 'string' ||
      (item.editingTool !== undefined && item.editingTool !== 'draw' && item.editingTool !== 'edit') ||
      (['bold', 'italic', 'underline', 'strikeThrough'].some((key) => item[key] !== undefined && typeof item[key] !== 'boolean')) ||
      (item.textAlign !== undefined && !['left', 'center', 'right', 'justify', 'smart-justify'].includes(item.textAlign)) ||
      (item.textSizing !== undefined && item.textSizing !== 'auto' && item.textSizing !== 'fixed') ||
      !Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.width) || !Number.isFinite(item.height) ||
      (item.opacity !== undefined && (!Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1)) ||
      (item.radius !== undefined && (!Number.isFinite(item.radius) || item.radius < 0)) ||
      (item.fill != null && (typeof item.fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.fill))) ||
      (item.fillHidden !== undefined && typeof item.fillHidden !== 'boolean') ||
      (item.name !== undefined && typeof item.name !== 'string') ||
      (item.hidden !== undefined && typeof item.hidden !== 'boolean') ||
      (item.locked !== undefined && typeof item.locked !== 'boolean') ||
      (item.fontSize !== undefined && (!Number.isFinite(item.fontSize) || item.fontSize < 4 || item.fontSize > 500)))) {
      throw new Error('Invalid editable objects');
    }
    const basePdf = await PDFDocument.load(base);
    // A different page count means the saved artwork no longer maps safely.
    // Open the current PDF normally instead of restoring a stale page layout.
    if (basePdf.getPageCount() !== pdf.getPageCount()) return null;
    return { base: await restoreEditableAnnotations(pdf, basePdf, base), objects: parsed as OverlayObject[] };
  } catch { throw new Error('This PDF has damaged AsterPDF editing data. Keep the original and open a healthy copy.'); }
}

export async function attachOverlayPackage(bytes: Uint8Array, base: Uint8Array, objects: OverlayObject[]): Promise<Uint8Array> {
  if (!objects.length) return bytes;
  const pdf = await PDFDocument.load(bytes);
  pdf.catalog.set(BASE_KEY, pdf.context.register(pdf.context.flateStream(base)));
  pdf.catalog.set(OBJECTS_KEY, pdf.context.register(pdf.context.flateStream(encoder.encode(JSON.stringify(objects)))));
  pruneUnusedObjects(pdf);
  return new Uint8Array(await pdf.save());
}
const colorOf = (hex: string) => rgb(
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255
);

export async function embedOverlays(bytes: Uint8Array, objects: OverlayObject[], pages: OverlayPage[]): Promise<Uint8Array> {
  if (!objects.length) return bytes;
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontCache = new Map<string, typeof font>([['helvetica', font]]);
  const chooseFont = async (choice: OverlayObject['fontChoice'], appearance: TextAppearance = {}) => {
    if (!choice || choice === 'helvetica') {
      const name = appearance.bold ? appearance.italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold
        : appearance.italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
      const cached = fontCache.get(name);
      if (cached) return cached;
      const embedded = await pdf.embedFont(name); fontCache.set(name, embedded); return embedded;
    }
    const cached = fontCache.get(choice);
    if (cached) return cached;
    if (choice.startsWith('system:')) {
      pdf.registerFontkit(fontkit);
      const bytes = await window.aster.readInstalledFont(choice.slice(7), objects.filter((object) => object.fontChoice === choice).map((object) => object.text || '').join(''));
      const embedded = await pdf.embedFont(bytes);
      fontCache.set(choice, embedded);
      return embedded;
    }
    const url = choice === 'noto-sans' ? new URL('../../assets/fonts/NotoSans.ttf', import.meta.url)
      : choice === 'noto-serif' ? new URL('../../assets/fonts/NotoSerif.ttf', import.meta.url) : null;
    if (!url) throw new Error('Choose an available text font.');
    pdf.registerFontkit(fontkit);
    const response = await fetch(url);
    if (!response.ok) throw new Error('Could not load the selected text font.');
    const embedded = await pdf.embedFont(await response.arrayBuffer());
    fontCache.set(choice, embedded);
    return embedded;
  };
  const pageMap = new Map(pages.map((page) => [page.pageId, page]));
  const imageCache = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();
  for (const object of objects) {
    if (object.hidden) continue;
    const target = pageMap.get(object.pageId);
    if (!target) continue;
    const page = pdf.getPage(target.index);
    const view = target.viewport;
    const at = (x: number, y: number) => view.convertToPdfPoint(x * view.width, y * view.height);
    const strokeColor = colorOf(object.color);
    const width = Math.max(0, object.lineWidth);
    if (width === 0 && (object.kind === 'pen' || object.kind === 'line')) continue;
    const opacity = object.opacity ?? 1;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      const [startX, startY] = at(x1, y1);
      const [endX, endY] = at(x2, y2);
      page.drawLine({ start: { x: startX, y: startY }, end: { x: endX, y: endY }, thickness: width, color: strokeColor, opacity,
        lineCap: object.kind === 'pen' ? LineCapStyle.Round : LineCapStyle.Butt });
    };
    const left = object.x;
    const top = object.y;
    const right = left + object.width;
    const bottom = top + object.height;
    if (object.kind === 'pen' && object.points?.length) {
      for (let index = 1; index < object.points.length; index++) {
        const a = object.points[index - 1]; const b = object.points[index];
        line(left + a.x * object.width, top + a.y * object.height, left + b.x * object.width, top + b.y * object.height);
      }
    } else if (object.kind === 'line') line(left + (object.points?.[0]?.x || 0) * object.width,
      top + (object.points?.[0]?.y || 0) * object.height,
      left + (object.points?.[1]?.x ?? 1) * object.width, top + (object.points?.[1]?.y ?? 1) * object.height);
    else if (object.kind === 'rectangle' || object.kind === 'ellipse') {
      const [x, y] = at(left, top), [rx, ry] = at(right, top), [bx, by] = at(left, bottom);
      page.drawSvgPath(shapePath(object.kind, Math.hypot(rx - x, ry - y), Math.hypot(bx - x, by - y), object.radius ?? 0), {
        x, y, rotate: degrees(Math.atan2(ry - y, rx - x) * 180 / Math.PI),
        color: object.fill && !object.fillHidden ? colorOf(object.fill) : undefined, borderColor: strokeColor, borderWidth: width,
        opacity, borderOpacity: opacity,
      });
    } else if (object.kind === 'text' && object.text) {
      if (/[\u0590-\u05ff]/u.test(object.text))
        throw new Error('Hebrew text needs a shaped PDF font writer. The PDF was not changed.');
      const shaped = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(object.text) || object.fontChoice === 'noto-naskh-arabic';
      const fontSize = textSize(object);
      const chosen = shaped ? null : await chooseFont(object.fontChoice, object);
      const advance = object.textAdvance ?? chosen?.widthOfTextAtSize(object.text, fontSize) ?? object.width * view.width;
      const textLeft = left + (object.width - advance / view.width) * (object.textAlign === 'center' ? .5 : object.textAlign === 'right' ? 1 : 0);
      const decoration = (offset: number) => {
        const [x1, y1] = at(textLeft, top + offset / view.height), [x2, y2] = at(textLeft + advance / view.width, top + offset / view.height);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(.5, fontSize / 18), color: strokeColor, opacity });
      };
      if (object.underline) decoration(fontSize * 1.12);
      if (object.strikeThrough) decoration(fontSize * .68);
      if (!chosen) continue;
      const [x, y] = at(textLeft, top + fontSize / view.height);
      const [rightX, rightY] = at(textLeft + .1, top + fontSize / view.height);
      const angle = Math.atan2(rightY - y, rightX - x);
      const standard = !object.fontChoice || object.fontChoice === 'helvetica';
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), x, y));
      if (object.bold && !standard) page.pushOperators(setStrokingColor(strokeColor), setLineWidth(fontSize * .025), setTextRenderingMode(TextRenderingMode.FillAndOutline));
      try { page.drawText(object.text, { x: 0, y: 0, size: fontSize, font: chosen, color: strokeColor,
        ySkew: degrees(object.italic && !standard ? 12 : 0), lineHeight: fontSize * 1.2, opacity }); }
      catch { throw new Error('This text contains characters unsupported by the PDF text font. Use an image overlay for this text.'); }
      finally { page.pushOperators(popGraphicsState()); }
    } else if (object.kind === 'image' && object.image) {
      const match = /^data:image\/png;base64,(.+)$/.exec(object.image);
      if (!match) throw new Error('The inserted image is not a PNG.');
      let image = imageCache.get(object.image);
      if (!image) {
        image = await pdf.embedPng(Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0)));
        imageCache.set(object.image, image);
      }
      const [x, y] = at(left, bottom);
      const [rightX, rightY] = at(right, bottom);
      const [topX, topY] = at(left, top);
      page.drawImage(image, { x, y, width: Math.hypot(rightX - x, rightY - y), height: Math.hypot(topX - x, topY - y),
        rotate: degrees(Math.atan2(rightY - y, rightX - x) * 180 / Math.PI), opacity });
    }
  }
  return new Uint8Array(await pdf.save());
}
