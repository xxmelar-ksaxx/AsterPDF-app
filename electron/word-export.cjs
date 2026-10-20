const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');

function createWordExport({ dialog, getWindow, getCurrentPath, sameFile, validatePdfBytes, listInstalledFonts, mode = 'word' }) {
  const dataMode = mode === 'data';
  const title = dataMode ? 'PDF to Data' : 'PDF to Word';
  let prepared = null, running = null, working = false;
  return {
    async prepare(expectedPath) {
      if (prepared || working) throw new Error('A Word export is already in progress.');
      if (typeof expectedPath !== 'string' || expectedPath !== getCurrentPath()) throw new Error('Open a PDF before converting it to Word.');
      // Reserve the export before awaiting the native dialog.
      const token = randomUUID();
      prepared = { token, expectedPath, target: null };
      try {
        const result = await dialog.showSaveDialog(getWindow(), { title: `${title} — Save Word document`,
          defaultPath: path.join(path.dirname(expectedPath), `${path.parse(expectedPath).name}${dataMode ? '-data' : path.extname(expectedPath).toLowerCase() === '.docx' ? '-converted' : ''}.docx`),
          filters: [{ name: 'Word document', extensions: ['docx'] }] });
        if (result.canceled || !result.filePath) { prepared = null; return null; }
        const target = path.extname(result.filePath) ? result.filePath : `${result.filePath}.docx`;
        if (path.extname(target).toLowerCase() !== '.docx') throw new Error('Choose a .docx filename.');
        if (await sameFile(target, expectedPath)) throw new Error('Choose a different filename to keep the original document.');
        prepared.target = target;
        return { token, path: target };
      } catch (error) { prepared = null; throw error; }
    },
    async convert(rawBytes, token, expectedPath, onProgress) {
      const job = prepared;
      if (!job || !job.target || job.token !== token || job.expectedPath !== expectedPath || expectedPath !== getCurrentPath() || working)
        throw new Error('The Word export location is no longer valid.');
      prepared = null;
      const bytes = Uint8Array.from(validatePdfBytes(rawBytes));
      working = true;
      const temporary = path.join(path.dirname(job.target), `.${path.basename(job.target)}.${randomUUID()}.tmp`);
      try {
        onProgress(dataMode ? 'Preparing content extraction…' : 'Reading available fonts…');
        const fontCatalog = dataMode ? [] : await listInstalledFonts().catch(() => []);
        const fonts = Object.fromEntries(fontCatalog.flatMap(font =>
          [font.postscriptName, font.family].filter(Boolean).map(name => [name.toLowerCase(), font.family])));
        const result = await new Promise((resolve, reject) => {
          const worker = new Worker(path.join(__dirname, dataMode ? 'pdf-to-data.worker.cjs' : 'pdf-to-word.worker.cjs'), {
            workerData: { bytes, fonts, fontCatalog, title: path.parse(expectedPath).name }, transferList: [bytes.buffer]
          });
          running = worker;
          let settled = false;
          const finish = (error, value) => {
            if (settled) return;
            settled = true; void worker.terminate();
            if (error) reject(error); else resolve(value);
          };
          worker.on('message', message => {
            if (message.progress) onProgress(message.progress);
            else if (message.error) finish(new Error(message.error));
            else if (message.bytes) finish(null, message);
          });
          worker.on('error', error => finish(error));
          worker.on('exit', code => { if (!settled) finish(new Error(`Word conversion stopped unexpectedly (${code}).`)); });
        });
        if (expectedPath !== getCurrentPath()) throw new Error('The open PDF changed during conversion.');
        onProgress('Saving your Word document…');
        await fs.writeFile(temporary, result.bytes, { flag: 'wx' });
        await fs.rename(temporary, job.target);
        return { path: job.target, name: path.basename(job.target), pages: result.pages, tables: result.tables, warnings: result.warnings };
      } finally {
        running = null;
        working = false;
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    },
    discard(token) { if (prepared?.token === token) prepared = null; },
    dispose() { prepared = null; if (running) void running.terminate(); running = null; }
  };
}
module.exports = { createWordExport };
