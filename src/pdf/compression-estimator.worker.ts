import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import { composePagePlan, type CompressionLevel } from './edit';
import type { PlannedPage } from './page-plan';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

type EstimateRequest = { bytes: Uint8Array; plan: PlannedPage[] | null };
type EstimateSizes = Record<CompressionLevel, number>;
const workerScope = self as unknown as Worker;

async function estimate(bytes: Uint8Array, plan: PlannedPage[] | null): Promise<{ originalSize: number; sizes: EstimateSizes; sampledPages: number }> {
  workerScope.postMessage({ type: 'progress', message: 'Checking lossless size…' });
  const arranged = plan ? await composePagePlan(bytes, plan) : bytes;
  const originalSize = arranged.byteLength;
  const losslessPdf = await PDFDocument.load(arranged);
  const repacked = await losslessPdf.save({ useObjectStreams: true, objectsPerTick: 50 });
  const sizes: EstimateSizes = { lossless: Math.min(originalSize, repacked.byteLength), balanced: 0, small: 0 };
  if (typeof OffscreenCanvas === 'undefined') throw new Error('Background canvas rendering is unavailable.');

  const task = pdfjs.getDocument({ data: arranged.slice() });
  try {
    const pdf = await task.promise;
    const samplePages = Array.from(new Set([1, Math.ceil(pdf.numPages / 2), pdf.numPages]));
    for (const [level, dpi, quality] of [['balanced', 140, 0.75], ['small', 90, 0.5]] as const) {
      let total = 0;
      for (const [sampleIndex, pageNumber] of samplePages.entries()) {
        workerScope.postMessage({ type: 'progress', message: `Estimating ${level}: sample ${sampleIndex + 1} of ${samplePages.length}…` });
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Background canvas rendering is unavailable.');
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
        total += (await canvas.convertToBlob({ type: 'image/jpeg', quality })).size;
        canvas.width = canvas.height = 1;
        page.cleanup();
      }
      sizes[level] = Math.round((total / samplePages.length + 1500) * pdf.numPages + 5000);
    }
    return { originalSize, sizes, sampledPages: samplePages.length };
  } finally { await task.destroy(); }
}

workerScope.addEventListener('message', (event: MessageEvent<EstimateRequest>) => {
  void estimate(event.data.bytes, event.data.plan).then((result) =>
    workerScope.postMessage({ type: 'ready', ...result }), (error: unknown) =>
    workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
});
