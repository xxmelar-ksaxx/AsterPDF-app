import { inMarkupThread, noteAsComment, type CommentChange, type CommentOverride, type NewNote, type PdfComment } from './comments';

export type MarkupSnapshot = {
  ids: string[];
  drafts: NewNote[];
  changes: CommentChange[];
  overrides: Record<string, CommentOverride>;
};

/** Snapshot only manual text markups; background note saves must remain independent. */
export function captureMarkups(drafts: NewNote[], changes: CommentChange[], overrides: Record<string, CommentOverride>, comments: PdfComment[]): MarkupSnapshot {
  const threadComments = [...comments, ...drafts.map(note => noteAsComment(note))];
  const markupDrafts = drafts.filter(note => inMarkupThread(noteAsComment(note), threadComments));
  const markupChanges = changes.filter(change => inMarkupThread(change.target, threadComments));
  const ids = new Set([
    ...comments.filter(comment => inMarkupThread(comment, threadComments)).map(comment => comment.id),
    ...markupDrafts.map(note => note.id),
    ...markupChanges.map(change => change.target.id)
  ]);
  return {
    ids: [...ids], drafts: markupDrafts, changes: markupChanges,
    overrides: Object.fromEntries(Object.entries(overrides).filter(([id]) => ids.has(id)))
  };
}

export function restoreMarkupOverrides(current: Record<string, CommentOverride>, currentSnapshot: MarkupSnapshot, target: MarkupSnapshot) {
  const ids = new Set([...currentSnapshot.ids, ...target.ids]);
  return { ...Object.fromEntries(Object.entries(current).filter(([id]) => !ids.has(id))), ...target.overrides };
}
