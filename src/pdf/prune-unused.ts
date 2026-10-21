import { PDFArray, PDFDict, PDFDocument, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';

/** Remove unreachable objects from a loaded PDF before replacing editing data.
 * pdf-lib otherwise serializes old, detached editing snapshots on every save.
 * Follow every trailer root and dictionary entry, including attachments/forms.
 */
export function pruneUnusedObjects(pdf: PDFDocument) {
  const pending: PDFObject[] = Object.values(pdf.context.trailerInfo).filter((value): value is PDFObject => Boolean(value));
  const refs = new Set<PDFRef>();
  const visited = new Set<PDFObject>();
  while (pending.length) {
    const item = pending.pop()!;
    if (visited.has(item)) continue;
    visited.add(item);
    if (item instanceof PDFRef) {
      refs.add(item);
      const target = pdf.context.lookup(item);
      if (target) pending.push(target);
    } else if (item instanceof PDFRawStream) pending.push(item.dict);
    else if (item instanceof PDFDict) pending.push(...item.values());
    else if (item instanceof PDFArray) pending.push(...item.asArray());
  }
  for (const [ref] of pdf.context.enumerateIndirectObjects()) {
    if (!refs.has(ref)) pdf.context.delete(ref);
  }
}
