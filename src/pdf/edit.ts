import { degrees, LineCapStyle, LineJoinStyle, lineTo, moveTo, PDFDocument, popGraphicsState,
  pushGraphicsState, rotateDegrees, scale, setLineCap, setLineJoin, setLineWidth, setStrokingRgbColor,
  stroke, translate } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { VectorSignature } from '../signatures/library';
import type { PlannedPage } from './page-plan';

export type PageEdit =
  | { type: 'move'; from: number; to: number }
  | { type: 'duplicate'; page: number }
  | { type: 'delete'; page: number }
  | { type: 'rotate'; page: number; degrees: -90 | 90 }
  | { type: 'batch'; pages: number[]; action: 'move-up' | 'move-down' | 'duplicate' | 'delete' | 'rotate-left' | 'rotate-right' };

function copyMetadata(from: PDFDocument, to: PDFDocument) {
  if (from.getTitle()) to.setTitle(from.getTitle()!);
  if (from.getAuthor()) to.setAuthor(from.getAuthor()!);
  if (from.getSubject()) to.setSubject(from.getSubject()!);
  if (from.getKeywords()) to.setKeywords(from.getKeywords()!.split(',').map((word) => word.trim()));
}

export async function composePagePlan(bytes: Uint8Array, plan: PlannedPage[]): Promise<Uint8Array> {
  const input = await PDFDocument.load(bytes);
  if (!plan.length || plan.some((page) => page.sourceIndex < 0 || page.sourceIndex >= input.getPageCount())) {
    throw new Error('The page arrangement is invalid.');
  }
  const output = await PDFDocument.create();
  copyMetadata(input, output);
  const copied = await output.copyPages(input, plan.map((page) => page.sourceIndex));
  copied.forEach((page, index) => {
    const sourceAngle = input.getPage(plan[index].sourceIndex).getRotation().angle;
    page.setRotation(degrees((sourceAngle + plan[index].turns * 90) % 360));
    output.addPage(page);
  });
  return new Uint8Array(await output.save());
}

export async function editPages(bytes: Uint8Array, edit: PageEdit): Promise<Uint8Array> {
  const input = await PDFDocument.load(bytes);
  const count = input.getPageCount();
  if (edit.type === 'batch') {
    const selected = new Set(edit.pages);
    if (!selected.size || [...selected].some((index) => index < 0 || index >= count)) throw new Error('Select valid pages first.');
    if (edit.action === 'rotate-left' || edit.action === 'rotate-right') {
      const increment = edit.action === 'rotate-left' ? -90 : 90;
      for (const index of selected) {
        const page = input.getPage(index);
        page.setRotation(degrees(((page.getRotation().angle + increment) % 360 + 360) % 360));
      }
      return new Uint8Array(await input.save());
    }
    if (edit.action === 'delete' && selected.size === count) throw new Error('A PDF needs at least one page.');
    let indices = Array.from({ length: count }, (_, index) => index);
    if (edit.action === 'delete') indices = indices.filter((index) => !selected.has(index));
    else if (edit.action === 'duplicate') indices = indices.flatMap((index) => selected.has(index) ? [index, index] : [index]);
    else if (edit.action === 'move-up') {
      for (let index = 1; index < indices.length; index += 1) {
        if (selected.has(indices[index]) && !selected.has(indices[index - 1])) [indices[index - 1], indices[index]] = [indices[index], indices[index - 1]];
      }
    } else {
      for (let index = indices.length - 2; index >= 0; index -= 1) {
        if (selected.has(indices[index]) && !selected.has(indices[index + 1])) [indices[index], indices[index + 1]] = [indices[index + 1], indices[index]];
      }
    }
    const output = await PDFDocument.create();
    copyMetadata(input, output);
    for (const page of await output.copyPages(input, indices)) output.addPage(page);
    return new Uint8Array(await output.save());
  }
  if (edit.type === 'rotate') {
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    const page = input.getPage(edit.page);
    const angle = page.getRotation().angle;
    page.setRotation(degrees(((angle + edit.degrees) % 360 + 360) % 360));
    return new Uint8Array(await input.save());
  }
  if (edit.type === 'delete' && count === 1) throw new Error('A PDF needs at least one page.');
  const indices = Array.from({ length: count }, (_, index) => index);
  if (edit.type === 'move') {
    if (edit.from < 0 || edit.from >= count || edit.to < 0 || edit.to >= count) throw new Error('Page is out of range.');
    indices.splice(edit.to, 0, indices.splice(edit.from, 1)[0]);
  } else if (edit.type === 'duplicate') {
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    indices.splice(edit.page + 1, 0, edit.page);
  } else {
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    indices.splice(edit.page, 1);
  }
  const output = await PDFDocument.create();
  copyMetadata(input, output);
  for (const page of await output.copyPages(input, indices)) output.addPage(page);
  return new Uint8Array(await output.save());
}

export async function appendPdfs(base: Uint8Array, additions: Uint8Array[], afterPage?: number): Promise<Uint8Array> {
  const result = await PDFDocument.load(base);
  let insertAt = afterPage === undefined ? result.getPageCount() : afterPage + 1;
  if (insertAt < 0 || insertAt > result.getPageCount()) throw new Error('Insertion point is out of range.');
  for (const bytes of additions) {
    const input = await PDFDocument.load(bytes);
    const pages = await result.copyPages(input, input.getPageIndices());
    for (const page of pages) result.insertPage(insertAt++, page);
  }
  return new Uint8Array(await result.save());
}

export type SignatureDraw = { pageIndex: number; dataUrl: string; vector?: VectorSignature; x: number; y: number; width: number; height: number; angle: number };

function drawVectorSignature(page: ReturnType<PDFDocument['getPage']>, placement: SignatureDraw, vector: VectorSignature): void {
  const radians = placement.angle * Math.PI / 180;
  const topLeftX = placement.x - placement.height * Math.sin(radians);
  const topLeftY = placement.y + placement.height * Math.cos(radians);
  page.pushOperators(pushGraphicsState(), translate(topLeftX, topLeftY), rotateDegrees(placement.angle),
    scale(placement.width / vector.width, -placement.height / vector.height),
    setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
  for (const ink of vector.strokes) {
    if (ink.points.length < 2) continue;
    const red = Number.parseInt(ink.color.slice(1, 3), 16) / 255;
    const green = Number.parseInt(ink.color.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(ink.color.slice(5, 7), 16) / 255;
    page.pushOperators(setStrokingRgbColor(red, green, blue), setLineWidth(ink.width),
      moveTo(ink.points[0].x, ink.points[0].y),
      ...ink.points.slice(1).map((point) => lineTo(point.x, point.y)), stroke());
  }
  page.pushOperators(popGraphicsState());
}

export async function embedSignatures(bytes: Uint8Array, placements: SignatureDraw[]): Promise<Uint8Array> {
  if (!placements.length) return bytes;
  const pdf = await PDFDocument.load(bytes);
  const images = new Map<string, Awaited<ReturnType<typeof pdf.embedPng>>>();
  for (const placement of placements) {
    if (placement.pageIndex < 0 || placement.pageIndex >= pdf.getPageCount()) throw new Error('A signature page is missing.');
    if (placement.vector) {
      drawVectorSignature(pdf.getPage(placement.pageIndex), placement, placement.vector);
      continue;
    }
    const match = /^data:image\/png;base64,(.+)$/.exec(placement.dataUrl);
    if (!match) throw new Error('A signature image is invalid.');
    let image = images.get(placement.dataUrl);
    if (!image) {
      image = await pdf.embedPng(Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0)));
      images.set(placement.dataUrl, image);
    }
    pdf.getPage(placement.pageIndex).drawImage(image, {
      x: placement.x, y: placement.y, width: placement.width, height: placement.height,
      rotate: degrees(placement.angle)
    });
  }
  return new Uint8Array(await pdf.save());
}

export type CompressionLevel = 'lossless' | 'balanced' | 'small';

export async function compressPdf(bytes: Uint8Array, level: CompressionLevel, onProgress?: (page: number, total: number) => void): Promise<Uint8Array> {
  if (level === 'lossless') {
    const pdf = await PDFDocument.load(bytes);
    const optimized = new Uint8Array(await pdf.save({ useObjectStreams: true, objectsPerTick: 50 }));
    return optimized.byteLength < bytes.byteLength ? optimized : bytes;
  }
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const input = await task.promise;
    const output = await PDFDocument.create();
    const dpi = level === 'small' ? 90 : 140;
    const quality = level === 'small' ? 0.5 : 0.75;
    for (let index = 1; index <= input.numPages; index += 1) {
      const sourcePage = await input.getPage(index);
      const natural = sourcePage.getViewport({ scale: 1 });
      const viewport = sourcePage.getViewport({ scale: dpi / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Canvas rendering is unavailable.');
      await sourcePage.render({ canvas, canvasContext: context, viewport }).promise;
      const imageBytes = new Uint8Array(await (await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Image encoding failed.')), 'image/jpeg', quality))).arrayBuffer());
      const image = await output.embedJpg(imageBytes);
      output.addPage([natural.width, natural.height]).drawImage(image, { x: 0, y: 0, width: natural.width, height: natural.height });
      canvas.width = canvas.height = 1;
      onProgress?.(index, input.numPages);
    }
    return new Uint8Array(await output.save());
  } finally { await task.destroy(); }
}
