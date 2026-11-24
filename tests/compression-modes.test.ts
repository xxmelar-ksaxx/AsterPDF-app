import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { optimizePdf } from '../src/pdf/compression';

test('an editable copy retains signed bytes and delivery cannot strip signing data', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({
    DocMDP: { Type: 'Sig', ByteRange: [0, 4, 32, 100] }
  }));
  const bytes = await pdf.save();
  assert.equal(await optimizePdf(bytes, 'balanced', undefined, 'editable'), bytes);
  await assert.rejects(optimizePdf(bytes, 'lossless', undefined, 'delivery'), /digital signature/);
});

test('all three delivery levels strip source data even when a small document has little to compress', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('42');
  pdf.catalog.set(PDFName.of('AsterPDFEditableBaseV1'), pdf.context.register(pdf.context.flateStream('source')));
  const input = await pdf.save();
  for (const mode of ['editable', 'delivery'] as const) {
    for (const level of ['lossless', 'balanced', 'small'] as const) {
      const output = await optimizePdf(input, level, undefined, mode);
      const saved = await PDFDocument.load(output, { updateMetadata: false });
      assert.equal(saved.catalog.has(PDFName.of('AsterPDFEditableBaseV1')), mode === 'editable');
      assert.equal(saved.getPageCount(), 1);
    }
  }
});
