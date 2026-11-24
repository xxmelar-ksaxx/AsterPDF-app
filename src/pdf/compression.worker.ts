import { optimizePdf, type CompressionLevel, type CompressionMode } from './compression';

self.onmessage = async ({ data }: MessageEvent<{ bytes: Uint8Array; level: CompressionLevel; mode: CompressionMode }>) => {
  try {
    const bytes = await optimizePdf(data.bytes, data.level, progress => self.postMessage({ progress }), data.mode);
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Could not compress this PDF.' });
  }
};
