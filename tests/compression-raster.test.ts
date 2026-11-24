import test from 'node:test';
import assert from 'node:assert/strict';
import pngFilters from 'pngjs/lib/filter-parse-sync';
import { predictedImage } from '../src/pdf/compression-predictor';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { optimizePdf } from '../src/pdf/compression';

test('lossless compression recovers eight-bit CMYK gradients exactly, including row starts', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const width = 256, height = 256, channels = 4;
  const samples = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) samples[(y * width + x) * channels + c] = (x + y * (c + 1)) & 255;
    }
  }
  const image = pdf.context.flateStream(samples, {
    Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Width: width, Height: height
  });
  const ref = pdf.context.register(image);
  page.node.setXObject(PDFName.of('Gradient'), ref);
  const bytes = await pdf.save();
  const output = await optimizePdf(bytes, 'lossless');
  assert.ok(output.length < bytes.length / 2);
  const restored = (await PDFDocument.load(output)).context.lookup(ref, PDFRawStream);
  assert.equal(restored.dict.lookup(PDFName.of('ColorSpace')), PDFName.of('DeviceCMYK'));
  assert.equal(restored.dict.lookup(PDFName.of('DecodeParms'))?.toString().includes('/Predictor 15'), true);
  const result = pngFilters.process(inflateSync(restored.contents), { width, height, bpp: channels, depth: 8 });
  assert.deepEqual(result, Buffer.from(samples));
});


test('reversible filters retain packed row padding and sixteen-bit samples', async () => {
  const pdf = await PDFDocument.create();
  for (const bits of [1, 2, 4, 16]) {
    const width = 117, height = 77;
    const size = height * Math.ceil(width * bits / 8);
    const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 71 + (i >>> 4)) & 255);
    const stream = pdf.context.stream(bytes, {
      Subtype: 'Image', ColorSpace: 'DeviceGray', BitsPerComponent: bits, Width: width, Height: height
    });
    const prediction = predictedImage(stream.dict, bytes)!;
    const decoded = pngFilters.process(Buffer.from(prediction.data), { width, height, bpp: 1, depth: bits });
    assert.deepEqual(decoded, Buffer.from(bytes));
  }
});

test('smaller CMYK photos retain all four ink separations and their decode mapping', async () => {
  const { optimizeImage } = await import('../src/pdf/compression-images');
  const pdf = await PDFDocument.create();
  const width = 2560, height = 32;
  const input = new Uint8Array(width * height * 4);
  let state = 234;
  for (let i = 0; i < input.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    input[i] = state >>> 24;
  }
  const decode = pdf.context.obj([1, 0, 0, 1, 0, 1, 0, 1]);
  const stream = pdf.context.flateStream(input, {
    Type: 'XObject', Subtype: 'Image', ColorSpace: 'DeviceCMYK', BitsPerComponent: 8,
    Width: width, Height: height, Decode: decode
  });
  const out = await optimizeImage(PDFRawStream.of(stream.dict, stream.getContents()), 'small');
  assert.ok(out);
  assert.equal(out.dict.get(PDFName.of('ColorSpace')), PDFName.of('DeviceCMYK'));
  assert.equal(out.dict.get(PDFName.of('Decode')), decode);
  assert.equal(out.dict.get(PDFName.of('Width'))?.toString(), '1280');
  const reduced = inflateSync(out.contents);
  assert.equal(reduced.length, input.length / 4);
  for (let c = 0; c < 4; c++) {
    assert.equal(reduced[c], Math.round((input[c] + input[c + 4] + input[width * 4 + c] + input[width * 4 + c + 4]) / 4));
  }
});
