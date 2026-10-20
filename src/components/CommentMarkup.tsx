import type { PageViewport } from 'pdfjs-dist';
import { MARKUP_COLORS, markupKind, type PdfComment } from '../pdf/comments';

export function markupQuads(comment: PdfComment, viewport: PageViewport) {
  const quads: number[][] = [];
  const points = comment.quadPoints ?? [];
  for (let offset = 0; offset < points.length; offset += 8) {
    quads.push([0, 2, 4, 6].flatMap(index => viewport.convertToViewportPoint(points[offset + index], points[offset + index + 1])));
  }
  return quads;
}

export function markupAtPoint(comments: PdfComment[], viewport: PageViewport, x: number, y: number) {
  return [...comments].reverse().find(comment => markupKind(comment.kind) && markupQuads(comment, viewport).some(quad => {
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    return x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys);
  }));
}

export default function CommentMarkup({ comment, viewport, selected, onSelect }: {
  comment: PdfComment; viewport: PageViewport; selected: boolean; onSelect: () => void;
}) {
  if (!markupKind(comment.kind)) return null;
  const color = comment.color ?? MARKUP_COLORS[comment.kind];
  return <svg className="comment-markup" width={viewport.width} height={viewport.height} aria-hidden="true">
    {markupQuads(comment, viewport).map(([ax, ay, bx, by, cx, cy, dx, dy], index) => {
      const polygon = `${ax},${ay} ${bx},${by} ${dx},${dy} ${cx},${cy}`;
      const t = comment.kind === 'Strikeout' ? .5 : .92;
      return <g key={index}>
        {comment.kind === 'Highlight' ? <polygon points={polygon} fill={color} opacity={comment.opacity ?? .35} /> :
          <line x1={ax + (cx - ax) * t} y1={ay + (cy - ay) * t} x2={bx + (dx - bx) * t} y2={by + (dy - by) * t}
            stroke={color} opacity={comment.opacity ?? 1} strokeWidth={Math.max(.7 * viewport.scale, Math.hypot(cx - ax, cy - ay) * .065)} />}
        <polygon className="comment-markup-hit" points={polygon} fill="transparent" stroke={selected ? color : 'none'} strokeWidth="1" strokeDasharray="3 3"
          onClick={event => { event.stopPropagation(); onSelect(); }} />
      </g>;
    })}
  </svg>;
}
