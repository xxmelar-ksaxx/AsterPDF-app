const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { PNG } = require('pngjs');
const { engine, withDocument } = require('./original-text.cjs');
const { textGroupObjects } = require('./shaped-text.cjs');
const { transformPage } = require('./original-transforms.cjs');

// Render only: never generate PDF content or write the user's file. Splitting
// at the object preserves the artwork behind it and the objects in front.
async function renderOriginalPreview(bytes, pageIndex, index, width, height, rotation, transforms = []) {
  if (![pageIndex, index, width, height, rotation].every(Number.isInteger) || pageIndex < 0 || index < 0 ||
      width < 1 || height < 1 || width * height > 4_000_000 || ![0, 90, 180, 270].includes(rotation)) throw new Error('Invalid drag preview.');
  const p = await engine();
  return withDocument(p, bytes, document => {
    if (pageIndex >= p.FPDF_GetPageCount(document)) throw new Error('Invalid preview page.');
    const page = p.FPDF_LoadPage(document, pageIndex);
    if (!page) throw new Error('Could not read the preview page.');
    let bitmap = 0, ptr = 0;
    try {
      const count = p.FPDFPage_CountObjects(page);
      if (index >= count) throw new Error('The selected object changed.');
      const selected = p.FPDFPage_GetObject(page, index);
      transformPage(p, page, transforms.filter(item=>item.pageIndex===pageIndex&&item.index!==index), true);
      const members = new Set(p.FPDFPageObj_GetType(selected) === 1 ? textGroupObjects(p, page, selected) : [selected]);
      ptr = p.pdfium.wasmExports.malloc(8);
      const objects = Array.from({ length: count }, (_, i) => {
        const object = p.FPDFPage_GetObject(page, i);
        const active = !p.FPDFPageObj_GetIsActive(object, ptr) || !!p.pdfium.getValue(ptr, 'i32');
        return { object, active, layer: members.has(object) ? 1 : i < index ? 0 : 2 };
      });
      bitmap = p.FPDFBitmap_Create(width, height, 1);
      if (!bitmap) throw new Error('Could not allocate the drag preview.');
      const extraRotation = ((rotation / 90 - p.FPDFPage_GetRotation(page)) % 4 + 4) % 4;
      const render = layer => {
        for (const item of objects) p.FPDFPageObj_SetIsActive(item.object, item.active && item.layer === layer);
        p.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, layer === 0 ? 0xffffffff : 0);
        p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, extraRotation, 0);
        const png = new PNG({ width, height }), buffer = p.FPDFBitmap_GetBuffer(bitmap), stride = p.FPDFBitmap_GetStride(bitmap);
        const memory = p.pdfium.HEAPU8;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const from = buffer + y * stride + x * 4, to = (y * width + x) * 4;
          png.data[to] = memory[from + 2]; png.data[to + 1] = memory[from + 1];
          png.data[to + 2] = memory[from]; png.data[to + 3] = memory[from + 3];
        }
        return Uint8Array.from(PNG.sync.write(png, { deflateLevel: 1 }));
      };
      const layers = [0, 1, 2].map(render);
      const type = p.FPDFPageObj_GetType(selected);
      if (type === 1 || type === 2) {
        const paints = [...members].map(object => {
          if (p.FPDFPageObj_GetType(object) === 2 && p.FPDFPath_GetDrawMode(object, ptr, ptr+4))
            return { object, path: true, fill: p.pdfium.getValue(ptr,'i32'), stroke: !!p.pdfium.getValue(ptr+4,'i32') };
          const mode = p.FPDFTextObj_GetTextRenderMode(object);
          return { object, path: false, fill: [0,2,4,6].includes(mode), stroke: [1,2,5,6].includes(mode) };
        });
        // Separate paint layers once. Color scrubbing can then recolor locally
        // without another worker render, preserving independent fill/stroke.
        for (const channel of ['fill','stroke']) {
          for (const paint of paints) {
            if (paint.path) p.FPDFPath_SetDrawMode(paint.object, channel==='fill'?paint.fill:0, channel==='stroke'&&paint.stroke);
            else p.FPDFTextObj_SetTextRenderMode(paint.object, paint[channel] ? channel==='fill'?0:1 : 3);
          }
          layers.push(render(1));
        }
      }
      return layers;
    } finally {
      if (bitmap) p.FPDFBitmap_Destroy(bitmap);
      if (ptr) p.pdfium.wasmExports.free(ptr);
      p.FPDF_ClosePage(page);
    }
  });
}

// Keep PDF parsing/rasterization off the main Electron thread, particularly
// when the user is dragging artwork in a large document.
function previewOriginalObject(...args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: 'original-preview' });
    const timer = setTimeout(() => { reject(new Error('Drag preview timed out.')); void worker.terminate(); }, 30000);
    worker.once('message', result => { clearTimeout(timer); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.layers); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('Drag preview stopped.')); });
    worker.postMessage(args);
  });
}
if (!isMainThread && workerData === 'original-preview') parentPort.once('message', async args => {
  try { const layers = await renderOriginalPreview(...args); parentPort.postMessage({ layers }, layers.map(layer => layer.buffer)); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
module.exports = { renderOriginalPreview, previewOriginalObject };
