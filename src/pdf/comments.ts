import { commentRichText, readRichBold, type BoldRanges, type RichNode } from './comment-text';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';

export type MarkupKind = 'Highlight' | 'Strikeout' | 'Underline';
export const MARKUP_COLORS: Record<MarkupKind, string> = { Highlight: '#ffdf32', Strikeout: '#e5484d', Underline: '#2784eb' };
export type TextMarkupSelection = { page: number; text: string; quadPoints: number[] };
export function markupKind(kind: string): kind is MarkupKind { return kind === 'Highlight' || kind === 'Strikeout' || kind === 'Underline'; }
export function quadBounds(points: number[]): [number, number, number, number] {
  const xs = points.filter((_, index) => index % 2 === 0), ys = points.filter((_, index) => index % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export interface PdfComment {
  id: string;
  page: number;
  author: string;
  text: string;
  bold?: BoldRanges;
  kind: string;
  date?: string;
  rect: [number, number, number, number];
  draft?: boolean;
  quadPoints?: number[];
  color?: string;
  opacity?: number;
  replyTo?: string;
  replies?: PdfComment[];
}

export interface NewNote {
  id: string;
  page: number;
  x: number;
  y: number;
  author: string;
  text: string;
  bold?: BoldRanges;
  date: string;
  replyTo?: string;
  markup?: { kind: MarkupKind; quadPoints: number[]; color: string };
}

export function noteAsComment(note: NewNote, draft = false): PdfComment {
  return { id: note.id, page: note.page, author: note.author, text: note.text, bold: note.bold, date: note.date, draft, replyTo: note.replyTo,
    kind: note.markup?.kind ?? 'Text note', color: note.markup?.color, quadPoints: note.markup?.quadPoints,
    opacity: note.markup?.kind === 'Highlight' ? .35 : 1,
    rect: note.markup ? quadBounds(note.markup.quadPoints) : [note.x, note.y, note.x + 24, note.y + 24] };
}

export type CommentChange = {
  operationId: string;
  target: PdfComment;
  type: 'edit' | 'delete' | 'color';
  text?: string;
  bold?: BoldRanges;
  color?: string;
  date: string;
};

export type CommentOverride = { text?: string; bold?: BoldRanges; date?: string; deleted?: boolean; color?: string };

type AnnotationLike = {
  id?: string;
  annotationType?: number;
  rect?: number[];
  titleObj?: { str?: string };
  contentsObj?: { str?: string };
  title?: string;
  contents?: string;
  richText?: { str?: string; html?: RichNode } | null;
  modificationDate?: string;
  creationDate?: string;
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  rotation?: number;
  opacity?: number;
  it?: string;
  inReplyTo?: string | null;
  replyType?: string;
};

const COMMENT_KINDS: Record<number, string> = {
  1: 'Text note', 2: 'Link', 3: 'Free text', 4: 'Line', 5: 'Square',
  6: 'Circle', 7: 'Polygon', 8: 'Polyline', 9: 'Highlight',
  10: 'Underline', 11: 'Squiggly', 12: 'Strikeout', 13: 'Stamp',
  14: 'Caret', 15: 'Ink', 16: 'Popup', 17: 'File attachment'
};

export async function readAllPageComments(page: {
  getAnnotations(options: { intent: 'any' }): Promise<AnnotationLike[]>;
}, pageNumber: number): Promise<PdfComment[]> {
  // A conversation includes annotations whose on-page appearance is hidden.
  return readPageComments(await page.getAnnotations({ intent: 'any' }), pageNumber);
}

export function readPageComments(annotations: AnnotationLike[], page: number): PdfComment[] {
  return annotations.flatMap((annotation, index) => {
    // Acrobat can store the note only in /RC (rich text). Use PDF.js's plain
    // text projection; never insert annotation HTML into the application.
    const text = annotation.contentsObj?.str?.trim() || annotation.contents?.trim() || annotation.richText?.str?.trim() || '';
    const kind = COMMENT_KINDS[annotation.annotationType ?? 0] ?? 'Comment';
    // Popups are the display containers of parent annotations, not distinct comments.
    if (annotation.annotationType === 2 || annotation.annotationType === 16 || (!text && annotation.annotationType !== 1 && !markupKind(kind))) return [];
    const rect = annotation.rect;
    const quadPoints = annotation.quadPoints ? Array.from(annotation.quadPoints) : undefined;
    // PDF.js normalizes quadrilaterals to PDF-axis rectangles. Restore the
    // reading direction of markups authored on a rotated page in AsterPDF.
    if (quadPoints && annotation.it === 'AsterPDFTextMarkup') {
      const order = annotation.rotation === 90 ? [2, 0, 3, 1] : annotation.rotation === 180 ? [3, 2, 1, 0] : annotation.rotation === 270 ? [1, 3, 0, 2] : [0, 1, 2, 3];
      for (let offset = 0; offset < quadPoints.length; offset += 8) {
        const quad = quadPoints.slice(offset, offset + 8);
        quadPoints.splice(offset, 8, ...order.flatMap(index => quad.slice(index * 2, index * 2 + 2)));
      }
    }
    return [{
      id: annotation.id ?? `${page}-${index}`,
      page,
      author: (annotation.titleObj?.str ?? annotation.title ?? '').trim() || 'Unknown author',
      text,
      bold: readRichBold(annotation.richText?.html, text),
      kind,
      replyTo: annotation.replyType !== 'Group' ? annotation.inReplyTo || undefined : undefined,
      quadPoints: quadPoints?.length && quadPoints.length % 8 === 0 && quadPoints.every(Number.isFinite) ? quadPoints : undefined,
      color: annotation.color?.length === 3 ? '#' + Array.from(annotation.color).map(value => Math.round(value).toString(16).padStart(2, '0')).join('') : markupKind(kind) ? MARKUP_COLORS[kind] : undefined,
      opacity: typeof annotation.opacity === 'number' ? Math.max(0, Math.min(1, annotation.opacity)) : kind === 'Highlight' ? .35 : 1,
      date: annotation.modificationDate ?? annotation.creationDate,
      rect: rect && rect.length === 4 ? [rect[0], rect[1], rect[2], rect[3]] as [number, number, number, number] : [0, 0, 0, 0]
    }];
  });
}

/** Keep replies attached to their root, including imported nested conversations. */
export function commentThreads(comments: PdfComment[]): PdfComment[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const roots = new Map<string, PdfComment>();
  for (const comment of comments) {
    const root = commentRoot(comment, byId);
    if (!roots.has(root.id)) roots.set(root.id, { ...root, replyTo: undefined, replies: [] });
    if (comment.id !== root.id) roots.get(root.id)!.replies!.push(comment);
  }
  return [...roots.values()];
}

function commentRoot(comment: PdfComment, byId: Map<string, PdfComment>): PdfComment {
  const seen = new Set([comment.id]);
  let current = comment;
  while (current.replyTo) {
    const parent = byId.get(current.replyTo);
    if (!parent || parent.page !== comment.page) break;
    if (seen.has(parent.id)) return comment; // Malformed cycles must not hide content.
    seen.add(parent.id); current = parent;
  }
  return current;
}

export function inMarkupThread(comment: PdfComment, comments: PdfComment[]): boolean {
  return markupKind(commentRoot(comment, new Map(comments.map(item => [item.id, item]))).kind);
}

function writeMarkupAppearance(document: PDFDocument, annotation: PDFDict, kind: MarkupKind, points: number[], color: string, opacity = kind === 'Highlight' ? .35 : 1) {
  if (!points.length || points.length % 8 || !points.every(Number.isFinite) || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Invalid text markup.');
  const channels = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const commands = ['q', '/GS gs', `${channels.join(' ')} rg`, `${channels.join(' ')} RG`];
  for (let index = 0; index < points.length; index += 8) {
    const [ax, ay, bx, by, cx, cy, dx, dy] = points.slice(index, index + 8);
    if (kind === 'Highlight') commands.push(`${ax} ${ay} m ${bx} ${by} l ${dx} ${dy} l ${cx} ${cy} l h f`);
    else {
      const t = kind === 'Strikeout' ? .5 : .92;
      commands.push(`${Math.max(.7, Math.hypot(cx - ax, cy - ay) * .065)} w`,
        `${ax + (cx - ax) * t} ${ay + (cy - ay) * t} m ${bx + (dx - bx) * t} ${by + (dy - by) * t} l S`);
    }
  }
  commands.push('Q');
  const appearance = document.context.flateStream(commands.join('\n'), {
    Type: 'XObject', Subtype: 'Form', BBox: quadBounds(points),
    Resources: { ExtGState: { GS: { Type: 'ExtGState', ca: opacity, CA: opacity, BM: kind === 'Highlight' ? 'Multiply' : 'Normal' } } }
  });
  annotation.set(PDFName.of('C'), document.context.obj(channels));
  annotation.set(PDFName.of('CA'), PDFNumber.of(opacity));
  annotation.set(PDFName.of('AP'), document.context.obj({ N: document.context.register(appearance) }));
}

function pdfDate(iso: string): string {
  const date = new Date(iso);
  return `D:${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}

/** Writes interoperable PDF /Text annotations; the author lives in /T and the note in /Contents. */
export async function addTextNotes(source: Uint8Array, notes: NewNote[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  addNotesToDocument(document, notes);
  return document.save({ useObjectStreams: false });
}

export function addNotesToDocument(document: PDFDocument, notes: NewNote[]) {
  const pages = document.getPages();
  const pendingReplies: { note: NewNote; annotation: PDFDict }[] = [];
  for (const note of notes) {
    if (!Number.isInteger(note.page) || note.page < 1 || note.page > pages.length) throw new Error('Invalid note page.');
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y) || !note.author.trim() || (!note.markup && !note.text.trim())) throw new Error('Invalid note.');
    const page = pages[note.page - 1];
    const { x: cropX, y: cropY, width, height } = page.getCropBox();
    const x = Math.max(cropX, Math.min(cropX + width - 24, note.x));
    const y = Math.max(cropY, Math.min(cropY + height - 24, note.y));
    const annotation = document.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of(note.markup?.kind === 'Strikeout' ? 'StrikeOut' : note.markup?.kind ?? 'Text'),
      Rect: document.context.obj(note.markup ? quadBounds(note.markup.quadPoints) : [x, y, x + 24, y + 24]),
      Contents: PDFHexString.fromText(note.text.trim()),
      T: PDFHexString.fromText(note.author.trim()),
      M: PDFString.of(pdfDate(note.date)),
      CreationDate: PDFString.of(pdfDate(note.date)),
      NM: PDFString.of(note.id),
      Name: PDFName.of('Comment'),
      C: document.context.obj([1, 0.73, 0.12]),
      F: PDFNumber.of(4),
      Open: false,
      P: page.ref
    });
    if (note.text.trim()) annotation.set(PDFName.of('RC'), PDFString.of(commentRichText(note).replace(/[\\()]/g, char => `\\${char}`)));
    if (note.markup) {
      annotation.set(PDFName.of('QuadPoints'), document.context.obj(note.markup.quadPoints));
      const [ax, ay, bx, by] = note.markup.quadPoints;
      const angle = (Math.round(Math.atan2(by - ay, bx - ax) * 180 / Math.PI / 90) * 90 + 360) % 360;
      annotation.set(PDFName.of('Rotate'), PDFNumber.of(angle));
      annotation.set(PDFName.of('IT'), PDFName.of('AsterPDFTextMarkup'));
      writeMarkupAppearance(document, annotation, note.markup.kind, note.markup.quadPoints, note.markup.color);
    }
    const ref = document.context.register(annotation);
    let annots = page.node.Annots();
    if (!annots) {
      annots = PDFArray.withContext(document.context);
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
    if (note.replyTo) pendingReplies.push({ note, annotation });
  }
  // Resolve after all notes exist, so a new parent and its replies can be saved
  // in the same batch without relying on array order.
  for (const { note, annotation } of pendingReplies) {
    const annots = pages[note.page - 1].node.Annots()!;
    const matches = Array.from({ length: annots.size() }, (_, index) => {
      const reference = annots.get(index), target = document.context.lookup(reference);
      const name = target instanceof PDFDict ? target.get(PDFName.of('NM')) : undefined;
      const id = reference instanceof PDFRef ? `${reference.objectNumber}R${reference.generationNumber || ''}` : '';
      return { index, reference, target, matches: target !== annotation && (id === note.replyTo ||
        ((name instanceof PDFString || name instanceof PDFHexString) && name.decodeText() === note.replyTo)) };
    }).filter(item => item.matches);
    const parent = matches[0];
    if (matches.length !== 1 || !(parent.target instanceof PDFDict)) throw new Error('The reply’s parent comment could not be found.');
    const reference = parent.reference instanceof PDFRef ? parent.reference : document.context.register(parent.target);
    if (!(parent.reference instanceof PDFRef)) annots.set(parent.index, reference);
    annotation.set(PDFName.of('IRT'), reference);
    annotation.set(PDFName.of('RT'), PDFName.of('R'));
  }
}

/** Change annotation dictionaries in place, keeping their author and geometry. */
export async function changeComments(source: Uint8Array, changes: CommentChange[]): Promise<Uint8Array> {
  if (!changes.length) return source;
  const document = await PDFDocument.load(source, { updateMetadata: false });
  changeDocumentComments(document, changes);
  return document.save({ useObjectStreams: false });
}

export function changeDocumentComments(document: PDFDocument, changes: CommentChange[]) {
  const stringValue = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
  const refId = (value: unknown) => value instanceof PDFRef ? `${value.objectNumber}R${value.generationNumber || ''}` : '';
  for (const change of changes) {
    const page = document.getPages()[change.target.page - 1];
    const annots = page?.node.Annots();
    if (!annots) throw new Error('The comment could not be found in this PDF.');
    const entries = Array.from({ length: annots.size() }, (_, index) => {
      const reference = annots.get(index);
      return { index, reference, annotation: document.context.lookup(reference) };
    });
    let matches = entries.filter(({ reference, annotation }) => annotation instanceof PDFDict &&
      (refId(reference) === change.target.id || stringValue(annotation.get(PDFName.of('NM'))) === change.target.id));
    if (!matches.length) {
      // Direct annotation dictionaries have generated PDF.js IDs. A unique
      // content/author/location match also covers re-numbered editable copies.
      matches = entries.filter(({ annotation }) => {
        if (!(annotation instanceof PDFDict)) return false;
        const rect = annotation.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!rect || rect.size() !== 4) return false;
        const coordinates = rect.asArray().map((value) => value instanceof PDFNumber ? value.asNumber() : NaN);
        const subtype = annotation.get(PDFName.of('Subtype'));
        const expectedKind = change.target.kind === 'Text note' ? 'Text' : change.target.kind.replaceAll(' ', '');
        return subtype instanceof PDFName && subtype.decodeText().toLowerCase() === expectedKind.toLowerCase() &&
          stringValue(annotation.get(PDFName.of('Contents'))).trim() === change.target.text.trim() &&
          (stringValue(annotation.get(PDFName.of('T'))).trim() || 'Unknown author') === change.target.author &&
          Math.abs(Math.min(coordinates[0], coordinates[2]) - change.target.rect[0]) < .1 &&
          Math.abs(Math.max(coordinates[1], coordinates[3]) - change.target.rect[3]) < .1;
      });
    }
    if (matches.length !== 1) throw new Error('The comment could not be identified safely. Reopen the PDF and try again.');
    const { index, reference, annotation } = matches[0];
    if (!(annotation instanceof PDFDict)) throw new Error('Invalid PDF comment.');
    if (change.type === 'color') {
      if (!markupKind(change.target.kind) || !change.color) throw new Error('This comment does not support markup colors.');
      const points = annotation.lookupMaybe(PDFName.of('QuadPoints'), PDFArray)?.asArray().map(value => value instanceof PDFNumber ? value.asNumber() : NaN);
      if (!points) throw new Error('This markup has no text geometry.');
      writeMarkupAppearance(document, annotation, change.target.kind, points, change.color, change.target.opacity);
      annotation.set(PDFName.of('M'), PDFString.of(pdfDate(change.date)));
    } else if (change.type === 'edit') {
      if (!change.text?.trim()) throw new Error('A comment cannot be empty.');
      annotation.set(PDFName.of('Contents'), PDFHexString.fromText(change.text.trim()));
      annotation.set(PDFName.of('M'), PDFString.of(pdfDate(change.date)));
      annotation.set(PDFName.of('RC'), PDFString.of(commentRichText({ text: change.text, bold: change.bold }).replace(/[\\()]/g, char => `\\${char}`)));
      if (annotation.get(PDFName.of('Subtype')) === PDFName.of('FreeText')) annotation.delete(PDFName.of('AP'));
    } else {
      const popup = annotation.get(PDFName.of('Popup'));
      // Remove the note's popup too; it is not a separate user comment.
      for (let position = annots.size() - 1; position >= 0; position--) {
        const entry = entries[position];
        if (position === index || (popup && entry.reference === popup) ||
          (entry.annotation instanceof PDFDict && entry.annotation.get(PDFName.of('Subtype')) === PDFName.of('Popup') &&
            entry.annotation.get(PDFName.of('Parent')) === reference)) annots.remove(position);
        else if (entry.annotation instanceof PDFDict && entry.annotation.get(PDFName.of('IRT')) === reference) {
          // Preserve reply text as independent comments instead of orphaning it.
          entry.annotation.delete(PDFName.of('IRT')); entry.annotation.delete(PDFName.of('RT'));
        }
      }
    }
  }
}
