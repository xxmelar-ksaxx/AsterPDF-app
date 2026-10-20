const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { init } = require('@embedpdf/pdfium');
const { PNG } = require('pngjs');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, TableLayoutType, TableAnchorType, OverlapType, HeightRule, LineRuleType,
  AlignmentType, SectionType, BorderStyle, PageOrientation,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType
} = require('docx');
const { inspectPage } = require('./pdf-page-content.cjs');

const { textLines } = require('./word-layout.cjs');
const { createWordFonts, fitLine } = require('./word-fonts.cjs');
const { positionedLines, positionedTextbox, rtl } = require('./word-positioning.cjs');

const twips = points => Math.round(points * 20);
const progress = message => parentPort.postMessage({ progress: message });
function backgroundImage(engine, page, width, height) {
  // Limit memory on very large sheets while retaining fine diagrams/images.
  const scale = Math.min(2, Math.sqrt(12_000_000 / (width * height)));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const bitmap = engine.FPDFBitmap_Create(w, h, 1);
  if (!bitmap) throw new Error('Could not allocate the Word page preview.');
  try {
    engine.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xffffffff);
    engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, w, h, 0, 1);
    const address = engine.FPDFBitmap_GetBuffer(bitmap), stride = engine.FPDFBitmap_GetStride(bitmap);
    const pixels = engine.pdfium.HEAPU8, png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const from = address + y * stride + x * 4, to = (y * w + x) * 4;
      png.data[to] = pixels[from + 2]; png.data[to + 1] = pixels[from + 1]; png.data[to + 2] = pixels[from]; png.data[to + 3] = 255;
    }
    return PNG.sync.write(png);
  } finally { engine.FPDFBitmap_Destroy(bitmap); }
}

function wordRuns(line, fontFamilies, fit = 1) {
  return line.runs.flatMap((run, index) => {
    const rawFont = run.font.replace(/^[A-Z]{6}\+/, '');
    const font = run.word?.family || fontFamilies[rawFont.toLowerCase()] || rawFont.replace(/[-,](bold|italic|regular|medium|light|semibold|bolditalic|boldoblique).*$/i, '') || 'Arial';
    const size = run.word?.size || Math.max(1, Math.min(800, Math.round(run.size * 2) / 2));
    const style = {
      font, size: size * 2, sizeComplexScript: size * 2,
      bold: run.word?.bold ?? (run.bold || /bold|black|semibold/i.test(rawFont)),
      boldComplexScript: run.word?.bold ?? (run.bold || /bold|black|semibold/i.test(rawFont)),
      italics: run.word?.italic ?? /italic|oblique/i.test(rawFont), italicsComplexScript: run.word?.italic ?? /italic|oblique/i.test(rawFont),
      scale: Math.max(1, Math.floor((run.word?.scale || 100) * fit)),
      color: run.color, rightToLeft: rtl(run.text), noProof: true, snapToGrid: false, kern: 0
    };
    const result = [];
    if (index && !/\s$/.test(line.runs[index - 1].text) && !/^\s/.test(run.text)) {
      const previous = line.runs[index - 1];
      const gap = line.rtl ? previous.box[0] - run.box[2] : run.box[0] - previous.box[2];
      if (gap > Math.min(run.size, previous.size) * .15) result.push(new TextRun({ ...style, text: ' ' }));
    }
    result.push(new TextRun({ ...style, text: run.text }));
    return result;
  });
}
function paragraph(line, fonts, options = {}, maxWidth = Infinity) {
  const { fit } = fitLine(line, maxWidth);
  return new Paragraph({
    children: wordRuns(line, fonts, fit), bidirectional: line.rtl, widowControl: false,
    alignment: line.rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { before: 0, after: 0, line: twips(Math.max(line.box[3] - line.box[1], ...line.runs.map(run => run.size)) * 1.08), lineRule: LineRuleType.AT_LEAST },
    ...options
  });
}
function tableToWord(table, fonts) {
  const border = table.nativeBorders ? { style: BorderStyle.SINGLE, size: 6, color: '808080' } : { style: BorderStyle.NONE, size: 0 };
  const rows = [];
  for (let row = 0; row < table.ys.length - 1; row++) {
    const cells = table.cells.filter(cell => cell.r0 === row).sort((a, b) => a.c0 - b.c0);
    rows.push(new TableRow({
      cantSplit: true, height: { value: twips(table.ys[row + 1] - table.ys[row]), rule: HeightRule.ATLEAST },
      children: cells.map(cell => {
        const lines = textLines(cell.runs);
        const top = lines.length ? Math.max(0, lines[0].box[1] - cell.box[1] - 1) : 0;
        return new TableCell({
          columnSpan: cell.c1 - cell.c0, rowSpan: cell.r1 - cell.r0,
          width: { size: twips(cell.box[2] - cell.box[0]), type: WidthType.DXA },
          margins: { top: twips(top), bottom: 0, left: twips(2), right: twips(2) },
          children: lines.length ? lines.map(line => paragraph(line, fonts, {}, Math.max(1, cell.box[2] - cell.box[0] - 4))) : [new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })]
        });
      })
    }));
  }
  return new Table({
    rows, columnWidths: table.xs.slice(1).map((x, index) => twips(x - table.xs[index])),
    width: { size: twips(table.box[2] - table.box[0]), type: WidthType.DXA }, layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    float: { horizontalAnchor: TableAnchorType.PAGE, verticalAnchor: TableAnchorType.PAGE,
      absoluteHorizontalPosition: twips(table.box[0]), absoluteVerticalPosition: twips(table.box[1]), overlap: OverlapType.OVERLAP,
      topFromText: 0, bottomFromText: 0, leftFromText: 0, rightFromText: 0 }
  });
}

async function convert() {
  progress('Loading the offline converter…');
  const wasmBinary = await fs.readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
  const engine = await init({ wasmBinary }); engine.PDFiumExt_Init();
  const memory = engine.pdfium, pointer = memory.wasmExports.malloc(workerData.bytes.length);
  if (!pointer) throw new Error('There is not enough memory to convert this PDF.');
  let pdf = 0;
  try {
    memory.HEAPU8.set(workerData.bytes, pointer);
    pdf = engine.FPDF_LoadMemDocument(pointer, workerData.bytes.length, '');
    if (!pdf) throw new Error('The PDF could not be opened for Word conversion.');
    const count = engine.FPDF_GetPageCount(pdf), sections = [], imageOnlyPages = [], warnings = [];
    const fonts = createWordFonts(workerData.fontCatalog);
    let textCount = 0, tableCount = 0, drawingId = 100000;
    for (let index = 0; index < count; index++) {
      progress(`Converting page ${index + 1} of ${count}…`);
      const page = engine.FPDF_LoadPage(pdf, index);
      if (!page) throw new Error(`Could not read page ${index + 1}.`);
      try {
        const width = engine.FPDF_GetPageWidthF(page), height = engine.FPDF_GetPageHeightF(page);
        if (!(width > 0 && height > 0) || width > 1584 || height > 1584) throw new Error(`Page ${index + 1} exceeds Word’s 22-inch page size limit.`);
        const { runs, tables, hasGraphics } = inspectPage(engine, page, width, height);
        await fonts.prepare(runs);
        textCount += runs.length; tableCount += tables.length;
        if (!runs.length && hasGraphics) imageOnlyPages.push(index + 1);
        if (runs.some(run => run.text.includes('\ufffd'))) warnings.push(`Page ${index + 1} contains text with missing character mappings.`);
        const anchor = new Paragraph({ spacing: { before: 0, after: 0, line: 1, lineRule: LineRuleType.EXACT },
          children: hasGraphics ? [new ImageRun({
            type: 'png', data: backgroundImage(engine, page, width, height),
            transformation: { width: width * 96 / 72, height: height * 96 / 72 },
            floating: { horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
              verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 }, behindDocument: true, allowOverlap: true, lockAnchor: true,
              wrap: { type: TextWrappingType.NONE } },
            altText: { title: 'PDF graphics', description: 'Original diagrams and images. Document text is editable separately.', name: `Page ${index + 1} graphics` }
          })] : [] });
        const inTables = new Set(tables.flatMap(table => table.runs));
        const lines = positionedLines(runs.filter(run => !inTables.has(run)));
        const blocks = [
          ...tables.map(table => ({ y: table.box[1], block: tableToWord(table, workerData.fonts) })),
          ...lines.map(line => {
            const leftmost = [...line.runs].sort((a, b) => a.box[0] - b.box[0])[0];
            const x = Math.max(0, Math.min(width - 1, line.box[0] - (leftmost.word?.leftBearing || 0)));
            // Do not widen through another column at the same vertical position.
            const neighbours = lines.filter(other => other !== line && other.box[0] >= line.box[2] &&
              other.box[1] < line.box[3] && other.box[3] > line.box[1]);
            const boundary = Math.min(width, ...neighbours.map(other => other.box[0] - 1));
            const maxWidth = Math.max(1, boundary - x);
            const measured = fitLine(line, maxWidth);
            const ascent = Math.max(...line.runs.map(run => run.word?.ascent || run.size));
            const descent = Math.max(...line.runs.map(run => run.word?.descent || run.size * .3));
            const height = Math.max(ascent + descent, line.box[3] - line.box[1]) + 1;
            const y = Math.max(0, line.baseline - ascent);
            const content = paragraph(line, workerData.fonts, {
              // Left alignment is physical; RTL shaping stays inside the shape.
              // Bidi direction must never mirror page-level anchor coordinates.
              alignment: AlignmentType.LEFT, spacing: { before: 0, after: 0, line: twips(ascent + descent), lineRule: LineRuleType.EXACT }
            }, maxWidth);
            return { y: line.box[1], block: new Paragraph({
              bidirectional: false, spacing: { before: 0, after: 0, line: 1, lineRule: LineRuleType.EXACT },
              children: [positionedTextbox(content, { x, y, width: measured.width, height, id: drawingId++ })]
            }) };
          })
        ].sort((a, b) => a.y - b.y);
        // docx swaps width/height for landscape, so supply portrait-ordered
        // dimensions plus orientation to retain the exact displayed PDF size.
        sections.push({ properties: { type: SectionType.NEXT_PAGE, page: { size: {
          width: twips(Math.min(width, height)), height: twips(Math.max(width, height)),
          orientation: width > height ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0, gutter: 0 } } },
          children: [anchor, ...blocks.map(item => item.block), new Paragraph({ spacing: { before: 0, after: 0, line: 1, lineRule: LineRuleType.EXACT } })] });
      } finally { engine.FPDF_ClosePage(page); }
    }
    if (!textCount) throw new Error('This PDF has no extractable text. Editable Word conversion requires OCR for scanned pages; no Word file was written.');
    warnings.push(...fonts.warnings());
    if (imageOnlyPages.length) warnings.push(`Pages ${imageOnlyPages.slice(0, 20).join(', ')}${imageOnlyPages.length > 20 ? '…' : ''} contain images without extractable text and need OCR to edit their text.`);
    progress('Writing editable text and tables…');
    const doc = new Document({ creator: 'AsterPDF', title: workerData.title, description: 'Editable PDF conversion. Review layout and reconstructed tables before use.',
      fonts: fonts.embedded(), hyphenation: { autoHyphenation: false },
      styles: { default: { document: { run: { font: 'Arial', size: 22 }, paragraph: { spacing: { before: 0, after: 0 } } } } }, sections });
    const bytes = Uint8Array.from(await Packer.toBuffer(doc));
    parentPort.postMessage({ bytes, pages: count, tables: tableCount, warnings }, [bytes.buffer]);
  } finally {
    if (pdf) engine.FPDF_CloseDocument(pdf);
    memory.wasmExports.free(pointer);
    engine.FPDF_DestroyLibrary();
  }
}
convert().catch(cause => parentPort.postMessage({ error: cause instanceof Error ? cause.message : String(cause) }));
