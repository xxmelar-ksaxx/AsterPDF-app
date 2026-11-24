import type { CompressionLevel, CompressionMode } from './compression';

export function compressPdf(bytes: Uint8Array, level: CompressionLevel, progress: (message: string) => void, mode: CompressionMode = 'editable'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compression.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.progress) { progress(data.progress); return; }
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.bytes);
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    const input = bytes.slice();
    worker.postMessage({ bytes: input, level, mode }, [input.buffer]);
  });
}
