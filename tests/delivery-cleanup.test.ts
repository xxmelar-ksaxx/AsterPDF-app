import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { prepareCompressionDocument } from '../src/pdf/delivery-cleanup';

const n = PDFName.of;

async function example() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText('Searchable text, including 42');
  pdf.getForm().createTextField('Quantity').setText('42');
  pdf.setTitle('Private project title');
  const { context: ctx } = pdf;
  const privateBytes = new Uint8Array(80000).fill(50);
  const privateRef = ctx.register(ctx.stream(privateBytes));
  const catalogKeys = ['Metadata', 'AsterPDFEditableBaseV1', 'AsterPDFEditableObjectsV1'];
  for (const key of catalogKeys) pdf.catalog.set(n(key), privateRef);
  page.node.set(n('Thumb'), ctx.register(ctx.stream(new Uint8Array(2000))));
  page.node.set(n('PieceInfo'), ctx.obj({ Illustrator: { Private: privateRef }, Workflow: { LastModified: PDFString.of('D:20260101') } }));
  const data = new Uint8Array(7000).fill(1);
  const dictionary = { Type: 'XObject', Subtype: 'Image', Width: 100, Height: 70, ColorSpace: 'DeviceGray', BitsPerComponent: 8 };
  const image = () => ctx.register(ctx.stream(data, dictionary));
  const first = image(), second = image();
  const other = ctx.register(ctx.stream(data, { ...dictionary, Decode: [1, 0] }));
  const tagged = ctx.register(ctx.stream(data, { ...dictionary, StructParent: 3 }));
  const resources = page.node.Resources()!;
  resources.set(n('XObject'), ctx.obj({ first, second, other, tagged }));
  const attachment = ctx.register(ctx.stream(data, { Type: 'EmbeddedFile' }));
  pdf.catalog.set(n('Names'), ctx.obj({ EmbeddedFiles: { Names: [PDFString.of('a.bin'), { EF: { F: attachment } }] } }));
  page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0,0,30,30], A: { S: 'URI', URI: PDFString.of('https://example.org') } })));
  ctx.register(ctx.stream(new Uint8Array(9000)));
  const bytes = await pdf.save();
  return { bytes, privateRef, attachment, first, second, other, tagged };
}

test('editable and delivery optimization preserve live resources and remove only the intended authoring data', async () => {
  const { bytes, privateRef, attachment, first, second, other, tagged } = await example();
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const edit = prepareCompressionDocument(pdf, false);
  assert.equal(edit.removedDeliveryData, false);
  assert.equal(edit.removedBytes, 16000);
  const xObjects = pdf.getPage(0).node.Resources()!.lookup(n('XObject'), PDFDict);
  assert.equal(xObjects.get(n('second')), first);
  assert.equal(xObjects.get(n('other')), other);
  assert.equal(xObjects.get(n('tagged')), tagged);
  assert.equal(pdf.context.lookup(second), undefined);
  assert.equal(pdf.catalog.get(n('AsterPDFEditableBaseV1')), privateRef);
  assert.equal(pdf.getTitle(), 'Private project title');

  const delivery = prepareCompressionDocument(pdf, true);
  assert.ok(delivery.removedDeliveryData);
  assert.equal(delivery.removedBytes, 82000);
  const reopened = await PDFDocument.load(await pdf.save(), { updateMetadata: false });
  assert.equal(reopened.context.trailerInfo.Info, undefined);
  assert.equal(reopened.catalog.get(n('Metadata')), undefined);
  assert.equal(reopened.context.lookup(privateRef), undefined);
  assert.ok(reopened.context.lookup(attachment) instanceof PDFRawStream);
  const page = reopened.getPage(0).node;
  assert.ok(page.Contents());
  assert.equal(page.Annots()!.size(), 1);
  assert.equal(reopened.getForm().getTextField('Quantity').getText(), '42');
  assert.ok(page.lookup(n('PieceInfo'), PDFDict).has(n('Workflow')));
  assert.ok(!page.has(n('Thumb')));
  assert.deepEqual(prepareCompressionDocument(reopened, true), { removedBytes: 0, removedDeliveryData: false });
});
test('identical embedded font programs can share bytes while their encodings remain separate', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const fontData = new Uint8Array(24000).fill(77);
  const fonts = PDFDict.withContext(pdf.context);
  for (const encoding of ['WinAnsiEncoding', 'MacRomanEncoding']) {
    const program = pdf.context.register(pdf.context.stream(fontData, { Length1: fontData.length }));
    const descriptor = pdf.context.register(pdf.context.obj({ Type: 'FontDescriptor', FontFile2: program }));
    fonts.set(n(encoding), pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'TrueType', Encoding: encoding, FontDescriptor: descriptor })));
  }
  page.node.set(n('Resources'), pdf.context.obj({ Font: fonts }));
  const loaded = await PDFDocument.load(await pdf.save(), { updateMetadata: false });
  assert.equal(prepareCompressionDocument(loaded, false).removedBytes, fontData.length);
  const savedFonts = loaded.getPage(0).node.Resources()!.lookup(n('Font'), PDFDict);
  const [a, b] = ['WinAnsiEncoding', 'MacRomanEncoding'].map(encoding => savedFonts.lookup(n(encoding), PDFDict));
  assert.notEqual(a.get(n('Encoding')), b.get(n('Encoding')));
  assert.equal(a.lookup(n('FontDescriptor'), PDFDict).get(n('FontFile2')), b.lookup(n('FontDescriptor'), PDFDict).get(n('FontFile2')));
});
