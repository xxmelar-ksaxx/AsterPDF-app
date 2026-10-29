type Point = { x: number; y: number };
export type CornerRadii = [number, number, number, number]; // top-left, top-right, bottom-right, bottom-left
export function cornerRadii(w: number, h: number, radius = 0, corners?: CornerRadii): CornerRadii {
  const values = (corners ?? [radius, radius, radius, radius]).map(value => Math.max(0, value));
  const [tl, tr, br, bl] = values;
  const factor = Math.min(1, w / (tl + tr || 1), w / (bl + br || 1), h / (tl + bl || 1), h / (tr + br || 1));
  return values.map(value => value * factor) as CornerRadii;
}

// Page fractions are not square units. Constraints are calculated in display
// coordinates so Shift draws a real square/circle at every page aspect ratio.
export function constrainDraw(start: Point, end: Point, width: number, height: number, line: boolean): Point {
  const dx = (end.x - start.x) * width, dy = (end.y - start.y) * height;
  if (line) {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    const length = Math.hypot(dx, dy);
    return { x: start.x + Math.cos(angle) * length / width, y: start.y + Math.sin(angle) * length / height };
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: start.x + (dx < 0 ? -side : side) / width, y: start.y + (dy < 0 ? -side : side) / height };
}

// Shared by SVG preview and PDF export; radius is expressed in PDF points.
export function shapePath(kind: 'rectangle' | 'ellipse', w: number, h: number, radius = 0, corners?: CornerRadii): string {
  const k = 0.5522847498307936;
  if (kind === 'ellipse') {
    const x = w / 2, y = h / 2, a = x * k, b = y * k;
    return `M ${x} 0 C ${x + a} 0 ${w} ${y - b} ${w} ${y} C ${w} ${y + b} ${x + a} ${h} ${x} ${h} C ${x - a} ${h} 0 ${y + b} 0 ${y} C 0 ${y - b} ${x - a} 0 ${x} 0 Z`;
  }
  const [tl, tr, br, bl] = cornerRadii(w, h, radius, corners);
  const c = 1 - k;
  return `M ${tl} 0 L ${w - tr} 0 C ${w - tr*c} 0 ${w} ${tr*c} ${w} ${tr} L ${w} ${h - br} C ${w} ${h - br*c} ${w - br*c} ${h} ${w - br} ${h} L ${bl} ${h} C ${bl*c} ${h} 0 ${h - bl*c} 0 ${h - bl} L 0 ${tl} C 0 ${tl*c} ${tl*c} 0 ${tl} 0 Z`;
}
