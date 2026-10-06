import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';

export interface PdfComment {
  id: string;
  page: number;
  author: string;
  text: string;
  kind: string;
  date?: string;
  rect: [number, number, number, number];
  draft?: boolean;
}

export interface NewNote {
  id: string;
  page: number;
  x: number;
  y: number;
  author: string;
  text: string;
  date: string;
}

type AnnotationLike = {
  id?: string;
  annotationType?: number;
  rect?: number[];
  titleObj?: { str?: string };
  contentsObj?: { str?: string };
  title?: string;
  contents?: string;
  modificationDate?: string;
  creationDate?: string;
};

const COMMENT_KINDS: Record<number, string> = {
  1: 'Text note', 2: 'Link', 3: 'Free text', 4: 'Line', 5: 'Square',
  6: 'Circle', 7: 'Polygon', 8: 'Polyline', 9: 'Highlight',
  10: 'Underline', 11: 'Squiggly', 12: 'Strikeout', 13: 'Stamp',
  14: 'Caret', 15: 'Ink', 16: 'Popup', 17: 'File attachment'
};

export function readPageComments(annotations: AnnotationLike[], page: number): PdfComment[] {
  return annotations.flatMap((annotation, index) => {
    const text = (annotation.contentsObj?.str ?? annotation.contents ?? '').trim();
    const kind = COMMENT_KINDS[annotation.annotationType ?? 0] ?? 'Comment';
    // Popups are the display containers of parent annotations, not distinct comments.
    if (annotation.annotationType === 2 || annotation.annotationType === 16 || (!text && annotation.annotationType !== 1)) return [];
    const rect = annotation.rect;
    return [{
      id: annotation.id ?? `${page}-${index}`,
      page,
      author: (annotation.titleObj?.str ?? annotation.title ?? '').trim() || 'Unknown author',
      text,
      kind,
      date: annotation.modificationDate ?? annotation.creationDate,
      rect: rect && rect.length === 4 ? [rect[0], rect[1], rect[2], rect[3]] as [number, number, number, number] : [0, 0, 0, 0]
    }];
  });
}

function pdfDate(iso: string): string {
  const date = new Date(iso);
  return `D:${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}

/** Writes interoperable PDF /Text annotations; the author lives in /T and the note in /Contents. */
export async function addTextNotes(source: Uint8Array, notes: NewNote[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(source.slice(), { updateMetadata: false });
  const pages = document.getPages();
  for (const note of notes) {
    if (!Number.isInteger(note.page) || note.page < 1 || note.page > pages.length) throw new Error('Invalid note page.');
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y) || !note.author.trim() || !note.text.trim()) throw new Error('Invalid note.');
    const page = pages[note.page - 1];
    const { x: cropX, y: cropY, width, height } = page.getCropBox();
    const x = Math.max(cropX, Math.min(cropX + width - 24, note.x));
    const y = Math.max(cropY, Math.min(cropY + height - 24, note.y));
    const annotation = document.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('Text'),
      Rect: document.context.obj([x, y, x + 24, y + 24]),
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
    const ref = document.context.register(annotation);
    let annots = page.node.Annots();
    if (!annots) {
      annots = PDFArray.withContext(document.context);
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
  }
  return document.save({ useObjectStreams: false });
}
