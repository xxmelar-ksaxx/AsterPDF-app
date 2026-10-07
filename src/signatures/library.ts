export type SignaturePoint = { x: number; y: number };
export type SignatureStroke = { color: string; width: number; points: SignaturePoint[] };
export type VectorSignature = { width: number; height: number; strokes: SignatureStroke[] };
export type SavedSignature = { id: string; name: string; dataUrl: string; aspect: number; vector?: VectorSignature };
export type PlacedSignature = { id: string; pageId: string; signatureId: string; dataUrl: string; vector?: VectorSignature; x: number; y: number; width: number; height: number };

const STORAGE_KEY = 'asterpdf-signatures-v1';

function pngAspect(dataUrl: string): number {
  try {
    const header = Uint8Array.from(atob(dataUrl.split(',')[1].slice(0, 40)), (character) => character.charCodeAt(0));
    const view = new DataView(header.buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? width / height : 3;
  } catch { return 3; }
}

export function loadSignatures(): SavedSignature[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    const stored = Array.isArray(parsed) ? parsed.filter((item): item is SavedSignature =>
      typeof item?.id === 'string' && typeof item?.name === 'string' &&
      typeof item?.dataUrl === 'string' && item.dataUrl.startsWith('data:image/png;base64,') &&
      typeof item?.aspect === 'number' && item.aspect > 0) : [];
    if (stored.length) return stored.slice(0, 20).map((item) => ({ ...item,
      vector: isVectorSignature(item.vector) ? item.vector : undefined
    }));
    const legacy = localStorage.getItem('asterpdf-signature');
    return legacy?.startsWith('data:image/png;base64,') ? [{ id: crypto.randomUUID(), name: 'My signature', dataUrl: legacy, aspect: pngAspect(legacy) }] : [];
  } catch { return []; }
}

function isVectorSignature(value: unknown): value is VectorSignature {
  if (!value || typeof value !== 'object') return false;
  const vector = value as VectorSignature;
  return Number.isFinite(vector.width) && vector.width > 0 && Number.isFinite(vector.height) && vector.height > 0 &&
    Array.isArray(vector.strokes) && vector.strokes.length > 0 && vector.strokes.every((stroke) =>
      /^#[0-9a-f]{6}$/i.test(stroke.color) && Number.isFinite(stroke.width) && stroke.width > 0 &&
      Array.isArray(stroke.points) && stroke.points.length >= 2 && stroke.points.every((point) =>
        Number.isFinite(point.x) && Number.isFinite(point.y)));
}

export function storeSignatures(signatures: SavedSignature[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signatures.slice(0, 20)));
  localStorage.removeItem('asterpdf-signature');
}

export function cropSignature(canvas: HTMLCanvasElement, strokes?: SignatureStroke[]): { dataUrl: string; aspect: number; vector?: VectorSignature } | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
    if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  const padding = Math.max(12, Math.round(canvas.width * 0.014));
  const result = document.createElement('canvas');
  result.width = right - left + 1 + padding * 2;
  result.height = bottom - top + 1 + padding * 2;
  result.getContext('2d')?.drawImage(canvas, left, top, right - left + 1, bottom - top + 1,
    padding, padding, right - left + 1, bottom - top + 1);
  const visibleStrokes = strokes?.filter((stroke) => stroke.points.length >= 2);
  const vector = visibleStrokes?.length ? {
    width: result.width, height: result.height,
    strokes: visibleStrokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({
      x: point.x - left + padding, y: point.y - top + padding
    })) }))
  } : undefined;
  return { dataUrl: result.toDataURL('image/png'), aspect: result.width / result.height, vector };
}

function safeSvg(text: string): Blob {
  if (/<!doctype|<!entity/i.test(text)) throw new Error('SVG files with document declarations are unsupported.');
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('This SVG could not be read.');
  const allowed = new Set(['svg', 'g', 'defs', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan']);
  const clean = (element: Element) => {
    for (const child of Array.from(element.children)) {
      if (!allowed.has(child.localName)) child.remove();
      else clean(child);
    }
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value;
      if (attribute.name.toLowerCase().startsWith('on') || /href|style|filter/i.test(attribute.name) || /url\s*\(|javascript:|data:/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  };
  clean(root);
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    if (!root.getAttribute('width')) root.setAttribute('width', String(viewBox[2]));
    if (!root.getAttribute('height')) root.setAttribute('height', String(viewBox[3]));
  }
  return new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
}

export async function importSignature(file: File): Promise<{ dataUrl: string; aspect: number }> {
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose an image smaller than 8 MB.');
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (!svg && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or SVG image.');
  const blob = svg ? safeSvg(await file.text()) : file;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const aspect = image.naturalWidth / image.naturalHeight;
    if (!Number.isFinite(aspect) || aspect <= 0) throw new Error('This image has no visible size.');
    const width = Math.max(1, Math.min(2400, Math.round(1200 * aspect)));
    const height = Math.max(1, Math.min(1200, Math.round(width / aspect)));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')?.drawImage(image, 0, 0, width, height);
    const cropped = cropSignature(canvas);
    if (!cropped) throw new Error('This image is empty.');
    if (cropped.dataUrl.length > 2_000_000) throw new Error('The image is too detailed to store as a signature.');
    return { dataUrl: cropped.dataUrl, aspect: cropped.aspect };
  } finally { URL.revokeObjectURL(url); }
}
