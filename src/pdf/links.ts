import { PDFArray, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { quadBounds, type TextMarkupSelection } from './comments';

export function normalizeLink(value: string): string {
  const text = value.trim();
  if (!text || text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('Enter a valid website or email link.');
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ||
    (['http:', 'https:'].includes(url.protocol) && (!url.hostname || url.username || url.password))) {
    throw new Error('Use an http, https, mailto, or tel link.');
  }
  return url.href;
}

export async function addPdfLinks(bytes: Uint8Array, selections: TextMarkupSelection[], address: string): Promise<Uint8Array> {
  const url = normalizeLink(address);
  if (!selections.length) throw new Error('Select the text to link first.');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const selection of selections) {
    const page = pdf.getPages()[selection.page - 1], points = selection.quadPoints;
    if (!page || !Number.isInteger(selection.page) || !points.length || points.length % 8 || !points.every(Number.isFinite)) throw new Error('Invalid link selection.');
    let annots = page.node.Annots();
    if (!annots) { annots = PDFArray.withContext(pdf.context); page.node.set(PDFName.of('Annots'), annots); }
    // Each selected line gets its own hit area, leaving inter-line gaps alone.
    for (let index = 0; index < points.length; index += 8) {
      const quad = points.slice(index, index + 8);
      annots.push(pdf.context.register(pdf.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: quadBounds(quad), QuadPoints: quad, Border: [0, 0, 0], F: 4,
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) }, P: page.ref
      })));
    }
  }
  return pdf.save({ useObjectStreams: false });
}
