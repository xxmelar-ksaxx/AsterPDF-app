import { estimatePdf, type CompressionMode } from './compression';

self.onmessage = async ({ data }: MessageEvent<{ bytes: Uint8Array; mode: CompressionMode }>) => {
  try {
    self.postMessage(await estimatePdf(data.bytes, data.mode));
  } catch {
    self.postMessage(null);
  }
};
