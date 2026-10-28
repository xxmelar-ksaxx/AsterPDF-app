import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import type { OverlayObject } from './overlays';

const assets = new Map<string, { blob: Blob; url?: string }>();
const KEY = PDFName.of('AsterPDFVideoAssetsV1');
export function storeVideo(id: string, blob: Blob) {
  const previous = assets.get(id); if (previous?.url) URL.revokeObjectURL(previous.url);
  assets.set(id, { blob });
}
export function clearVideos() {
  for (const value of assets.values()) if (value.url) URL.revokeObjectURL(value.url);
  assets.clear();
}
export function videoUrl(id: string) {
  const asset = assets.get(id);
  if (!asset) return undefined;
  return asset.url ??= URL.createObjectURL(asset.blob);
}
export function videoBlob(id: string) { return assets.get(id)?.blob; }

export async function writeVideoAssets(pdf: PDFDocument, objects: OverlayObject[]) {
  const refs = new Map<string, PDFRef>();
  const names = PDFArray.withContext(pdf.context);
  for (const object of objects) {
    if (object.kind !== 'video' || !object.videoId || refs.has(object.videoId)) continue;
    const blob = videoBlob(object.videoId);
    if (!blob) throw new Error('A video is unavailable. Reopen the PDF or add the video again before saving.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const stream = pdf.context.register(pdf.context.stream(bytes, { Type: 'EmbeddedFile', Subtype: 'video/mp4', Params: { Size: bytes.length } }));
    const spec = pdf.context.register(pdf.context.obj({ Type: 'Filespec', F: PDFString.of(`${object.videoId}.mp4`),
      UF: PDFHexString.fromText(object.name || 'Video.mp4'), EF: { F: stream, UF: stream } }));
    names.push(PDFString.of(object.videoId)); names.push(spec); refs.set(object.videoId, spec);
  }
  if (refs.size) { pdf.catalog.set(KEY, pdf.context.obj({ Names: names })); pdf.catalog.set(PDFName.of('Version'), PDFName.of('2.0')); }
  return refs;
}

/** Load embedded assets once, then exclude our media annotations from the
 * editable base. The saved PDF and its media catalog retain the single copy. */
export function restoreVideoAssets(pdf: PDFDocument, objects: OverlayObject[]) {
  const videos = objects.filter(object => object.kind === 'video');
  if (!videos.length) return;
  const tree = pdf.catalog.lookupMaybe(KEY, PDFDict);
  const names = tree?.lookupMaybe(PDFName.of('Names'), PDFArray);
  const loaded = new Set<string>();
  if (names) for (let i = 0; i + 1 < names.size(); i += 2) {
    const name = names.get(i);
    if (!(name instanceof PDFString || name instanceof PDFHexString)) continue;
    const id = name.decodeText();
    if (!videos.some(video => video.videoId === id)) continue;
    const spec = pdf.context.lookup(names.get(i + 1), PDFDict);
    const stream = pdf.context.lookup(spec.lookup(PDFName.of('EF'), PDFDict).get(PDFName.of('F')));
    if (!(stream instanceof PDFRawStream)) throw new Error('Invalid embedded video stream.');
    storeVideo(id, new Blob([decodePDFRawStream(stream).decode() as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })); loaded.add(id);
  }
  if (videos.some(video => !video.videoId || !loaded.has(video.videoId))) throw new Error('An embedded video is missing or damaged.');
  const ids = new Set(videos.map(video => video.id));
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annotation = pdf.context.lookup(annots.get(i));
      if (!(annotation instanceof PDFDict) || annotation.get(PDFName.of('Subtype')) !== PDFName.of('RichMedia')) continue;
      const id = annotation.get(PDFName.of('NM'));
      if ((id instanceof PDFString || id instanceof PDFHexString) && ids.has(id.decodeText())) annots.remove(i);
    }
  }
  pdf.catalog.delete(KEY);
}

export function addVideoAnnotation(pdf: PDFDocument, pageIndex: number, object: OverlayObject, asset: PDFRef, rect: number[], poster: { image: PDFRef; matrix: number[] }) {
  const page = pdf.getPage(pageIndex);
  const appearance = pdf.context.register(pdf.context.flateStream(`q ${poster.matrix.join(' ')} cm /Poster Do Q`, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]], Resources: { XObject: { Poster: poster.image } }
  }));
  const instance = pdf.context.register(pdf.context.obj({ Type: 'RichMediaInstance', Subtype: 'Video', Asset: asset,
    Params: { Type: 'RichMediaParams', Binding: 'Foreground' } }));
  const configuration = pdf.context.register(pdf.context.obj({ Type: 'RichMediaConfiguration', Subtype: 'Video', Instances: [instance] }));
  const annotation = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'RichMedia', Rect: rect, F: 4,
    NM: PDFString.of(object.id), P: page.ref, AP: { N: appearance },
    RichMediaContent: { Type: 'RichMediaContent', Assets: { Names: [PDFString.of(`${object.videoId}.mp4`), asset] }, Configurations: [configuration] },
    RichMediaSettings: { Type: 'RichMediaSettings', Activation: { Type: 'RichMediaActivation', Condition: 'XA', Configuration: configuration,
      Presentation: { Type: 'RichMediaPresentation', Style: 'Embedded', Toolbar: true, NavigationPane: false, Transparent: false } },
      Deactivation: { Type: 'RichMediaDeactivation', Condition: 'PI' } } }));
  page.node.addAnnot(annotation);
}
