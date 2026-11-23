import { AnnotationMode, getDocument } from 'pdfjs-dist';

export async function printPdf(bytes: Uint8Array, progress: (message: string) => void,
  preview: (pages: readonly string[]) => Promise<PrintSelection | null>) {
  const task = getDocument({ data: bytes.slice() });
  const root = document.createElement('div');
  root.className = 'pdf-print-root';
  const urls: string[] = [];
  document.body.append(root);
  try {
    const pdf = await task.promise;
    for (let number = 1; number <= pdf.numPages; number++) {
      progress(`Preparing page ${number} of ${pdf.numPages} for printing…`);
      const page = await pdf.getPage(number);
      const size = page.getViewport({ scale: 1 });
      const scale = Math.min(150 / 72, Math.sqrt(8000000 / (size.width * size.height)), 8192 / Math.max(size.width, size.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, intent: 'print', annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value =>
        value ? resolve(value) : reject(new Error('Could not prepare the page image.')), 'image/png'));
      canvas.width = canvas.height = 0;
      page.cleanup();
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = new Image();
      img.src = url;
      await img.decode();
      root.append(img);
    }
    const selection = await preview(urls);
    if (selection) {
      const images = Array.from(root.children);
      root.replaceChildren(...selection.indices.map(index => images[index]));
      await window.aster.printDocument(selection.settings);
    }
  } finally {
    root.remove();
    urls.forEach(url => URL.revokeObjectURL(url));
    await task.destroy();
  }
}
