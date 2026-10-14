export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Box = { x: number; y: number; width: number; height: number };

export function imagePlacement(point: { x: number; y: number }, aspect: number, pageWidth: number, pageHeight: number): Box {
  const pixels = Math.min(pageWidth * .34, pageHeight * .3 * aspect);
  const width = pixels / pageWidth, height = pixels / aspect / pageHeight;
  return { x: point.x - width / 2, y: point.y - height / 2, width, height };
}

// Coordinates are page fractions, so preserving width/height also preserves the
// image's displayed aspect ratio at any zoom or page rotation.
export function resizeImage(box: Box, handle: ResizeHandle, dx: number, dy: number, keepRatio: boolean): Box {
  const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
  let width = box.width + (west ? -dx : east ? dx : 0);
  let height = box.height + (north ? -dy : south ? dy : 0);
  if (keepRatio) {
    const horizontal = width / box.width, vertical = height / box.height;
    const requested = !(north || south) ? horizontal : !(west || east) ? vertical
      : Math.abs(horizontal - 1) >= Math.abs(vertical - 1) ? horizontal : vertical;
    const factor = Math.max(requested, .01 / box.width, .01 / box.height);
    width = box.width * factor; height = box.height * factor;
  } else {
    if (west || east) width = Math.max(width, .01);
    if (north || south) height = Math.max(height, .01);
  }
  return { x: west ? box.x + box.width - width : east ? box.x : box.x + (box.width - width) / 2,
    y: north ? box.y + box.height - height : south ? box.y : box.y + (box.height - height) / 2, width, height };
}
