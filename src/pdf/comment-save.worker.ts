import type { CommentChange, NewNote } from './comments';
import { prepareCommentData } from './comment-save-data';

const workerScope = self as unknown as Worker;
workerScope.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; notes: NewNote[]; changes: CommentChange[] }>) => {
  try {
    const { bytes: original, notes, changes } = event.data;
    const { bytes, base } = await prepareCommentData(original, notes, changes);
    workerScope.postMessage({ bytes, base }, [...new Set([bytes.buffer as ArrayBuffer, base.buffer as ArrayBuffer])]);
  } catch (cause) {
    workerScope.postMessage({ error: cause instanceof Error ? cause.message : String(cause) });
  }
};
