import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';

function annotationState(pdf: PDFDocument, object: PDFObject | undefined, seen = new Set<string>()): string {
  if (!object) return '';
  if (object instanceof PDFRef) {
    const id = object.toString();
    if (seen.has(id)) return id;
    seen.add(id);
    return `${id}:${annotationState(pdf, pdf.context.lookup(object), seen)}`;
  }
  if (object instanceof PDFArray) return `[${object.asArray().map(item => annotationState(pdf, item, seen)).join(',')}]`;
  if (object instanceof PDFRawStream) return `${annotationState(pdf, object.dict, seen)}:${object.getContents().join(',')}`;
  if (object instanceof PDFDict) return object.entries()
    // /P points into the page tree, not the comment. Following it would compare
    // the flattened artwork too, and traverse the whole document.
    .filter(([key]) => key !== PDFName.of('P'))
    .sort(([a], [b]) => a.toString().localeCompare(b.toString()))
    .map(([key, value]) => `${key}:${annotationState(pdf, value, seen)}`).join('|');
  return object.toString();
}

/** Restore editable page content without reverting annotations saved elsewhere. */
export async function restoreEditableAnnotations(current: PDFDocument, base: PDFDocument, baseBytes: Uint8Array): Promise<Uint8Array> {
  const currentPages = current.getPages(), basePages = base.getPages();
  if (currentPages.length !== basePages.length) throw new Error('Editable page count differs from the current PDF.');
  const changed = currentPages.some((page, index) =>
    annotationState(current, page.node.Annots()) !== annotationState(base, basePages[index].node.Annots()));
  if (!changed) return baseBytes;

  // Keep the current PDF as the container. Its annotation IDs, /IRT links,
  // popups, appearance streams and deletions stay intact. Only the flattened
  // page artwork is replaced with the editable base's original content.
  for (const page of basePages) page.node.delete(PDFName.of('Annots'));
  const restoredPages = await current.copyPages(base, base.getPageIndices());
  for (let index = 0; index < currentPages.length; index++) {
    for (const name of ['Contents', 'Resources']) {
      const key = PDFName.of(name), value = restoredPages[index].node.get(key);
      if (value) currentPages[index].node.set(key, value);
      else currentPages[index].node.delete(key);
    }
  }
  for (const name of ['AsterPDFEditableBaseV1', 'AsterPDFEditableObjectsV1']) {
    const key = PDFName.of(name), ref = current.catalog.get(key);
    current.catalog.delete(key);
    if (ref instanceof PDFRef) current.context.delete(ref);
  }
  return current.save({ useObjectStreams: false });
}
