const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { engine, withDocument } = require('./original-text.cjs');
const { randomUUID } = require('node:crypto');
const { readTextGroup, textGroupObjects } = require('./shaped-text.cjs');
const { transformPage } = require('./original-transforms.cjs');
const { saveOriginalDocument } = require('./original-objects.cjs');

// Copy only selected native paint objects. Importing into a fresh document keeps
// the clipboard independent of the source and includes its fonts/resources.
async function copyObjects(bytes, selections, transforms = []) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 2000) throw new Error('Select objects to copy.');
  const p = await engine();
  return withDocument(p, bytes, source => {
    const output = p.FPDF_CreateNewDocument();
    try {
      const pageNumbers = [...new Set(selections.map(s => s.pageIndex))];
      pageNumbers.forEach((pageIndex, outIndex) => {
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= p.FPDF_GetPageCount(source)) throw new Error('Invalid clipboard page.');
        if (!p.FPDF_ImportPages(output, source, String(pageIndex + 1), outIndex)) throw new Error('Could not copy this page.');
        const page = p.FPDF_LoadPage(output, outIndex);
        try {
          const keep = new Set();
          for (const entry of selections.filter(s => s.pageIndex === pageIndex)) {
            if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= p.FPDFPage_CountObjects(page)) throw new Error('Invalid clipboard object.');
            const object = p.FPDFPage_GetObject(page, entry.index);
            for (const member of p.FPDFPageObj_GetType(object) === 1 ? textGroupObjects(p, page, object) : [object]) keep.add(member);
          }
          transformPage(p, page, transforms.filter(t => t.pageIndex === pageIndex && selections.some(s => s.pageIndex === pageIndex && s.index === t.index)), true);
          for (let i = p.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
            const object = p.FPDFPage_GetObject(page, i);
            if (!keep.has(object)) { p.FPDFPage_RemoveObject(page, object); p.FPDFPageObj_Destroy(object); }
          }
          if (!p.FPDFPage_GenerateContent(page)) throw new Error('Could not prepare copied objects.');
        } finally { p.FPDF_ClosePage(page); }
      });
      return saveOriginalDocument(p, output);
    } finally { p.FPDF_CloseDocument(output); }
  });
}

async function pasteObjects(bytes, fragment, pageIndex, dx = 12, dy = -12) {
  const p = await engine();
  return withDocument(p, bytes, document => withDocument(p, fragment, copied => {
    const count = p.FPDF_GetPageCount(document);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count || ![dx,dy].every(Number.isFinite)) throw new Error('Invalid paste location.');
    const target = p.FPDF_LoadPage(document, pageIndex), indices = [];
    try {
      for (let i = 0; i < p.FPDFPage_CountObjects(target); i++) if (p.FPDFPageObj_GetType(p.FPDFPage_GetObject(target, i)) === 4) throw new Error('This page contains gradient artwork that cannot yet be edited safely.');
      for (let i = 0; i < p.FPDF_GetPageCount(copied); i++) {
        if (!p.FPDF_ImportPages(document, copied, String(i + 1), count)) throw new Error('Could not paste copied objects.');
        const imported = p.FPDF_LoadPage(document, count), groupIds = new Map();
        try {
          while (p.FPDFPage_CountObjects(imported)) {
            const object = p.FPDFPage_GetObject(imported, 0);
            if (!p.FPDFPage_RemoveObject(imported, object)) throw new Error('Could not move copied object.');
            const metadata = readTextGroup(p, object);
            if (metadata) {
              if (!groupIds.has(metadata.id)) groupIds.set(metadata.id, randomUUID());
              for (let m = p.FPDFPageObj_CountMarks(object) - 1; m >= 0; m--) {
                const mark = p.FPDFPageObj_GetMark(object, m);
                p.FPDFPageObjMark_RemoveParam(object, mark, 'AsterTextV1');
              }
              const mark = p.FPDFPageObj_AddMark(object, 'AsterText');
              const serialized = JSON.stringify({...metadata,id:groupIds.get(metadata.id)}).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
              if (!mark || !p.FPDFPageObjMark_SetStringParam(document,object,mark,'AsterTextV1',serialized)) throw new Error('Could not preserve editable text.');
            }
            p.FPDFPageObj_Transform(object, 1, 0, 0, 1, dx, dy);
            p.FPDFPageObj_TransformClipPath(object, 1, 0, 0, 1, dx, dy);
            indices.push(p.FPDFPage_CountObjects(target)); p.FPDFPage_InsertObject(target, object);
          }
        } finally { p.FPDF_ClosePage(imported); p.FPDFPage_Delete(document, count); }
      }
      if (!p.FPDFPage_GenerateContent(target)) throw new Error('Could not prepare pasted objects.');
      return { bytes: saveOriginalDocument(p, document), indices };
    } finally { p.FPDF_ClosePage(target); }
  }));
}
function clipboardWorker(method, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData:'object-clipboard'});
    const timeout = setTimeout(() => { reject(new Error('Clipboard processing timed out.')); void worker.terminate(); }, 60000);
    worker.once('message', result => { clearTimeout(timeout); void worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.value); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if(code) reject(new Error('Clipboard processing stopped.')); });
    worker.postMessage({method,args});
  });
}
if (!isMainThread && workerData === 'object-clipboard') parentPort.once('message', async ({method,args}) => {
  try { const value = await (method === 'copy' ? copyObjects : pasteObjects)(...args); parentPort.postMessage({value}, [(value.bytes || value).buffer]); }
  catch(error) { parentPort.postMessage({error:error.message}); }
});
module.exports = { copyObjects, pasteObjects, copyObjectsWorker: (...args) => clipboardWorker('copy',args), pasteObjectsWorker: (...args) => clipboardWorker('paste',args) };
