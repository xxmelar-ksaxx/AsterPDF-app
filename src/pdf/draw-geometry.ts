type Point = { x: number; y: number };

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
export function shapePath(kind: 'rectangle' | 'ellipse', w: number, h: number, radius = 0): string {
  const k = 0.5522847498307936;
  if (kind === 'ellipse') {
    const x = w / 2, y = h / 2, a = x * k, b = y * k;
    return `M ${x} 0 C ${x + a} 0 ${w} ${y - b} ${w} ${y} C ${w} ${y + b} ${x + a} ${h} ${x} ${h} C ${x - a} ${h} 0 ${y + b} 0 ${y} C 0 ${y - b} ${x - a} 0 ${x} 0 Z`;
  }
  const r = Math.max(0, Math.min(radius, w / 2, h / 2)), c = r * (1 - k);
  return `M ${r} 0 L ${w - r} 0 C ${w - c} 0 ${w} ${c} ${w} ${r} L ${w} ${h - r} C ${w} ${h - c} ${w - c} ${h} ${w - r} ${h} L ${r} ${h} C ${c} ${h} 0 ${h - c} 0 ${h - r} L 0 ${r} C 0 ${c} ${c} 0 ${r} 0 Z`;
}
