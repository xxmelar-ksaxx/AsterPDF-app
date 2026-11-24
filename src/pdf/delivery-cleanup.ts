import {
  PDFArray, PDFDict, PDFDocument, PDFInvalidObject, PDFName, PDFObject, PDFRawStream, PDFRef, PDFStream
} from 'pdf-lib';
import { pruneUnusedObjects } from './prune-unused';

const name = PDFName.of;
const authoringApps = ['Illustrator', 'InDesign', 'Photoshop'];
const imageKeys = new Set(['Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace',
  'Filter', 'DecodeParms', 'Decode', 'Length', 'Interpolate', 'ImageMask', 'Mask', 'SMask', 'Intent']);
const fontProgramKeys = new Set(['Length', 'Length1', 'Length2', 'Length3', 'Subtype', 'Filter', 'DecodeParms']);

function removeAuthoringData(pdf: PDFDocument) {
  let changed = false;
  const drop = (dict: PDFDict, key: string) => { if (dict.delete(name(key))) changed = true; };
  if (pdf.context.trailerInfo.Info) {
    delete pdf.context.trailerInfo.Info;
    changed = true;
  }
  for (const key of ['Metadata', 'AsterPDFEditableBaseV1', 'AsterPDFEditableObjectsV1']) drop(pdf.catalog, key);
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj;
    if (!(dict instanceof PDFDict)) continue;
    const type = dict.get(name('Type'));
    const isPage = type === name('Page');
    const isXObject = obj instanceof PDFStream && (type === name('XObject') || dict.get(name('Subtype')) === name('Form'));
    if (isPage) drop(dict, 'Thumb');
    if (dict !== pdf.catalog && !isPage && !isXObject) continue;
    drop(dict, 'Metadata');
    // Page-piece dictionaries can also hold unrelated extensions. Remove only
    // known design applications, leaving other producers' entries intact.
    const pieceInfo = dict.lookup(name('PieceInfo'));
    if (!(pieceInfo instanceof PDFDict) || !authoringApps.some(app => pieceInfo.has(name(app)))) continue;
    const retained = pieceInfo.clone();
    for (const app of authoringApps) retained.delete(name(app));
    if (retained.keys().length) dict.set(name('PieceInfo'), retained);
    else dict.delete(name('PieceInfo'));
    changed = true;
  }
  return changed;
}

function identicalContents(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Only pool resource streams with identical dictionaries and encoded bytes.
 * A font program can be shared independently of font encodings and ToUnicode.
 * Tagged or application-specific image streams may have distinct identities.
 */
function duplicateResources(objects: [PDFRef, PDFObject][]) {
  const programs = new Set<PDFRef>();
  for (const [, dict] of objects) {
    if (!(dict instanceof PDFDict) || dict.get(name('Type')) !== name('FontDescriptor')) continue;
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      const ref = dict.get(name(key));
      if (ref instanceof PDFRef) programs.add(ref);
    }
  }
  const groups = new Map<string, { ref: PDFRef; bytes: Uint8Array }[]>();
  const duplicates = new Map<PDFRef, PDFRef>();
  for (const [ref, stream] of objects) {
    if (!(stream instanceof PDFRawStream) || stream.contents.length < 128) continue;
    const font = programs.has(ref);
    if (!font && stream.dict.get(name('Subtype')) !== name('Image')) continue;
    const allowed = font ? fontProgramKeys : imageKeys;
    if (stream.dict.keys().some(key => !allowed.has(key.decodeText()))) continue;
    const entries = stream.dict.entries().filter(([key]) => key !== name('Length'));
    const dictionary = entries.map(([key, value]) => [key.toString(), value.toString()]).sort(([a], [b]) => a.localeCompare(b));
    const bytes = stream.contents;
    // Bound the common case of many equally sized raw tiles. Compare full
    // contents before merging even when the small fingerprint matches.
    const sample = Array.from({ length: 16 }, (_, i) => bytes[Math.floor(i * (bytes.length - 1) / 15)]);
    const key = JSON.stringify([font, dictionary, bytes.length, sample]);
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, bucket = []);
    const match = bucket.find(item => identicalContents(item.bytes, bytes));
    if (match) duplicates.set(ref, match.ref);
    else bucket.push({ ref, bytes });
  }
  if (!duplicates.size) return;
  const pending: PDFObject[] = objects.map(([, obj]) => obj);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const item = pending.pop()!;
    if (seen.has(item)) continue;
    seen.add(item);
    const container = item instanceof PDFStream ? item.dict : item;
    if (container instanceof PDFDict) {
      for (const [key, value] of container.entries()) {
        if (value instanceof PDFRef) {
          const first = duplicates.get(value);
          if (first) container.set(key, first);
        } else if (value instanceof PDFArray || value instanceof PDFDict) pending.push(value);
      }
    } else if (container instanceof PDFArray) {
      for (let i = 0; i < container.size(); i++) {
        const value = container.get(i);
        if (value instanceof PDFRef) {
          const first = duplicates.get(value);
          if (first) container.set(i, first);
        } else if (value instanceof PDFArray || value instanceof PDFDict) pending.push(value);
      }
    }
  }
}

export function prepareCompressionDocument(pdf: PDFDocument, delivery: boolean) {
  const before = pdf.context.enumerateIndirectObjects();
  // An opaque, unparsed object can contain references the graph walker cannot see.
  if (before.some(([, obj]) => obj instanceof PDFInvalidObject)) {
    if (delivery) throw new Error('This PDF has unreadable objects. Use an editable preset to keep its original data.');
    return { removedBytes: 0, removedDeliveryData: false };
  }
  const removedDeliveryData = delivery && removeAuthoringData(pdf);
  duplicateResources(before);
  pruneUnusedObjects(pdf);
  let removedBytes = 0;
  for (const [ref, object] of before) {
    // Stream data contributes its encoded size. Dictionaries may be packed
    // together, so estimating them at their uncompressed length is misleading.
    if (!pdf.context.lookup(ref) && object instanceof PDFRawStream) removedBytes += object.contents.length;
  }
  return { removedBytes, removedDeliveryData };
}
