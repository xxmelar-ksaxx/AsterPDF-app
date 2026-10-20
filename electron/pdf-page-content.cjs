const { conversionTextRuns } = require('./original-text.cjs');
const { readTextGroup, textGroupObjects } = require('./shaped-text.cjs');
const { detectTables } = require('./word-layout.cjs');
const cleanText = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
];

function inspectPage(engine, page, width, height, hideExportedContent = true) {
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
      return lines.map((text, index) => ({ ...run, text, baseline: run.baseline && lines.length === 1 ? point(...run.baseline) : null,
        box: [box[0], box[1] + index * (box[3] - box[1]) / lines.length,
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
      if (hideExportedContent && table.nativeBorders) for (const object of ruleObjects) {
        engine.FPDFPageObj_SetIsActive(object, false); hiddenRules.add(object);
      }
    }
    // Remove exported text from the background bitmap, including AsterPDF's
    // outlined Arabic glyphs linked to an editable Unicode text object.
    for (const { object, type } of objects) {
      if (!hideExportedContent || type !== 1) continue;
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


module.exports = { inspectPage };
