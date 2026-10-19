const fontkit = require('@pdf-lib/fontkit');
const bidi = require('bidi-js')();
const { randomUUID } = require('node:crypto');

function reverseLtrGroups(items, charOf) {
  const result = items.slice();
  const isLtr = (item) => {
    const character = charOf(item);
    return character && /^(L|EN)$/.test(bidi.getBidiCharTypeName(character));
  };
  for (let start = 0; start < result.length;) {
    if (!isLtr(result[start])) { start++; continue; }
    let end = start + 1;
    while (end < result.length && isLtr(result[end])) end++;
    result.splice(start, end - start, ...result.slice(start, end).reverse());
    start = end;
  }
  return result;
}

function shapedGlyphs(fontBytes, input) {
  const font = fontkit.create(fontBytes);
  const run = font.layout(input);
  const placed = reverseLtrGroups(run.glyphs.map((glyph, index) => ({ glyph, position: run.positions[index] })), ({ glyph }) =>
    glyph.codePoints.length === 1 ? String.fromCodePoint(glyph.codePoints[0]) : '');
  const glyphs = placed.map(({ glyph }) => glyph);
  const source = reverseLtrGroups(Array.from(input).reverse(), (character) => character);
  const mapped = [];
  let index = 0;
  for (const glyph of glyphs) {
    if (!glyph.id || glyph.id > 65535) throw new Error('The selected font lacks a glyph needed for this text.');
    if (!glyph.codePoints.length) { mapped.push('\u200b'); continue; }
    const characters = source.slice(index, index + glyph.codePoints.length);
    if (characters.length !== glyph.codePoints.length) throw new Error('The font could not shape this text reliably.');
    const logical = characters.length > 1 ? characters.slice().reverse() : characters;
    if (logical.some((character, offset) => {
      const base = character.normalize('NFD').codePointAt(0);
      return glyph.codePoints[offset] !== character.codePointAt(0) && glyph.codePoints[offset] !== base;
    })) throw new Error('The font could not map this text to its original Unicode.');
    index += logical.length;
    mapped.push(characters.join(''));
  }
  if (index !== source.length) throw new Error('The font could not shape every character.');
  return { glyphs, mapped, positions: placed.map(({ position }) => position), unitsPerEm: font.unitsPerEm };
}

// Keep a shaped line editable as one item even though PDFium exposes its
// individually positioned glyphs as separate page objects. The metadata travels
// with the content through save/reopen, rather than relying on extraction order.
function readTextGroup(pdfium, object) {
  const memory = pdfium.pdfium;
  const lengthPtr = memory.wasmExports.malloc(4);
  try {
    for (let index = 0; index < pdfium.FPDFPageObj_CountMarks(object); index++) {
      const mark = pdfium.FPDFPageObj_GetMark(object, index);
      if (!pdfium.FPDFPageObjMark_GetParamStringValue(mark, 'AsterTextV1', 0, 0, lengthPtr)) continue;
      const length = memory.getValue(lengthPtr, 'i32');
      if (length < 2 || length > 256000) continue;
      const ptr = memory.wasmExports.malloc(length);
      try {
        if (!pdfium.FPDFPageObjMark_GetParamStringValue(mark, 'AsterTextV1', ptr, length, lengthPtr)) continue;
        const value = JSON.parse(memory.UTF16ToString(ptr));
        if (typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) continue;
        if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 10000 ||
          !Array.isArray(value.offset) || value.offset.length !== 2 || !value.offset.every(Number.isFinite) ||
          !Number.isInteger(value.renderMode) || value.renderMode < 0 || value.renderMode > 7)) continue;
        return value;
      } catch { /* Ignore malformed optional editing metadata. */ }
      finally { memory.wasmExports.free(ptr); }
    }
  } finally { memory.wasmExports.free(lengthPtr); }
  return null;
}

function textGroupObjects(pdfium, page, original) {
  const group = readTextGroup(pdfium, original);
  if (!group) return [original];
  const objects = [];
  for (let index = 0; index < pdfium.FPDFPage_CountObjects(page); index++) {
    const object = pdfium.FPDFPage_GetObject(page, index);
    if (pdfium.FPDFPageObj_GetType(object) === 1 && readTextGroup(pdfium, object)?.id === group.id) objects.push(object);
  }
  return objects;
}

function textAnchorMatrix(pdfium, original, matrixPtr) {
  if (!pdfium.FPDFPageObj_GetMatrix(original, matrixPtr)) throw new Error('Could not read the original text position.');
  const memory = pdfium.pdfium;
  const matrix = [0, 4, 8, 12, 16, 20].map((offset) => memory.getValue(matrixPtr + offset, 'float'));
  const offset = readTextGroup(pdfium, original)?.offset;
  if (offset) {
    matrix[4] -= matrix[0] * offset[0] + matrix[2] * offset[1];
    matrix[5] -= matrix[1] * offset[0] + matrix[3] * offset[1];
  }
  return matrix;
}

function unicodeCmap(mapped) {
  const chunks = [];
  for (let start = 0; start < mapped.length; start += 100) {
    const group = mapped.slice(start, start + 100);
    const pairs = group.map((value, offset) => {
      const cid = (start + offset + 1).toString(16).padStart(4, '0');
      const unicode = Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase();
      return '<' + cid + '> <' + unicode + '>';
    });
    chunks.push(group.length + ' beginbfchar\n' + pairs.join('\n') + '\nendbfchar');
  }
  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' + chunks.join('\n') +
    '\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}

function createShapedText(pdfium, document, page, original, objectIndex, replacement, fontBytes) {
  const memory = pdfium.pdfium;
  const matrixPtr = memory.wasmExports.malloc(24), colorPtr = memory.wasmExports.malloc(16), sizePtr = memory.wasmExports.malloc(4);
  try {
    if (!pdfium.FPDFTextObj_GetFontSize(original, sizePtr)) throw new Error('Could not read the original text size.');
    const size = memory.getValue(sizePtr, 'float');
    const matrix = textAnchorMatrix(pdfium, original, matrixPtr);
    const color = pdfium.FPDFPageObj_GetFillColor(original, colorPtr, colorPtr + 4, colorPtr + 8, colorPtr + 12)
      ? [0, 4, 8, 12].map((offset) => memory.getValue(colorPtr + offset, 'i32')) : [0, 0, 0, 255];
    const renderMode = readTextGroup(pdfium, original)?.renderMode ?? pdfium.FPDFTextObj_GetTextRenderMode(original);
    const objects = writeShapedLine(pdfium, document, page, replacement, fontBytes, size, matrix, color, objectIndex + 1, renderMode);
    if (!pdfium.FPDFPage_RemoveObject(page, original)) throw new Error('Could not remove the original text object.');
    pdfium.FPDFPageObj_Destroy(original);
    return objects;
  } finally {
    [matrixPtr, colorPtr, sizePtr].forEach((ptr) => memory.wasmExports.free(ptr));
  }
}

function addShapedText(pdfium, document, page, text, fontBytes, size, matrix, color, bold = false) {
  return writeShapedLine(pdfium, document, page, text, fontBytes, size, matrix, [...color, 255], pdfium.FPDFPage_CountObjects(page), bold ? 2 : 0);
}

function writeShapedLine(pdfium, document, page, text, fontBytes, size, matrix, color, insertAt, renderMode) {
  const { glyphs, mapped, positions, unitsPerEm } = shapedGlyphs(fontBytes, text);
  const memory = pdfium.pdfium;
  // An invisible logical line supplies searchable/copyable text. The positioned
  // visual glyphs map to zero-width characters so readers do not duplicate or
  // reverse the line by extracting each glyph as an independent text object.
  const cidMap = Buffer.alloc((glyphs.length * 2 + 1) * 2);
  glyphs.forEach((glyph, index) => {
    cidMap.writeUInt16BE(glyph.id, (index + 1) * 2);
    cidMap.writeUInt16BE(glyph.id, (index + glyphs.length + 1) * 2);
  });
  const pointers = [];
  const alloc = (count) => {
    const ptr = memory.wasmExports.malloc(count);
    if (!ptr) throw new Error('Could not allocate Arabic text memory.');
    pointers.push(ptr); return ptr;
  };
  let font = 0; let object = 0;
  const objects = [];
  try {
    const fontPtr = alloc(fontBytes.length); memory.HEAPU8.set(fontBytes, fontPtr);
    const mapPtr = alloc(cidMap.length); memory.HEAPU8.set(cidMap, mapPtr);
    const codesPtr = alloc(glyphs.length * 4);
    const matrixPtr = alloc(24);
    font = pdfium.FPDFText_LoadCidType2Font(document, fontPtr, fontBytes.length,
      unicodeCmap([...mapped, ...glyphs.map(() => '\u200b')]), mapPtr, cidMap.length);
    if (!font) throw new Error('Could not embed the Arabic font.');
    const id = randomUUID();
    const markObject = (target, metadata) => {
      const mark = pdfium.FPDFPageObj_AddMark(target, 'AsterText');
      const serialized = JSON.stringify(metadata)
        .replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
      if (!mark || !pdfium.FPDFPageObjMark_SetStringParam(document, target, mark, 'AsterTextV1', serialized))
        throw new Error('Could not preserve editable Arabic text.');
    };
    matrix.forEach((value, index) => memory.setValue(matrixPtr + index * 4, value, 'float'));
    glyphs.forEach((_, index) => memory.setValue(codesPtr + index * 4, index + 1, 'i32'));
    object = pdfium.FPDFPageObj_CreateTextObj(document, font, size);
    if (!object || !pdfium.FPDFText_SetCharcodes(object, codesPtr, glyphs.length) || !pdfium.FPDFPageObj_SetMatrix(object, matrixPtr))
      throw new Error('Could not preserve the logical Arabic line.');
    pdfium.FPDFPageObj_SetFillColor(object, ...color);
    pdfium.FPDFTextObj_SetTextRenderMode(object, 3);
    markObject(object, { id, text, offset: [0, 0], renderMode });
    if (!pdfium.FPDFPage_InsertObjectAtIndex(page, object, insertAt)) throw new Error('Could not insert the logical Arabic line.');
    objects.push(object); object = 0;
    let penX = 0, penY = 0;
    for (let index = 0; index < glyphs.length; index++) {
      const position = positions[index];
      const x = (penX + position.xOffset) * size / unitsPerEm;
      const y = (penY + position.yOffset) * size / unitsPerEm;
      const placedMatrix = [...matrix];
      placedMatrix[4] += matrix[0] * x + matrix[2] * y;
      placedMatrix[5] += matrix[1] * x + matrix[3] * y;
      placedMatrix.forEach((value, offset) => memory.setValue(matrixPtr + offset * 4, value, 'float'));
      memory.setValue(codesPtr, index + glyphs.length + 1, 'i32');
      object = pdfium.FPDFPageObj_CreateTextObj(document, font, size);
      if (!object || !pdfium.FPDFText_SetCharcodes(object, codesPtr, 1) || !pdfium.FPDFPageObj_SetMatrix(object, matrixPtr))
        throw new Error('Could not position shaped Arabic text.');
      pdfium.FPDFPageObj_SetFillColor(object, ...color);
      if (renderMode === 2) {
        pdfium.FPDFPageObj_SetStrokeColor(object, ...color);
        pdfium.FPDFPageObj_SetStrokeWidth(object, size * .025);
      }
      if (renderMode >= 0) pdfium.FPDFTextObj_SetTextRenderMode(object, renderMode);
      markObject(object, { id });
      if (!pdfium.FPDFPage_InsertObjectAtIndex(page, object, insertAt + index + 1)) throw new Error('Could not insert shaped Arabic text.');
      objects.push(object); object = 0;
      penX += position.xAdvance; penY += position.yAdvance;
    }
    return objects;
  } finally {
    if (object) pdfium.FPDFPageObj_Destroy(object);
    if (font) pdfium.FPDFFont_Close(font);
    pointers.forEach((ptr) => memory.wasmExports.free(ptr));
  }
}

module.exports = { shapedGlyphs, createShapedText, addShapedText, readTextGroup, textGroupObjects, textAnchorMatrix };
