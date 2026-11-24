import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFObject } from 'pdf-lib';

const key = PDFName.of;
const MAX_PIXELS_BYTES = 64 * 1024 * 1024;

export function colorChannels(space: PDFObject | undefined) {
  if (space === key('DeviceGray')) return 1;
  if (space === key('DeviceRGB')) return 3;
  if (space === key('DeviceCMYK')) return 4;
  if (!(space instanceof PDFArray)) return 0;
  const kind = space.lookup(0);
  if (kind === key('Indexed') || kind === key('Separation') || kind === key('CalGray')) return 1;
  if (kind === key('CalRGB') || kind === key('Lab')) return 3;
  if (kind === key('ICCBased')) {
    const profile = space.lookup(1);
    if (profile instanceof PDFRawStream) return profile.dict.lookupMaybe(key('N'), PDFNumber)?.asNumber() ?? 0;
  }
  return 0;
}

function paeth(left: number, up: number, diagonal: number) {
  const p = left + up - diagonal;
  const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - diagonal);
  return a <= b && a <= c ? left : b <= c ? up : diagonal;
}

// PNG filters are reversible byte transforms. Choose a filter per row using
// sampled residuals, then encode every byte, including packed-row padding.
function filterRows(input: Uint8Array, stride: number, height: number, pixelBytes: number) {
  const output = new Uint8Array(input.length + height);
  const costs = new Float64Array(5);
  const step = Math.max(1, Math.floor(stride / 160));
  for (let row = 0; row < height; row++) {
    const start = row * stride, dest = start + row;
    costs.fill(0);
    for (let x = 0; x < stride; x += step) {
      const i = start + x, v = input[i], l = x >= pixelBytes ? input[i - pixelBytes] : 0;
      const u = row ? input[i - stride] : 0, d = row && x >= pixelBytes ? input[i - stride - pixelBytes] : 0;
      const score = (predict: number) => Math.abs(((v - predict + 128) & 255) - 128);
      costs[0] += score(0); costs[1] += score(l); costs[2] += score(u);
      costs[3] += score((l + u) >>> 1); costs[4] += score(paeth(l, u, d));
    }
    const filter = costs.indexOf(Math.min(...costs));
    output[dest] = filter;
    if (!filter) { output.set(input.subarray(start, start + stride), dest + 1); continue; }
    for (let x = 0; x < stride; x++) {
      const i = start + x, l = x >= pixelBytes ? input[i - pixelBytes] : 0, u = row ? input[i - stride] : 0;
      let predicted = l;
      if (filter === 2) predicted = u;
      else if (filter === 3) predicted = (l + u) >>> 1;
      else if (filter === 4) predicted = paeth(l, u, row && x >= pixelBytes ? input[i - stride - pixelBytes] : 0);
      output[dest + 1 + x] = input[i] - predicted;
    }
  }
  return output;
}

export function predictedImage(dict: PDFDict, pixels: Uint8Array) {
  if (dict.lookup(key('Subtype')) !== key('Image')) return;
  const params = dict.lookup(key('DecodeParms'));
  if (params && (!(params instanceof PDFDict) || (params.lookupMaybe(key('Predictor'), PDFNumber)?.asNumber() ?? 1) !== 1)) return;
  const number = (k: string) => dict.lookupMaybe(key(k), PDFNumber)?.asNumber() ?? 0;
  const colors = colorChannels(dict.lookup(key('ColorSpace')));
  const bits = number('BitsPerComponent'), width = number('Width'), height = number('Height');
  if (![1, 3, 4].includes(colors) || ![1, 2, 4, 8, 16].includes(bits) || !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) || width < 1 || height < 1) return;
  const stride = Math.ceil(width * colors * bits / 8);
  if (height * stride !== pixels.length || pixels.length + height > MAX_PIXELS_BYTES) return;
  const data = filterRows(pixels, stride, height, Math.ceil(colors * bits / 8));
  return { data, params: dict.context.obj({ Predictor: 15, Colors: colors, BitsPerComponent: bits, Columns: width }) };
}
