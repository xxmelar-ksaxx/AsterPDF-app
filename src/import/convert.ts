import { PDFDocument } from 'pdf-lib';
import { renderAsync } from 'docx-preview';
import type { OpenedFile } from '../types';

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function convertToPdf(file: OpenedFile): Promise<Uint8Array> {
  if (file.kind === 'pdf') return file.bytes;
  if (file.kind === 'docx') {
    const root = document.createElement('div');
    root.className = 'docx-print-root';
    document.body.append(root);
    try {
      await renderAsync(asArrayBuffer(file.bytes), root, root, {
        breakPages: true, ignoreLastRenderedPageBreak: false,
        renderHeaders: true, renderFooters: true, renderFootnotes: true,
        renderEndnotes: true, useBase64URL: true, hideWrapperOnPrint: true
      });
      if (!root.textContent?.trim() && !root.querySelector('img')) throw new Error('The Word document contains no visible content.');
      await document.fonts.ready;
      await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => {})));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const bytes = await window.aster.printDocx();
      if (!bytes.byteLength) throw new Error('The Word document could not be printed.');
      return bytes;
    } finally {
      root.remove();
    }
  }
  const pdf = await PDFDocument.create();
  {
    const mime = file.kind === 'png' ? 'image/png' : file.kind === 'webp' ? 'image/webp' : 'image/jpeg';
    const bitmap = await createImageBitmap(new Blob([asArrayBuffer(file.bytes)], { type: mime }));
    try {
      const maxPoints = 1440;
      const scale = Math.min(1, maxPoints / Math.max(bitmap.width, bitmap.height));
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = new Uint8Array(await (await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not convert image.')), 'image/jpeg', 0.92))).arrayBuffer());
      const image = await pdf.embedJpg(jpeg);
      pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    } finally { bitmap.close(); }
  }
  return new Uint8Array(await pdf.save());
}
