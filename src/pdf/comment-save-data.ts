import { PDFDocument } from 'pdf-lib';
import { addNotesToDocument, changeDocumentComments, type CommentChange, type NewNote } from './comments';
import { attachOverlayPackage, readOverlayPackage } from './overlays';
import { pruneUnusedObjects } from './prune-unused';

export async function prepareCommentData(original: Uint8Array, notes: NewNote[], changes: CommentChange[] = []) {
  // Parse once for both additions and edits. Do not clone the input or parse
  // another entire PDF just to look for the editing-package catalog entries.
  const document = await PDFDocument.load(original, { updateMetadata: false });
  pruneUnusedObjects(document);
  addNotesToDocument(document, notes);
  changeDocumentComments(document, changes);
  let bytes = await document.save({ useObjectStreams: false });
  const editable = await readOverlayPackage(bytes, document);
  const base = editable?.base ?? bytes;
  if (editable) bytes = await attachOverlayPackage(bytes, base, editable.objects);
  return { bytes, base };
}
