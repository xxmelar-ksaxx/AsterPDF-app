import { addTextNotes, changeComments, type CommentChange, type NewNote } from './comments';
import { attachOverlayPackage, readOverlayPackage } from './overlays';

const workerScope = self as unknown as Worker;
workerScope.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; notes: NewNote[]; changes: CommentChange[] }>) => {
  try {
    const { bytes: original, notes, changes } = event.data;
    // Preserve the already-exported artwork/fonts and update both the visible
    // PDF and its editable base. No UI rendering or overlay export is needed.
    const update = async (input: Uint8Array) => changeComments(notes.length ? await addTextNotes(input, notes) : input, changes);
    let bytes = await update(original);
    // Read after updating: this reconciles the editable base from the latest
    // annotation graph once, with the same IDs as the saved visible PDF.
    const editable = await readOverlayPackage(bytes);
    const base = editable?.base ?? bytes;
    if (editable) bytes = await attachOverlayPackage(bytes, base, editable.objects);
    workerScope.postMessage({ bytes, base }, [...new Set([bytes.buffer as ArrayBuffer, base.buffer as ArrayBuffer])]);
  } catch (cause) {
    workerScope.postMessage({ error: cause instanceof Error ? cause.message : String(cause) });
  }
};
