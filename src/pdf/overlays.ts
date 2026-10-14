import { decodePDFRawStream, degrees, PDFDocument, PDFName, PDFRawStream, rgb, StandardFonts } from 'pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import fontkit from '@pdf-lib/fontkit';

export type OverlayKind = 'pen' | 'rectangle' | 'ellipse' | 'line' | 'text' | 'image';
export type OverlayObject = {
  id: string;
  pageId: string;
  kind: OverlayKind;
  x: number; y: number; width: number; height: number;
  color: string;
  lineWidth: number;
  fontSize?: number;
  points?: { x: number; y: number }[];
  text?: string;
  fontChoice?: 'helvetica' | 'noto-sans' | 'noto-serif' | 'noto-naskh-arabic' | `system:${string}`;
  image?: string;
};

export type OverlayPage = { pageId: string; index: number; viewport: PageViewport };
// Older editable PDFs stored text size as eight times the drawing width.
export const textSize = (object: OverlayObject) => object.fontSize ?? Math.max(8, object.lineWidth * 8);
const BASE_KEY = PDFName.of('AsterPDFEditableBaseV1');
const OBJECTS_KEY = PDFName.of('AsterPDFEditableObjectsV1');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function readOverlayPackage(bytes: Uint8Array): Promise<{ base: Uint8Array; objects: OverlayObject[] } | null> {
  const pdf = await PDFDocument.load(bytes);
  const baseRef = pdf.catalog.get(BASE_KEY);
  const objectsRef = pdf.catalog.get(OBJECTS_KEY);
  if (!baseRef && !objectsRef) return null;
  if (!baseRef || !objectsRef) throw new Error('This PDF has incomplete AsterPDF editing data.');
  try {
    const baseStream = pdf.context.lookup(baseRef);
    const objectsStream = pdf.context.lookup(objectsRef);
    if (!(baseStream instanceof PDFRawStream) || !(objectsStream instanceof PDFRawStream)) throw new Error('Invalid editing streams');
    const base = new Uint8Array(decodePDFRawStream(baseStream).decode());
    const parsed: unknown = JSON.parse(decoder.decode(decodePDFRawStream(objectsStream).decode()));
    if (!base.length || !Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' ||
      typeof item.id !== 'string' || typeof item.pageId !== 'string' || typeof item.kind !== 'string' ||
      !Number.isFinite(item.x) || !Number.isFinite(item.y) || !Number.isFinite(item.width) || !Number.isFinite(item.height) ||
      (item.fontSize !== undefined && (!Number.isFinite(item.fontSize) || item.fontSize < 4 || item.fontSize > 500)))) {
      throw new Error('Invalid editable objects');
    }
    await PDFDocument.load(base);
    return { base, objects: parsed as OverlayObject[] };
  } catch { throw new Error('This PDF has damaged AsterPDF editing data. Keep the original and open a healthy copy.'); }
}

export async function attachOverlayPackage(bytes: Uint8Array, base: Uint8Array, objects: OverlayObject[]): Promise<Uint8Array> {
  if (!objects.length) return bytes;
  const pdf = await PDFDocument.load(bytes);
  pdf.catalog.set(BASE_KEY, pdf.context.register(pdf.context.flateStream(base)));
  pdf.catalog.set(OBJECTS_KEY, pdf.context.register(pdf.context.flateStream(encoder.encode(JSON.stringify(objects)))));
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
  const chooseFont = async (choice: OverlayObject['fontChoice']) => {
    if (!choice || choice === 'helvetica') return font;
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
    const target = pageMap.get(object.pageId);
    if (!target) continue;
    const page = pdf.getPage(target.index);
    const view = target.viewport;
    const at = (x: number, y: number) => view.convertToPdfPoint(x * view.width, y * view.height);
    const strokeColor = colorOf(object.color);
    const width = Math.max(0.5, object.lineWidth);
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      const [startX, startY] = at(x1, y1);
      const [endX, endY] = at(x2, y2);
      page.drawLine({ start: { x: startX, y: startY }, end: { x: endX, y: endY }, thickness: width, color: strokeColor });
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
    else if (object.kind === 'rectangle') {
      line(left, top, right, top); line(right, top, right, bottom);
      line(right, bottom, left, bottom); line(left, bottom, left, top);
    } else if (object.kind === 'ellipse') {
      for (let step = 0; step < 48; step++) {
        const angleA = step * Math.PI / 24;
        const angleB = (step + 1) * Math.PI / 24;
        line(left + object.width * (0.5 + 0.5 * Math.cos(angleA)), top + object.height * (0.5 + 0.5 * Math.sin(angleA)),
          left + object.width * (0.5 + 0.5 * Math.cos(angleB)), top + object.height * (0.5 + 0.5 * Math.sin(angleB)));
      }
    } else if (object.kind === 'text' && object.text) {
      if (/[\u0590-\u05ff]/u.test(object.text))
        throw new Error('Hebrew text needs a shaped PDF font writer. The PDF was not changed.');
      if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(object.text) || object.fontChoice === 'noto-naskh-arabic') continue;
      const fontSize = textSize(object);
      const [x, y] = at(left, top + fontSize / view.height);
      const [rightX, rightY] = at(left + 0.1, top + fontSize / view.height);
      const angle = Math.atan2(rightY - y, rightX - x) * 180 / Math.PI;
      const chosen = await chooseFont(object.fontChoice);
      try { page.drawText(object.text, { x, y, size: fontSize, font: chosen, color: strokeColor, rotate: degrees(angle), lineHeight: fontSize * 1.2 }); }
      catch { throw new Error('This text contains characters unsupported by the PDF text font. Use an image overlay for this text.'); }
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
        rotate: degrees(Math.atan2(rightY - y, rightX - x) * 180 / Math.PI) });
    }
  }
  return new Uint8Array(await pdf.save());
}
