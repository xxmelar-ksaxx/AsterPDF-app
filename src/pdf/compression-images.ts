import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, type PDFObject } from 'pdf-lib';

const name = PDFName.of;
const imageKeys = new Set(['Type', 'Subtype', 'Width', 'Height', 'BitsPerComponent', 'ColorSpace', 'Filter', 'Length', 'Interpolate', 'Name', 'Intent', 'SMask', 'Decode', 'DecodeParms', 'Metadata', 'OC', 'StructParent']);
const imageSettings = {
  balanced: { longestEdge: 2400, quality: 0.83 },
  small: { longestEdge: 1280, quality: 0.58 }
};

async function readPixels(blob: Blob, flate: boolean, expected: number) {
  if (!flate) return blob.size === expected ? new Uint8Array(await blob.arrayBuffer()) : null;
  const reader = blob.stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const result = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return offset === expected ? result : null;
      if (chunk.value.length > expected - offset) { await reader.cancel(); return null; }
      result.set(chunk.value, offset);
      offset += chunk.value.length;
    }
  } finally { reader.releaseLock(); }
}

function channelsIn(space: PDFObject | undefined) {
  if (space === name('DeviceRGB')) return 3;
  if (space === name('DeviceGray')) return 1;
  if (space === name('DeviceCMYK')) return 4;
  if (!(space instanceof PDFArray)) return;
  if (space.lookup(0) === name('CalRGB')) return 3;
  if (space.lookup(0) === name('CalGray')) return 1;
  if (space.lookup(0) !== name('ICCBased')) return;
  const profile = space.lookup(1);
  return profile instanceof PDFRawStream ? profile.dict.lookupMaybe(name('N'), PDFNumber)?.asNumber() : undefined;
}

async function readPalette(space: PDFArray) {
  const last = space.lookupMaybe(2, PDFNumber)?.asNumber();
  if (last === undefined || !Number.isInteger(last) || last < 0 || last > 255) return;
  const table = space.lookup(3);
  const size = (last + 1) * 3;
  if (table instanceof PDFHexString || table instanceof PDFString) {
    const values = table.asBytes();
    return values.length === size ? values : undefined;
  }
  if (!(table instanceof PDFRawStream) || table.dict.has(name('DecodeParms'))) return;
  const filter = table.dict.lookup(name('Filter'));
  if (filter && filter !== name('FlateDecode')) return;
  return readPixels(new Blob([new Uint8Array(table.contents)]), !!filter, size);
}

function paeth(left: number, up: number, corner: number) {
  const p = left + up - corner;
  const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
  return a <= b && a <= c ? left : b <= c ? up : corner;
}

async function readSamples(stream: PDFRawStream, width: number, height: number, channels: number) {
  const params = stream.dict.lookup(name('DecodeParms'));
  if (params && !(params instanceof PDFDict)) return;
  const value = (key: string, fallback: number) => params?.lookupMaybe(name(key), PDFNumber)?.asNumber() ?? fallback;
  const predictor = value('Predictor', 1);
  if (predictor !== 1 && (value('Columns', 1) !== width || value('Colors', 1) !== channels || value('BitsPerComponent', 8) !== 8)) return;
  const png = predictor >= 10 && predictor <= 15;
  if (!png && predictor !== 1 && predictor !== 2) return;
  const rowBytes = width * channels;
  const encoded = await readPixels(new Blob([new Uint8Array(stream.contents)]), !!stream.dict.lookup(name('Filter')),
    (rowBytes + Number(png)) * height);
  if (!encoded || predictor === 1) return encoded;
  // Unfilter in place. After a PNG row indicator, the output position
  // always trails the unread bytes.
  for (let y = 0, src = 0, dst = 0; y < height; y++) {
    const type = png ? encoded[src++] : 1;
    if (type > 4) return;
    for (let x = 0; x < rowBytes; x++, src++, dst++) {
      const left = x >= channels ? encoded[dst - channels] : 0;
      const up = y ? encoded[dst - rowBytes] : 0;
      const corner = y && x >= channels ? encoded[dst - rowBytes - channels] : 0;
      let bias = 0;
      if (type === 1) bias = left;
      else if (type === 2) bias = up;
      else if (type === 3) bias = (left + up) >>> 1;
      else if (type === 4) bias = paeth(left, up, corner);
      encoded[dst] = encoded[src] + bias;
    }
  }
  return encoded.subarray(0, rowBytes * height);
}

// Downsample in the source component space. Sending CMYK through an RGB
// canvas would discard the black plate and change how ink is separated.
async function reduceComponents(stream: PDFRawStream, width: number, height: number, channels: number, scale: number) {
  if (scale >= 1 || stream.dict.lookup(name('Filter')) === name('DCTDecode')) return;
  const samples = await readSamples(stream, width, height, channels);
  if (!samples) return;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const output = new Uint8Array(outWidth * outHeight * channels);
  const sums = new Uint32Array(channels);
  for (let y = 0; y < outHeight; y++) {
    const top = Math.floor(y * height / outHeight);
    const bottom = Math.floor((y + 1) * height / outHeight);
    for (let x = 0; x < outWidth; x++) {
      const left = Math.floor(x * width / outWidth);
      const right = Math.floor((x + 1) * width / outWidth);
      sums.fill(0);
      for (let row = top; row < bottom; row++) {
        let offset = (row * width + left) * channels;
        for (let col = left; col < right; col++) {
          for (let c = 0; c < channels; c++) sums[c] += samples[offset++];
        }
      }
      const n = (right - left) * (bottom - top);
      for (let c = 0; c < channels; c++) output[(y * outWidth + x) * channels + c] = Math.round(sums[c] / n);
    }
  }
  const encoded = new Uint8Array(await new Response(new Blob([output]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  if (encoded.length >= stream.contents.length) return;
  const next = stream.dict.clone();
  next.set(name('Width'), PDFNumber.of(outWidth));
  next.set(name('Height'), PDFNumber.of(outHeight));
  next.set(name('Filter'), name('FlateDecode'));
  next.delete(name('DecodeParms'));
  return PDFRawStream.of(next, encoded);
}

export async function optimizeImage(stream: PDFRawStream, level: 'balanced' | 'small') {
  const dict = stream.dict;
  if (dict.keys().some(key => !imageKeys.has(key.decodeText())) ||
      dict.lookupMaybe(name('BitsPerComponent'), PDFNumber)?.asNumber() !== 8) return;
  const space = dict.lookup(name('ColorSpace'));
  const indexed = space instanceof PDFArray && space.lookup(0) === name('Indexed') ? space : undefined;
  const channels = channelsIn(indexed ? indexed.lookup(1) : space);
  if (!channels || ![1, 3, 4].includes(channels) || (indexed && channels !== 3)) return;
  const filter = dict.lookup(name('Filter'));
  if (filter && filter !== name('DCTDecode') && filter !== name('FlateDecode')) return;
  if (filter === name('DCTDecode') && (indexed || dict.has(name('DecodeParms')))) return;
  if (indexed && dict.has(name('Decode'))) {
    const decode = dict.lookupMaybe(name('Decode'), PDFArray);
    if (decode?.size() !== 2 || decode.lookupMaybe(0, PDFNumber)?.asNumber() !== 0 ||
        decode.lookupMaybe(1, PDFNumber)?.asNumber() !== 255) return;
  }
  const width = dict.lookupMaybe(name('Width'), PDFNumber)?.asNumber() ?? 0;
  const height = dict.lookupMaybe(name('Height'), PDFNumber)?.asNumber() ?? 0;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32000) ||
      width * height > 24_000_000 || stream.contents.length < 4096) return;
  const settings = imageSettings[level];
  const mask = dict.lookup(name('SMask'));
  // A matte has already been mixed into the color samples. Preserve its
  // pixel registration, especially at the edges of transparent artwork.
  if (mask instanceof PDFRawStream && mask.dict.has(name('Matte')) && indexed) return;
  const scale = mask instanceof PDFRawStream && mask.dict.has(name('Matte')) ? 1 : Math.min(1, settings.longestEdge / Math.max(width, height));
  if (channels !== 3) return reduceComponents(stream, width, height, channels, scale);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  let bitmap: ImageBitmap | undefined;
  try {
    if (filter === name('DCTDecode')) {
      bitmap = await createImageBitmap(new Blob([new Uint8Array(stream.contents)], { type: 'image/jpeg' }),
        { imageOrientation: 'none', colorSpaceConversion: 'none' });
      if (bitmap.width !== width || bitmap.height !== height) return;
    } else {
      const palette = indexed ? await readPalette(indexed) : undefined;
      if (indexed && !palette) return;
      const pixels = await readSamples(stream, width, height, palette ? 1 : 3);
      if (!pixels) return;
      const rgba = new ImageData(width, height);
      const values = palette ?? pixels;
      for (let i = 0, j = 0; j < rgba.data.length; i++, j += 4) {
        // Index values above hival map to the last palette entry.
        const k = palette ? Math.min(pixels[i] * 3, palette.length - 3) : i * 3;
        rgba.data[j] = values[k]; rgba.data[j + 1] = values[k + 1]; rgba.data[j + 2] = values[k + 2]; rgba.data[j + 3] = 255;
      }
      bitmap = await createImageBitmap(rgba);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: settings.quality });
    if (jpeg.type !== 'image/jpeg' || jpeg.size >= stream.contents.length) return;
    const next = dict.clone();
    if (indexed) {
      next.set(name('ColorSpace'), indexed.get(1));
      next.delete(name('Decode'));
    }
    next.delete(name('DecodeParms'));
    next.set(name('Width'), PDFNumber.of(canvas.width));
    next.set(name('Height'), PDFNumber.of(canvas.height));
    next.set(name('Filter'), name('DCTDecode'));
    return PDFRawStream.of(next, new Uint8Array(await jpeg.arrayBuffer()));
  } finally { bitmap?.close(); canvas.width = canvas.height = 1; }
}
