import { compressionSamples } from './compression-sample';
import { predictedImage } from './compression-predictor';
import { prepareCompressionDocument } from './delivery-cleanup';
import { optimizeImage } from './compression-images';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFObject } from 'pdf-lib';

export type CompressionMode = 'editable' | 'delivery';
export type CompressionLevel = 'lossless' | 'balanced' | 'small';
const name = PDFName.of;
const streamLimit = 64 * 1024 * 1024;

async function deflate(input: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([new Uint8Array(input)]).stream()
    .pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
}

async function inflateLimited(input: Uint8Array) {
  let total = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length;
      if (total > streamLimit) throw new Error('Stream exceeds optimization working limit.');
      controller.enqueue(chunk);
    }
  });
  return new Uint8Array(await new Response(new Blob([new Uint8Array(input)]).stream()
    .pipeThrough(new DecompressionStream('deflate')).pipeThrough(limit)).arrayBuffer());
}

async function packStream(stream: PDFRawStream) {
  const dict = stream.dict;
  const filter = dict.lookup(name('Filter'));
  // Archival profiles require the XMP metadata stream to remain unfiltered.
  if (dict.lookup(name('Type')) === name('Metadata')) return;
  if ((filter && filter !== name('FlateDecode')) || dict.has(name('F')) || (!filter && dict.has(name('DecodeParms'))) ||
      stream.contents.length < 128 || stream.contents.length > streamLimit) return;
  const decoded = filter ? await inflateLimited(stream.contents).catch(() => undefined) : stream.contents;
  if (!decoded) return;
  const predicted = predictedImage(dict, decoded);
  let compressed = await deflate(decoded);
  const next = dict.clone();
  if (predicted) {
    const filtered = await deflate(predicted.data);
    if (filtered.length + 64 < compressed.length && filtered.length + 64 < stream.contents.length) {
      compressed = filtered;
      next.set(name('DecodeParms'), predicted.params);
    }
  }
  if (compressed.length + 24 >= stream.contents.length) return;
  next.set(name('Filter'), name('FlateDecode'));
  return PDFRawStream.of(next, compressed);
}

async function loadForCompression(bytes: Uint8Array) {
  // Inspect encryption status without attempting to decode any protected streams.
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  if (pdf.isEncrypted) throw new Error('Open an unencrypted copy before compressing this PDF.');
  return pdf;
}

function hasSignedByteRange(pdf: PDFDocument) {
  const pending = pdf.context.enumerateIndirectObjects().map(([, obj]) => obj);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const object = pending.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    const value = object instanceof PDFRawStream ? object.dict : object;
    if (value instanceof PDFDict && value.has(name('ByteRange'))) return true;
    // Signature dictionaries may also be direct values inside form fields.
    const children = value instanceof PDFDict ? value.values() : value instanceof PDFArray ? value.asArray() : [];
    for (const child of children) if (child instanceof PDFDict || child instanceof PDFArray) pending.push(child);
  }
  return false;
}

function collectImageMasks(objects: ReturnType<PDFDocument['context']['enumerateIndirectObjects']>) {
  const masks = new Set<PDFRawStream>();
  for (const [, object] of objects) {
    if (!(object instanceof PDFRawStream) || object.dict.lookup(name('Subtype')) !== name('Image')) continue;
    for (const key of ['Mask', 'SMask']) {
      const mask = object.dict.lookup(name(key));
      if (mask instanceof PDFRawStream) masks.add(mask);
    }
  }
  return masks;
}

export async function optimizePdf(bytes: Uint8Array, level: CompressionLevel, progress?: (message: string) => void, mode: CompressionMode = 'editable') {
  const pdf = await loadForCompression(bytes);
  if (hasSignedByteRange(pdf)) {
    if (mode === 'delivery') throw new Error('Removing editing data would invalidate this PDF’s digital signature.');
    return bytes;
  }
  const cleanup = prepareCompressionDocument(pdf, mode === 'delivery');
  const objects = pdf.context.enumerateIndirectObjects();
  const masks = collectImageMasks(objects);
  for (let i = 0; i < objects.length; i++) {
    const [ref, stream] = objects[i];
    if (!(stream instanceof PDFRawStream)) continue;
    if (i % 25 === 0) progress?.(`Optimizing PDF objects · ${Math.round(i / objects.length * 100)}%`);
    const packed = await packStream(stream).catch(() => undefined);
    const image = level !== 'lossless' && !masks.has(stream) && stream.dict.lookup(name('Subtype')) === name('Image')
      ? await optimizeImage(stream, level).catch(() => undefined) : undefined;
    const best = packed && image ? (packed.contents.length <= image.contents.length ? packed : image) : packed ?? image;
    if (best) pdf.context.assign(ref, best);
  }
  progress?.('Packing PDF objects…');
  const result = await pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
  return cleanup.removedDeliveryData || result.length < bytes.length ? result : bytes;
}

export type CompressionEstimate = { pages: number; sizes: Record<CompressionLevel, number> };

export async function estimatePdf(bytes: Uint8Array, mode: CompressionMode = 'editable'): Promise<CompressionEstimate> {
  const pdf = await loadForCompression(bytes);
  const count = pdf.getPageCount();
  const pages = Math.min(count, 4);
  const sizes = { lossless: bytes.length, balanced: bytes.length, small: bytes.length };
  if (hasSignedByteRange(pdf)) {
    if (mode === 'delivery') throw new Error('Removing editing data would invalidate this PDF’s digital signature.');
    return { pages, sizes };
  }
  const cleanup = prepareCompressionDocument(pdf, mode === 'delivery');
  const baseline = Math.max(1, bytes.length - cleanup.removedBytes);
  sizes.lossless = sizes.balanced = sizes.small = baseline;
  const objects = pdf.context.enumerateIndirectObjects();

  const masks = collectImageMasks(objects);
  const { all, sampled } = compressionSamples(pdf, masks);

  // Project savings onto comparable stream bytes only. Attachments, fonts,
  // and other fixed overhead remain part of the current file size.
  const groups = new Map<string, { total: number; sample: number; savings: typeof sizes }>();
  for (const [stream, groupKey] of all) {
    const image = stream.dict.lookup(name('Subtype')) === name('Image');
    const group = groups.get(groupKey) ?? { total: 0, sample: 0, savings: { lossless: 0, balanced: 0, small: 0 } };
    groups.set(groupKey, group);
    const size = stream.contents.length;
    group.total += size;
    if (!sampled.has(stream)) continue;
    group.sample += size;
    const packed = await packStream(stream).catch(() => undefined);
    const packedSize = packed?.contents.length ?? size;
    group.savings.lossless += size - packedSize;
    for (const level of ['balanced', 'small'] as const) {
      const replacement = image && !masks.has(stream) ? await optimizeImage(stream, level).catch(() => undefined) : undefined;
      group.savings[level] += size - Math.min(replacement?.contents.length ?? size, packedSize);
    }
  }
  for (const group of groups.values()) {
    if (!group.sample) continue;
    for (const level of ['lossless', 'balanced', 'small'] as const) {
      sizes[level] -= Math.round(group.total * group.savings[level] / group.sample);
    }
  }
  for (const level of ['lossless', 'balanced', 'small'] as const) sizes[level] = Math.max(1, sizes[level]);
  return { pages, sizes };
}
