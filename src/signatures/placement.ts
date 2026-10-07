import type { PageViewport } from 'pdfjs-dist';
import type { SignatureDraw } from '../pdf/edit';
import type { PlacedSignature } from './library';

export function signatureDrawFromViewport(placement: PlacedSignature, viewport: PageViewport, pageIndex: number): SignatureDraw {
  const left = placement.x * viewport.width;
  const top = placement.y * viewport.height;
  const right = (placement.x + placement.width) * viewport.width;
  const bottom = (placement.y + placement.height) * viewport.height;
  const [x, y] = viewport.convertToPdfPoint(left, bottom);
  const [rightX, rightY] = viewport.convertToPdfPoint(right, bottom);
  const [topX, topY] = viewport.convertToPdfPoint(left, top);
  return {
    pageIndex, dataUrl: placement.dataUrl, vector: placement.vector, x, y,
    width: Math.hypot(rightX - x, rightY - y),
    height: Math.hypot(topX - x, topY - y),
    angle: Math.atan2(rightY - y, rightX - x) * 180 / Math.PI
  };
}
