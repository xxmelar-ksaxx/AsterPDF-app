import { flushSync } from 'react-dom';

const eventName = 'aster:finish-inline-edit';
type FinishEvent = CustomEvent<{ pending: Promise<void>[] }>;

export function onFinishInlineEdit(finish: () => void | Promise<void>) {
  const listener = (event: Event) => {
    (event as FinishEvent).detail.pending.push(Promise.resolve(finish()));
  };
  window.document.addEventListener(eventName, listener);
  return () => window.document.removeEventListener(eventName, listener);
}

export async function finishInlineEdits() {
  const pending: Promise<void>[] = [];
  // OS Open With has no pointer click to finish an inline text editor. Commit
  // its local draft and await PDF text replacement before checking dirty state.
  flushSync(() => window.document.dispatchEvent(new CustomEvent(eventName, { detail: { pending } })));
  await Promise.all(pending);
}
