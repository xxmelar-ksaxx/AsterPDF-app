import type { CommentChange, NewNote } from './comments';

export function prepareCommentSave(bytes: Uint8Array, notes: NewNote[], changes: CommentChange[] = []) {
  return new Promise<{ bytes: Uint8Array; base: Uint8Array }>((resolve, reject) => {
    const worker = new Worker(new URL('./comment-save.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ bytes: Uint8Array; base: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || 'Could not prepare comments.')); };
    worker.onmessageerror = () => { worker.terminate(); reject(new Error('Could not read prepared comments.')); };
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy, notes, changes }, [copy.buffer]);
  });
}
