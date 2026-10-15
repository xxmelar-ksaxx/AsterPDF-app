import type { MouseEvent, PointerEvent } from 'react';

type Props = {
  x: number; y: number; width: number; height: number;
  selected?: boolean;
  onInteriorClick: (event: MouseEvent<SVGRectElement>) => void;
  onBorderPointerDown: (event: PointerEvent<SVGRectElement>) => void;
  onBorderPointerMove?: (event: PointerEvent<SVGRectElement>) => void;
  onBorderPointerUp?: (event: PointerEvent<SVGRectElement>) => void;
  onBorderPointerCancel?: (event: PointerEvent<SVGRectElement>) => void;
};

export default function TextFrame({ x, y, width, height, selected, onInteriorClick,
  onBorderPointerDown, onBorderPointerMove, onBorderPointerUp, onBorderPointerCancel }: Props) {
  const edge = Math.min(6, width / 3, height / 3);
  const outside = 4;
  const border = { onPointerDown: (event: PointerEvent<SVGRectElement>) => {
    if (event.button === 0) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
    }
    onBorderPointerDown(event);
  }, onClick: (event: MouseEvent<SVGRectElement>) => { event.preventDefault(); event.stopPropagation(); },
    onDoubleClick: (event: MouseEvent<SVGRectElement>) => { event.preventDefault(); event.stopPropagation(); },
    onPointerMove: onBorderPointerMove,
    onPointerUp: onBorderPointerUp, onPointerCancel: onBorderPointerCancel };
  return <g className={`text-frame${selected ? ' selected' : ''}`}>
    <rect className="text-frame-interior" x={x + edge} y={y + edge} width={Math.max(0, width - 2 * edge)}
      height={Math.max(0, height - 2 * edge)} fill="transparent"
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={onInteriorClick} />
    <rect className="text-frame-outline" x={x} y={y} width={width} height={height} fill="none" />
    <rect className="text-frame-border" x={x - outside} y={y - outside} width={width + 2 * outside} height={edge + outside} fill="transparent" {...border} />
    <rect className="text-frame-border" x={x - outside} y={y + height - edge} width={width + 2 * outside} height={edge + outside} fill="transparent" {...border} />
    <rect className="text-frame-border" x={x - outside} y={y + edge} width={edge + outside} height={Math.max(0, height - 2 * edge)} fill="transparent" {...border} />
    <rect className="text-frame-border" x={x + width - edge} y={y + edge} width={edge + outside} height={Math.max(0, height - 2 * edge)} fill="transparent" {...border} />
  </g>;
}
