const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { init } = require('@embedpdf/pdfium');
const { PNG } = require('pngjs');
const {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, TableLayoutType, TableAnchorType, OverlapType, HeightRule, LineRuleType,
  FrameAnchorType, FrameWrap, AlignmentType, SectionType, BorderStyle,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType
} = require('docx');
const { conversionTextRuns } = require('./original-text.cjs');
const { readTextGroup, textGroupObjects } = require('./shaped-text.cjs');
const { textLines, detectTables } = require('./word-layout.cjs');

const twips = points => Math.round(points * 20);
const rtl = text => /[\u0590-\u08ff]/u.test(text);
const progress = message => parentPort.postMessage({ progress: message });
const cleanText = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
];

function inspectPage(engine, page, width, height) {
  const memory = engine.pdfium, ptr = memory.wasmExports.malloc(96);
  const deviceWidth = Math.round(width * 20), deviceHeight = Math.round(height * 20);
  const point = (x, y) => {
    if (!engine.FPDF_PageToDevice(page, 0, 0, deviceWidth, deviceHeight, 0, x, y, ptr + 64, ptr + 68))
      throw new Error('Could not read PDF page coordinates.');
    return [memory.getValue(ptr + 64, 'i32') * width / deviceWidth, memory.getValue(ptr + 68, 'i32') * height / deviceHeight];
  };
  const textPage = engine.FPDFText_LoadPage(page);
  if (!textPage) { memory.wasmExports.free(ptr); throw new Error('Could not read PDF text.'); }
  try {
    const runs = conversionTextRuns(engine, textPage).flatMap(run => {
      const corners = [[run.box[0], run.box[1]], [run.box[2], run.box[1]], [run.box[0], run.box[3]], [run.box[2], run.box[3]]].map(([x, y]) => point(x, y));
      const box = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])),
        Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
      // Keep hard line breaks as separate, editable Word paragraphs.
      const lines = cleanText(run.text).split(/\r\n|\r|\n/).filter(text => text.trim());
      return lines.map((text, index) => ({ ...run, text, box: [box[0], box[1] + index * (box[3] - box[1]) / lines.length,
        box[2], box[1] + (index + 1) * (box[3] - box[1]) / lines.length] }));
    });
    const segments = [], objects = [], simplePaths = new Map();
    const visit = (object, parentMatrix) => {
      const type = engine.FPDFPageObj_GetType(object);
      objects.push({ object, type });
      if (type !== 2 && type !== 5) return;
      let matrix = [1, 0, 0, 1, 0, 0];
      if (engine.FPDFPageObj_GetMatrix(object, ptr)) matrix = [0, 4, 8, 12, 16, 20].map(offset => memory.getValue(ptr + offset, 'float'));
      matrix = multiply(parentMatrix, matrix);
      if (type === 5) {
        for (let index = 0; index < engine.FPDFFormObj_CountObjects(object); index++)
          visit(engine.FPDFFormObj_GetObject(object, index), matrix);
        return;
      }
      const transform = (x, y) => point(matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]);
      let previous = null, start = null, onlyRules = true;
      const pathSegments = [];
      const add = (a, b) => {
        if (!a || !b) return;
        if (Math.abs(a[0] - b[0]) > .8 && Math.abs(a[1] - b[1]) > .8) { onlyRules = false; return; }
        const line = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        if (Math.max(line[2] - line[0], line[3] - line[1]) > 5) { line.object = object; segments.push(line); pathSegments.push(line); }
      };
      for (let index = 0; index < engine.FPDFPath_CountSegments(object); index++) {
        const segment = engine.FPDFPath_GetPathSegment(object, index);
        if (!segment || !engine.FPDFPathSegment_GetPoint(segment, ptr + 32, ptr + 36)) continue;
        const next = transform(memory.getValue(ptr + 32, 'float'), memory.getValue(ptr + 36, 'float'));
        const kind = engine.FPDFPathSegment_GetType(segment);
        if (kind === 2) start = next; // FPDF_SEGMENT_MOVETO
        else if (kind === 0) add(previous, next); // FPDF_SEGMENT_LINETO
        else onlyRules = false;
        previous = next;
        if (engine.FPDFPathSegment_GetClose(segment)) { add(previous, start); previous = start; }
      }
      if (onlyRules && pathSegments.length && engine.FPDFPath_GetDrawMode(object, ptr + 32, ptr + 36) &&
          memory.getValue(ptr + 32, 'i32') === 0 && memory.getValue(ptr + 36, 'i32')) simplePaths.set(object, pathSegments);
    };
    for (let index = 0; index < engine.FPDFPage_CountObjects(page); index++)
      visit(engine.FPDFPage_GetObject(page, index), [1, 0, 0, 1, 0, 0]);
    const tables = detectTables(segments, runs);
    const hiddenRules = new Set();
    for (const table of tables) {
      const ruleObjects = new Set(table.segments.map(segment => segment.object));
      table.nativeBorders = [...ruleObjects].every(object =>
        simplePaths.has(object) && simplePaths.get(object).every(segment => table.segments.includes(segment)));
      if (table.nativeBorders) for (const object of ruleObjects) {
        engine.FPDFPageObj_SetIsActive(object, false); hiddenRules.add(object);
      }
    }
    // Remove exported text from the background bitmap, including AsterPDF's
    // outlined Arabic glyphs linked to an editable Unicode text object.
    for (const { object, type } of objects) {
      if (type !== 1) continue;
      const group = readTextGroup(engine, object);
      for (const item of group ? textGroupObjects(engine, page, object) : [object])
        engine.FPDFPageObj_SetIsActive(item, false);
    }
    return { runs, tables, hasGraphics: objects.some(item => item.type !== 1 && item.type !== 5 && !hiddenRules.has(item.object)) };
  } finally {
    engine.FPDFText_ClosePage(textPage);
    memory.wasmExports.free(ptr);
  }
}

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

function wordRuns(line, fontFamilies) {
  return line.runs.flatMap((run, index) => {
    const rawFont = run.font.replace(/^[A-Z]{6}\+/, '');
    const font = fontFamilies[rawFont.toLowerCase()] || rawFont.replace(/[-,](bold|italic|regular|medium|light|semibold|bolditalic|boldoblique).*$/i, '') || 'Arial';
    const style = {
      font, size: Math.max(2, Math.min(1600, Math.round(run.size * 2))), sizeComplexScript: Math.max(2, Math.round(run.size * 2)),
      bold: run.bold || /bold|black|semibold/i.test(rawFont), boldComplexScript: run.bold || /bold|black|semibold/i.test(rawFont),
      italics: /italic|oblique/i.test(rawFont), italicsComplexScript: /italic|oblique/i.test(rawFont),
      color: run.color, rightToLeft: rtl(run.text), noProof: true
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
function paragraph(line, fonts, options = {}) {
  return new Paragraph({
    children: wordRuns(line, fonts), bidirectional: line.rtl,
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
          children: lines.length ? lines.map(line => paragraph(line, fonts)) : [new Paragraph({ spacing: { before: 0, after: 0 }, children: [] })]
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
    let textCount = 0, tableCount = 0;
    for (let index = 0; index < count; index++) {
      progress(`Converting page ${index + 1} of ${count}…`);
      const page = engine.FPDF_LoadPage(pdf, index);
      if (!page) throw new Error(`Could not read page ${index + 1}.`);
      try {
        const width = engine.FPDF_GetPageWidthF(page), height = engine.FPDF_GetPageHeightF(page);
        if (!(width > 0 && height > 0) || width > 1584 || height > 1584) throw new Error(`Page ${index + 1} exceeds Word’s 22-inch page size limit.`);
        const { runs, tables, hasGraphics } = inspectPage(engine, page, width, height);
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
        const lines = textLines(runs.filter(run => !inTables.has(run)), true);
        const blocks = [
          ...tables.map(table => ({ y: table.box[1], block: tableToWord(table, workerData.fonts) })),
          ...lines.map(line => ({ y: line.box[1], block: paragraph(line, workerData.fonts, {
            frame: { type: 'absolute', position: { x: twips(Math.max(0, line.box[0] - 1)), y: twips(Math.max(0, line.box[1] - 1)) },
              width: twips(Math.min(width - line.box[0], Math.max(10, line.box[2] - line.box[0] + 6))),
              anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE }, wrap: FrameWrap.NONE, anchorLock: true }
          }) }))
        ].sort((a, b) => a.y - b.y);
        sections.push({ properties: { type: SectionType.NEXT_PAGE, page: { size: { width: twips(width), height: twips(height) },
          margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0, gutter: 0 } } },
          children: [anchor, ...blocks.map(item => item.block), new Paragraph({ spacing: { before: 0, after: 0, line: 1, lineRule: LineRuleType.EXACT } })] });
      } finally { engine.FPDF_ClosePage(page); }
    }
    if (!textCount) throw new Error('This PDF has no extractable text. Editable Word conversion requires OCR for scanned pages; no Word file was written.');
    if (imageOnlyPages.length) warnings.push(`Pages ${imageOnlyPages.slice(0, 20).join(', ')}${imageOnlyPages.length > 20 ? '…' : ''} contain images without extractable text and need OCR to edit their text.`);
    progress('Writing editable text and tables…');
    const doc = new Document({ creator: 'AsterPDF', title: workerData.title, description: 'Editable PDF conversion. Review layout and reconstructed tables before use.',
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
