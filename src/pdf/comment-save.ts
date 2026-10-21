import type { CommentChange, NewNote } from './comments';

export function prepareCommentSave(bytes: Uint8Array, notes: NewNote[], changes: CommentChange[] = []) {
  return new Promise<{ bytes: Uint8Array; base: Uint8Array }>((resolve, reject) => {
    const worker = new Worker(new URL('./comment-save.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timeout); worker.terminate(); };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error('Comment preparation took too long. The original PDF was not changed.'));
    }, 120_000);
    worker.onmessage = (event: MessageEvent<{ bytes: Uint8Array; base: Uint8Array; error?: string }>) => {
      finish();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || 'Could not prepare comments.')); };
    worker.onmessageerror = () => { finish(); reject(new Error('Could not read prepared comments.')); };
    try {
      const copy = bytes.slice();
      worker.postMessage({ bytes: copy, notes, changes }, [copy.buffer]);
    } catch (cause) { finish(); reject(cause); }
  });
}
