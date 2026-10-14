import test from 'node:test';
import assert from 'node:assert/strict';
import { imagePlacement, resizeImage, type ResizeHandle } from '../src/pdf/image-geometry';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
test('image placement keeps intrinsic proportions and follows the pointer across page edges', () => {
  for (const [width, height] of [[500, 700], [700, 500]]) {
    for (const aspect of [.1, .5, 1, 2, 10]) {
      for (const [x, y] of [[0, 0], [1, 1], [.5, .5]]) {
        const placed = imagePlacement({ x, y }, aspect, width, height);
        close(placed.width * width / (placed.height * height), aspect);
        close(placed.x + placed.width / 2, x); close(placed.y + placed.height / 2, y);
      }
    }
  }
});
test('all resize handles preserve proportions with Shift, including beyond the page', () => {
  const original = { x: .2, y: .3, width: .3, height: .15 };
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as ResizeHandle[]) {
    for (const [dx, dy] of [[.08, .04], [-.07, -.01], [2, -2], [-2, 2]]) {
      const changed = resizeImage(original, handle, dx, dy, true);
      close(changed.width / changed.height, original.width / original.height);
      assert.ok(changed.width > 0 && changed.height > 0);
      assert.ok(Object.values(changed).every(Number.isFinite));
      if (handle.includes('w')) close(changed.x + changed.width, original.x + original.width);
      if (handle.includes('e')) close(changed.x, original.x);
      if (handle.includes('n')) close(changed.y + changed.height, original.y + original.height);
      if (handle.includes('s')) close(changed.y, original.y);
    }
  }
  const expanded = resizeImage(original, 'nw', -2, -2, true);
  assert.ok(expanded.x < 0 && expanded.y < 0 && expanded.width > 1 && expanded.height > 1);
});
test('free resizing stretches either edge or corner without moving the opposite edge', () => {
  const original = { x: .2, y: .3, width: .3, height: .15 };
  const west = resizeImage(original, 'w', -.1, .2, false);
  close(west.x, .1); close(west.width, .4); close(west.height, original.height); close(west.y, original.y);
  const corner = resizeImage(original, 'se', .1, .01, false);
  close(corner.width, .4); close(corner.height, .16); close(corner.x, original.x); close(corner.y, original.y);
});
