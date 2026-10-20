const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { init } = require('@embedpdf/pdfium');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, WidthType, TableLayoutType, BorderStyle } = require('docx');
const { inspectPage } = require('./pdf-page-content.cjs');
const { textLines } = require('./word-layout.cjs');
const { dataBlocks, lineText, isRtl, hasDigits, digitInventory } = require('./data-layout.cjs');

const progress = message => parentPort.postMessage({ progress: message });
const xmlText = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd');

function paragraph(text, options = {}) {
  return new Paragraph({ children: [new TextRun({ text: xmlText(text) })],
    bidirectional: isRtl(text), alignment: isRtl(text) ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { before: 0, after: 100 }, ...options });
}

function auditPage(engine, page, runs) {
  const textPage = engine.FPDFText_LoadPage(page);
  if (!textPage) throw new Error('Could not inspect the extracted text.');
  const covered = new Set(runs.map(run => run.object));
  const raw = [];
  let missing = 0, uncovered = 0;
  try {
    for (let index = 0; index < engine.FPDFText_CountChars(textPage); index++) {
      const code = engine.FPDFText_GetUnicode(textPage, index);
      const generated = engine.FPDFText_IsGenerated(textPage, index) === 1;
      if (code === 0x200b) continue; // AsterPDF's non-text glyph companions.
      const character = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
      raw.push(character);
      if (!generated && (character === '\ufffd' || engine.FPDFText_HasUnicodeMapError(textPage, index) === 1)) missing++;
      if (!generated && character.trim() && !covered.has(engine.FPDFText_GetTextObject(textPage, index))) uncovered++;
    }
    return { raw: raw.join(''), missing, uncovered };
  } finally { engine.FPDFText_ClosePage(textPage); }
}

function wordTable(table) {
  const columns = table.xs.length - 1;
  const columnWidth = Math.floor(9360 / columns);
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'D3D9D5' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: Array(columns).fill(columnWidth), layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: table.ys.slice(1).map((_, row) => new TableRow({
      // Allow long rows to flow onto the next Word page.
      children: table.cells.filter(cell => cell.r0 === row).sort((a, b) => a.c0 - b.c0).map(cell => new TableCell({
        rowSpan: cell.r1 - cell.r0, columnSpan: cell.c1 - cell.c0,
        width: { size: columnWidth * (cell.c1 - cell.c0), type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        children: cell.runs.length ? textLines(cell.runs).map(line => paragraph(lineText(line))) : [paragraph('')]
      }))
    }))
  });
}

async function convert() {
  progress('Reading PDF content…');
  const engine = await init({ wasmBinary: await fs.readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm')) });
  engine.PDFiumExt_Init();
  const memory = engine.pdfium, pointer = memory.wasmExports.malloc(workerData.bytes.length);
  if (!pointer) throw new Error('There is not enough memory to extract this PDF.');
  let pdf = 0;
  try {
    memory.HEAPU8.set(workerData.bytes, pointer);
    pdf = engine.FPDF_LoadMemDocument(pointer, workerData.bytes.length, '');
    if (!pdf) throw new Error('The PDF could not be opened for data extraction.');
    const children = [
      paragraph(workerData.title, { heading: HeadingLevel.TITLE }),
      paragraph('PDF to Data', { heading: HeadingLevel.HEADING_1 }),
      paragraph('Clean text and inferred tables, organized by source PDF page. Numbers retain their extracted spelling; no numeric conversion or calculations are applied. Check flagged pages against the PDF before using figures.'),
      paragraph('Images, charts, annotations and scanned text are not transcribed. Table structure and reading order are inferred and may need correction. Word pagination can differ from the source.'),
      paragraph(`Exported: ${new Date().toISOString()}`),
      paragraph(`Source snapshot SHA-256: ${createHash('sha256').update(workerData.bytes).digest('hex')}`)
    ];
    const warnings = [], count = engine.FPDF_GetPageCount(pdf);
    let tablesTotal = 0, pagesWithText = 0, flaggedPages = 0;
    for (let index = 0; index < count; index++) {
      progress(`Extracting page ${index + 1} of ${count}…`);
      const page = engine.FPDF_LoadPage(pdf, index);
      if (!page) throw new Error(`Could not read page ${index + 1}; the export was stopped to avoid missing content.`);
      try {
        const width = engine.FPDF_GetPageWidthF(page), height = engine.FPDF_GetPageHeightF(page);
        if (!(width > 0 && height > 0)) throw new Error(`Could not read the dimensions of page ${index + 1}.`);
        const { runs, tables, hasGraphics } = inspectPage(engine, page, width, height, false);
        const audit = auditPage(engine, page, runs);
        const notes = [];
        const { blocks, rejectedTables } = dataBlocks(runs, tables);
        const digitsDiffer = digitInventory(audit.raw) !== digitInventory(runs.map(run => run.text).join(''));
        const fallback = audit.uncovered > 0 || digitsDiffer || !runs.length;
        children.push(paragraph(`Source page ${index + 1}`, { heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        if (audit.missing) notes.push(`${audit.missing} characters have missing or uncertain Unicode mappings. Verify the text and figures on this page.`);
        if (audit.uncovered) notes.push('Some source characters could not be placed reliably. The extracted character stream is included below instead of reconstructed content.');
        if (digitsDiffer) notes.push('The structured extraction did not preserve the source digit counts. The extracted character stream is used below; check the number order against the PDF.');
        if (rejectedTables) notes.push(`${rejectedTables} possible tables have ambiguous cell assignments. They are retained as text rather than assigning values to uncertain columns.`);
        if (hasGraphics) notes.push('This page contains graphics that are not transcribed. Check the source for numbers in images or charts.');
        if (!runs.length && !audit.raw.trim()) notes.push('No extractable text was found. This page may be blank, scanned, or contain outlined text; OCR is not included.');
        const numericSplits = blocks.some(block => block.line?.runs.some((run, at, all) =>
          at > 0 && hasDigits(run.text) && hasDigits(all[at - 1].text))) ||
          tables.some(table => table.cells.some(cell => cell.runs.filter(run => hasDigits(run.text)).length > 1));
        if (numericSplits) notes.push('Some figures occur in separate text fragments. Their relationship is uncertain; verify spaces, separators and number order against the source.');
        if (notes.length) {
          flaggedPages++;
          children.push(paragraph('Extraction notes', { heading: HeadingLevel.HEADING_2 }));
          for (const note of notes) children.push(paragraph(note));
        }
        children.push(paragraph('Page content', { heading: HeadingLevel.HEADING_2 }));
        if (fallback) {
          for (const line of audit.raw.split(/\r\n|\r|\n/)) if (line.length) children.push(paragraph(line));
          if (!audit.raw.trim()) children.push(paragraph('[No extractable text]'));
        } else {
          let tableIndex = 0;
          for (const block of blocks) {
            if (block.type === 'table') {
              tableIndex++; tablesTotal++;
              children.push(paragraph(`Table ${tableIndex} — inferred from cell borders`, { heading: HeadingLevel.HEADING_3 }));
              children.push(wordTable(block.table), paragraph(''));
            } else children.push(paragraph(lineText(block.line)));
          }
        }
        if (runs.length || audit.raw.trim()) pagesWithText++;
      } finally { engine.FPDF_ClosePage(page); }
    }
    if (!pagesWithText) throw new Error('This PDF has no extractable text. It needs OCR before text and numbers can be exported. No Word file was written.');
    if (flaggedPages) warnings.push(`${flaggedPages} of ${count} pages have extraction notes. Review those pages against the source before relying on the figures.`);
    progress('Saving clean text and tables…');
    const doc = new Document({
      creator: 'AsterPDF', title: `${workerData.title} — Data`,
      description: 'Extracted content for review; extraction does not verify factual or numeric accuracy.',
      styles: { default: { document: { run: { font: 'Arial', size: 22, sizeComplexScript: 22 },
        paragraph: { spacing: { after: 100 } } } } },
      sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children }]
    });
    const bytes = Uint8Array.from(await Packer.toBuffer(doc));
    parentPort.postMessage({ bytes, pages: count, tables: tablesTotal, warnings }, [bytes.buffer]);
  } finally {
    if (pdf) engine.FPDF_CloseDocument(pdf);
    memory.wasmExports.free(pointer); engine.FPDF_DestroyLibrary();
  }
}
convert().catch(error => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
