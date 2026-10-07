import type { PageEdit } from './edit';

export type PlannedPage = { id: string; sourceIndex: number; turns: number };

export function initialPagePlan(count: number): PlannedPage[] {
  return Array.from({ length: count }, (_, sourceIndex) => ({ id: `source-${sourceIndex}`, sourceIndex, turns: 0 }));
}

export function remapPageSelection(before: PlannedPage[], after: PlannedPage[], selected: ReadonlySet<number>): Set<number> {
  if (!selected.size) return new Set();
  const ids = new Set([...selected].map((index) => before[index]?.id).filter((id): id is string => Boolean(id)));
  const mapped = new Set(after.flatMap((page, index) => ids.has(page.id) ? [index] : []));
  if (!mapped.size && after.length) mapped.add(Math.min(Math.min(...selected), after.length - 1));
  return mapped;
}

export function changePagePlan(pages: PlannedPage[], edit: PageEdit): PlannedPage[] {
  const count = pages.length;
  const next = pages.slice();
  if (edit.type === 'batch') {
    const selected = new Set(edit.pages);
    if (!selected.size || [...selected].some((index) => index < 0 || index >= count)) throw new Error('Select valid pages first.');
    if (edit.action === 'delete') {
      if (selected.size === count) throw new Error('A PDF needs at least one page.');
      return next.filter((_, index) => !selected.has(index));
    }
    if (edit.action === 'duplicate') return next.flatMap((page, index) => selected.has(index) ? [page, { ...page, id: crypto.randomUUID() }] : [page]);
    if (edit.action === 'rotate-left' || edit.action === 'rotate-right') {
      const delta = edit.action === 'rotate-left' ? 3 : 1;
      return next.map((page, index) => selected.has(index) ? { ...page, turns: (page.turns + delta) % 4 } : page);
    }
    // Keep selected pages together in their existing relative order.
    const selectedIds = new Set(edit.pages.map((index) => next[index].id));
    if (edit.action === 'move-up') {
      for (let index = 1; index < count; index += 1) {
        if (selectedIds.has(next[index].id) && !selectedIds.has(next[index - 1].id)) [next[index - 1], next[index]] = [next[index], next[index - 1]];
      }
    } else {
      for (let index = count - 2; index >= 0; index -= 1) {
        if (selectedIds.has(next[index].id) && !selectedIds.has(next[index + 1].id)) [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
    }
    return next;
  }
  if (edit.type === 'move') {
    if (edit.from < 0 || edit.from >= count || edit.to < 0 || edit.to >= count) throw new Error('Page is out of range.');
    next.splice(edit.to, 0, next.splice(edit.from, 1)[0]);
  } else if (edit.type === 'duplicate') {
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    next.splice(edit.page + 1, 0, { ...next[edit.page], id: crypto.randomUUID() });
  } else if (edit.type === 'delete') {
    if (count === 1) throw new Error('A PDF needs at least one page.');
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    next.splice(edit.page, 1);
  } else {
    if (edit.page < 0 || edit.page >= count) throw new Error('Page is out of range.');
    next[edit.page] = { ...next[edit.page], turns: (next[edit.page].turns + (edit.degrees === 90 ? 1 : 3)) % 4 };
  }
  return next;
}
