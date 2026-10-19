const fs = require('node:fs/promises');
const path = require('node:path');
const { init } = require('@embedpdf/pdfium');
const { createShapedText, addShapedText, readTextGroup, textGroupObjects, textAnchorMatrix } = require('./shaped-text.cjs');
const fontkit = require('@pdf-lib/fontkit');
const { findInstalledFont, getInstalledFont, covers } = require('./installed-fonts.cjs');

let enginePromise;
const fontFiles = { 'noto-sans': 'NotoSans.ttf', 'noto-serif': 'NotoSerif.ttf', 'noto-naskh-arabic': 'NotoNaskhArabic.ttf' };
const fallbackFonts = new Map();
function fallbackFont(choice) {
  if (!fallbackFonts.has(choice)) fallbackFonts.set(choice, fs.readFile(path.join(__dirname, '..', 'assets', 'fonts', fontFiles[choice])));
  return fallbackFonts.get(choice);
}
async function engine() {
  if (!enginePromise) enginePromise = fs.readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
    .then((wasmBinary) => init({ wasmBinary })).then((pdfium) => { pdfium.PDFiumExt_Init(); return pdfium; })
    .catch((error) => { enginePromise = null; throw error; });
  return enginePromise;
}

function withDocument(pdfium, rawBytes, action) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length < 8 || rawBytes.length > 1024 * 1024 * 1024)
    throw new Error('Invalid PDF data.');
  const memory = pdfium.pdfium;
  const filePtr = memory.wasmExports.malloc(rawBytes.length);
  if (!filePtr) throw new Error('Could not allocate PDF editing memory.');
  let document = 0;
  try {
    memory.HEAPU8.set(rawBytes, filePtr);
    document = pdfium.FPDF_LoadMemDocument(filePtr, rawBytes.length, '');
    if (!document) throw new Error('This PDF cannot be opened for original text editing. It may be encrypted or damaged.');
    if (pdfium.EPDF_IsEncrypted(document)) throw new Error('Encrypted PDFs are not available for original text editing.');
    if (pdfium.FPDF_GetSignatureCount(document) > 0) throw new Error('Signed PDFs cannot be edited without invalidating signatures.');
    return action(document);
  } finally {
    if (document) pdfium.FPDF_CloseDocument(document);
    memory.wasmExports.free(filePtr);
  }
}

function pageTextCharacters(pdfium, textPage) {
  const byObject = new Map();
  for (let index = 0; index < pdfium.FPDFText_CountChars(textPage); index++) {
    const object = pdfium.FPDFText_GetTextObject(textPage, index);
    const code = pdfium.FPDFText_GetUnicode(textPage, index);
    if (!object || !code || code === 0x200b || code > 0x10ffff) continue;
    if (!byObject.has(object)) byObject.set(object, []);
    byObject.get(object).push({ index, text: String.fromCodePoint(code) });
  }
  return byObject;
}

function restoreArabicLigatures(pdfium, textPage, text, characters) {
  // Some PDFs map a lam-alef glyph to logical Unicode, but extraction reverses
  // the characters inside that glyph along with the RTL line. Only correct a
  // pair proven to share the same glyph origin AND bounds, never ordinary أل/ال.
  // PDFium can append a generated space to the object text without associating
  // that space with the text object in its character list.
  if (!characters || characters.map((item) => item.text).join('').trim() !== text.trim()) return text;
  const memory = pdfium.pdfium;
  const ptr = memory.wasmExports.malloc(48);
  const geometry = (index) => {
    if (!pdfium.FPDFText_GetCharOrigin(textPage, index, ptr, ptr + 8) ||
      !pdfium.FPDFText_GetCharBox(textPage, index, ptr + 16, ptr + 24, ptr + 32, ptr + 40)) return null;
    return [0, 8, 16, 24, 32, 40].map((offset) => memory.getValue(ptr + offset, 'double'));
  };
  const result = characters.map((item) => item.text);
  try {
    for (let index = 0; index + 1 < characters.length; index++) {
      if (!/^[\u0622\u0623\u0625\u0627\u0671]$/.test(result[index]) || result[index + 1] !== '\u0644') continue;
      const first = geometry(characters[index].index), second = geometry(characters[index + 1].index);
      if (!first || !second || first[3] <= first[2] || first[5] <= first[4] ||
        !first.every((value, at) => Number.isFinite(value) && Math.abs(value - second[at]) < 0.00001)) continue;
      [result[index], result[index + 1]] = [result[index + 1], result[index]];
      index++;
    }
    const leading = text.match(/^\s*/)[0], trailing = text.match(/\s*$/)[0];
    return leading + result.join('').trim() + trailing;
  } finally { memory.wasmExports.free(ptr); }
}

function objectText(pdfium, object, textPage, getCharacters = () => pageTextCharacters(pdfium, textPage)) {
  const group = readTextGroup(pdfium, object);
  if (group) return group.text || '';
  const length = pdfium.FPDFTextObj_GetText(object, textPage, 0, 0);
  if (length < 4 || length > 65536) return '';
  const memory = pdfium.pdfium;
  const ptr = memory.wasmExports.malloc(length);
  try {
    if (pdfium.FPDFTextObj_GetText(object, textPage, ptr, length) !== length) return '';
    const text = memory.UTF16ToString(ptr).replace(/\u200b/g, '');
    return /[\u0622\u0623\u0625\u0627\u0671]\u0644/.test(text)
      ? restoreArabicLigatures(pdfium, textPage, text, getCharacters().get(object)) : text;
  } finally { memory.wasmExports.free(ptr); }
}

function objectBounds(pdfium, object, ptr) {
  if (!pdfium.FPDFPageObj_GetBounds(object, ptr, ptr + 4, ptr + 8, ptr + 12)) return null;
  const box = [0, 4, 8, 12].map((offset) => pdfium.pdfium.getValue(ptr + offset, 'float'));
  return box.every(Number.isFinite) ? box : null;
}

function objectsBounds(pdfium, objects, ptr) {
  const boxes = objects.filter((object) => objects.length === 1 || pdfium.FPDFTextObj_GetTextRenderMode(object) !== 3)
    .map((object) => objectBounds(pdfium, object, ptr)).filter(Boolean);
  if (!boxes.length) return null;
  return [Math.min(...boxes.map((box) => box[0])), Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])), Math.max(...boxes.map((box) => box[3]))];
}

function overlaps(a, b) {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1 &&
    Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1;
}

function objectFontName(pdfium, object) {
  const font = pdfium.FPDFTextObj_GetFont(object);
  if (!font) return '';
  const length = pdfium.FPDFFont_GetBaseFontName(font, 0, 0);
  if (!length || length > 512) return '';
  const memory = pdfium.pdfium;
  const ptr = memory.wasmExports.malloc(length);
  try {
    pdfium.FPDFFont_GetBaseFontName(font, ptr, length);
    return memory.UTF8ToString(ptr);
  } finally { memory.wasmExports.free(ptr); }
}
function subsetFont(pdfium, object) { return /^[A-Z]{6}\+/.test(objectFontName(pdfium, object)); }

function createFallbackText(pdfium, document, page, object, objectIndex, replacement, fontBytes) {
  const memory = pdfium.pdfium;
  const fontPtr = memory.wasmExports.malloc(fontBytes.length);
  const matrixPtr = memory.wasmExports.malloc(24);
  const colorPtr = memory.wasmExports.malloc(16);
  const sizePtr = memory.wasmExports.malloc(4);
  const textPtr = memory.wasmExports.malloc((replacement.length + 1) * 2);
  let font = 0;
  let next = 0;
  try {
    memory.HEAPU8.set(fontBytes, fontPtr);
    font = pdfium.FPDFText_LoadFont(document, fontPtr, fontBytes.length, 2, true);
    if (!font) throw new Error('Could not load the selected replacement font.');
    if (!pdfium.FPDFTextObj_GetFontSize(object, sizePtr)) throw new Error('Could not read the original text size.');
    const size = memory.getValue(sizePtr, 'float');
    if (!Number.isFinite(size) || size <= 0) throw new Error('The original text size is invalid.');
    next = pdfium.FPDFPageObj_CreateTextObj(document, font, size);
    if (!next) throw new Error('Could not create a replacement text object.');
    memory.stringToUTF16(replacement, textPtr, (replacement.length + 1) * 2);
    if (!pdfium.FPDFText_SetText(next, textPtr)) throw new Error('The selected font cannot encode this text.');
    textAnchorMatrix(pdfium, object, matrixPtr).forEach((value, index) => memory.setValue(matrixPtr + index * 4, value, 'float'));
    if (!pdfium.FPDFPageObj_SetMatrix(next, matrixPtr))
      throw new Error('Could not preserve the original text position.');
    if (pdfium.FPDFPageObj_GetFillColor(object, colorPtr, colorPtr + 4, colorPtr + 8, colorPtr + 12))
      pdfium.FPDFPageObj_SetFillColor(next, ...[0, 4, 8, 12].map((offset) => memory.getValue(colorPtr + offset, 'i32')));
    const renderMode = readTextGroup(pdfium, object)?.renderMode ?? pdfium.FPDFTextObj_GetTextRenderMode(object);
    if (renderMode >= 0) pdfium.FPDFTextObj_SetTextRenderMode(next, renderMode);
    if (!pdfium.FPDFPage_RemoveObject(page, object)) throw new Error('Could not remove the original text object.');
    pdfium.FPDFPageObj_Destroy(object);
    if (!pdfium.FPDFPage_InsertObjectAtIndex(page, next, objectIndex)) throw new Error('Could not insert the replacement text object.');
    next = 0;
  } finally {
    if (next) pdfium.FPDFPageObj_Destroy(next);
    if (font) pdfium.FPDFFont_Close(font);
    memory.wasmExports.free(textPtr);
    memory.wasmExports.free(sizePtr);
    memory.wasmExports.free(colorPtr);
    memory.wasmExports.free(matrixPtr);
    memory.wasmExports.free(fontPtr);
  }
}

async function listOriginalText(rawBytes, pageIndex) {
  const pdfium = await engine();
  return withDocument(pdfium, rawBytes, (document) => {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdfium.FPDF_GetPageCount(document)) throw new Error('Invalid PDF page.');
    const page = pdfium.FPDF_LoadPage(document, pageIndex);
    if (!page) throw new Error('Could not inspect this PDF page.');
    const textPage = pdfium.FPDFText_LoadPage(page);
    const memory = pdfium.pdfium;
    const boundsPtr = memory.wasmExports.malloc(16);
    const stylePtr = memory.wasmExports.malloc(44);
    let characters;
    const getCharacters = () => characters ||= pageTextCharacters(pdfium, textPage);
    try {
      const found = [];
      for (let index = 0; index < pdfium.FPDFPage_CountObjects(page); index++) {
        const object = pdfium.FPDFPage_GetObject(page, index);
        if (!object || pdfium.FPDFPageObj_GetType(object) !== 1 ||
          (pdfium.FPDFTextObj_GetTextRenderMode(object) === 3 && !readTextGroup(pdfium, object)?.text)) continue;
        const text = objectText(pdfium, object, textPage, getCharacters);
        if (!text.trim()) continue;
        const box = objectsBounds(pdfium, textGroupObjects(pdfium, page, object), boundsPtr);
        if (!box) continue;
        if (box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]) {
          const matrix = textAnchorMatrix(pdfium, object, stylePtr);
          const fontSize = pdfium.FPDFTextObj_GetFontSize(object, stylePtr + 24) ? memory.getValue(stylePtr + 24, 'float') : 12;
          const color = pdfium.FPDFPageObj_GetFillColor(object, stylePtr + 28, stylePtr + 32, stylePtr + 36, stylePtr + 40)
            ? [28, 32, 36, 40].map((offset) => memory.getValue(stylePtr + offset, 'i32')) : [0, 0, 0, 255];
          found.push({ index, text, box, fontName: objectFontName(pdfium, object), matrix, fontSize, color });
        }
      }
      return found;
    } finally {
      memory.wasmExports.free(boundsPtr);
      memory.wasmExports.free(stylePtr);
      if (textPage) pdfium.FPDFText_ClosePage(textPage);
      pdfium.FPDF_ClosePage(page);
    }
  });
}

async function replaceOriginalText(rawBytes, pageIndex, objectIndex, expectedText, replacement, fontChoice = 'original', color) {
  if (color !== undefined && (!Array.isArray(color) || color.length !== 3 ||
    !color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))) throw new Error('Invalid text color.');
  const colorOnly = color !== undefined && replacement === expectedText && fontChoice === 'original';
  const systemId = typeof fontChoice === 'string' && /^system:[a-f0-9]{24}$/.test(fontChoice) ? fontChoice.slice(7) : null;
  if (fontChoice !== 'original' && !fontFiles[fontChoice] && !systemId) throw new Error('Choose an available replacement font.');
  if (!colorOnly && /[\u0590-\u05ff]/u.test(replacement))
    throw new Error('Hebrew text needs a shaped PDF font writer. The PDF was not changed.');
  if (typeof replacement !== 'string' || replacement.length > 10000 || /[\r\n]/.test(replacement))
    throw new Error('Edit one text line at a time (up to 10,000 characters).');
  const pdfium = await engine();
  const before = replacement ? (await listOriginalText(rawBytes, pageIndex)).find((item) => item.index === objectIndex && item.text === expectedText) : null;
  if (replacement && !before) throw new Error('The original text changed. Select it again.');
  const shaped = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(replacement) || fontChoice === 'noto-naskh-arabic';
  const fontBytes = replacement && !colorOnly && !systemId ? await fallbackFont(fontChoice === 'original'
    ? shaped ? 'noto-naskh-arabic' : 'noto-sans' : fontChoice) : null;
  const installedMatch = replacement && !colorOnly && fontChoice === 'original' ? await findInstalledFont(before.fontName, replacement) : null;
  const chosenSystem = replacement && !colorOnly && systemId ? await getInstalledFont(systemId, replacement) : null;
  const replacementFontBytes = chosenSystem?.bytes || installedMatch?.bytes || fontBytes;
  const chosenFont = replacement && !colorOnly ? fontkit.create(replacementFontBytes) : null;
  const chosenFace = Array.isArray(chosenFont?.fonts) ? chosenFont.getFont(chosenSystem?.postscriptName) : chosenFont;
  if (replacement && !colorOnly && !covers(chosenFace, replacement))
    throw new Error('The selected font cannot display all characters in this text. Choose another font.');
  let usedFallback = false;
  const editOnce = (forceFallback) => withDocument(pdfium, rawBytes, (document) => {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdfium.FPDF_GetPageCount(document)) throw new Error('Invalid PDF page.');
    const page = pdfium.FPDF_LoadPage(document, pageIndex);
    if (!page) throw new Error('Could not load this PDF page.');
    let textPage = 0;
    try {
      if (!Number.isInteger(objectIndex) || objectIndex < 0 || objectIndex >= pdfium.FPDFPage_CountObjects(page))
        throw new Error('The original text object changed. Select it again.');
      const object = pdfium.FPDFPage_GetObject(page, objectIndex);
      if (!object || pdfium.FPDFPageObj_GetType(object) !== 1) throw new Error('The selected item is not editable text.');
      textPage = pdfium.FPDFText_LoadPage(page);
      if (!textPage || objectText(pdfium, object, textPage) !== expectedText) throw new Error('The original text changed. Select it again.');
      pdfium.FPDFText_ClosePage(textPage); textPage = 0;
      const originalObjects = textGroupObjects(pdfium, page, object);
      const applyColor = (objects) => {
        if (!color) return;
        for (const member of objects) {
          const rgba = [...color, before?.color[3] ?? 255];
          if (!pdfium.FPDFPageObj_SetFillColor(member, ...rgba) || !pdfium.FPDFPageObj_SetStrokeColor(member, ...rgba))
            throw new Error('Could not change the text color.');
        }
      };
      if (colorOnly) applyColor(originalObjects);
      else if (replacement) {
        const memory = pdfium.pdfium;
        const size = (replacement.length + 1) * 2;
        const ptr = memory.wasmExports.malloc(size);
        const boundsPtr = memory.wasmExports.malloc(16);
        try {
          const previousBounds = objectsBounds(pdfium, originalObjects, boundsPtr);
          for (const member of originalObjects) {
            if (member === object) continue;
            if (!pdfium.FPDFPage_RemoveObject(page, member)) throw new Error('Could not replace the original text group.');
            pdfium.FPDFPageObj_Destroy(member);
          }
          let nextObjects;
          if (shaped) {
            nextObjects = createShapedText(pdfium, document, page, object, objectIndex, replacement, replacementFontBytes);
            usedFallback = true;
          } else if (fontChoice !== 'original' || installedMatch || forceFallback || subsetFont(pdfium, object)) {
            createFallbackText(pdfium, document, page, object, objectIndex, replacement, replacementFontBytes);
            usedFallback = true;
          } else {
            memory.stringToUTF16(replacement, ptr, size);
            if (!pdfium.FPDFText_SetText(object, ptr)) throw new Error('The PDF font cannot encode that text.');
          }
          nextObjects ||= [pdfium.FPDFPage_GetObject(page, objectIndex)];
          applyColor(nextObjects);
          const nextBounds = objectsBounds(pdfium, nextObjects, boundsPtr);
          const replaced = new Set(nextObjects);
          if (!nextBounds || nextBounds[0] < -1 || nextBounds[1] < -1 ||
            nextBounds[2] > pdfium.FPDF_GetPageWidthF(page) + 1 || nextBounds[3] > pdfium.FPDF_GetPageHeightF(page) + 1)
            throw new Error('The replacement text would run off the page. Shorten it.');
          for (let index = 0; index < pdfium.FPDFPage_CountObjects(page); index++) {
            const neighbor = pdfium.FPDFPage_GetObject(page, index);
            if (!neighbor || replaced.has(neighbor) || pdfium.FPDFPageObj_GetType(neighbor) !== 1 ||
              pdfium.FPDFTextObj_GetTextRenderMode(neighbor) === 3) continue;
            const box = objectBounds(pdfium, neighbor, boundsPtr);
            if (box && overlaps(nextBounds, box) && (!previousBounds || !overlaps(previousBounds, box)))
              throw new Error('The replacement text would overlap neighboring text. Shorten it.');
          }
        } finally { memory.wasmExports.free(boundsPtr); memory.wasmExports.free(ptr); }
      } else {
        for (const member of originalObjects) {
          if (!pdfium.FPDFPage_RemoveObject(page, member)) throw new Error('Could not remove this text object.');
          pdfium.FPDFPageObj_Destroy(member);
        }
      }
      if (!pdfium.FPDFPage_GenerateContent(page)) throw new Error('Could not rebuild the PDF page content.');
      const writer = pdfium.PDFiumExt_OpenFileWriter();
      if (!writer) throw new Error('Could not create a PDF output writer.');
      try {
        if (!pdfium.PDFiumExt_SaveAsCopy(document, writer)) throw new Error('Could not save the edited PDF.');
        const length = pdfium.PDFiumExt_GetFileWriterSize(writer);
        if (length < 8 || length > 1024 * 1024 * 1024) throw new Error('Invalid edited PDF size.');
        const memory = pdfium.pdfium;
        const ptr = memory.wasmExports.malloc(length);
        try {
          if (pdfium.PDFiumExt_GetFileWriterData(writer, ptr, length) !== length) throw new Error('Could not read the edited PDF.');
          return Uint8Array.from(memory.HEAPU8.subarray(ptr, ptr + length));
        } finally { memory.wasmExports.free(ptr); }
      } finally { pdfium.PDFiumExt_CloseFileWriter(writer); }
    } finally {
      if (textPage) pdfium.FPDFText_ClosePage(textPage);
      pdfium.FPDF_ClosePage(page);
    }
  });
  let output;
  try { output = editOnce(false); }
  catch (cause) {
    if (!replacement || !/PDF font cannot encode/.test(cause.message)) throw cause;
    output = editOnce(true);
  }
  if (replacement) {
    const valid = async (bytes) => (await listOriginalText(bytes, pageIndex))
      .some((item) => item.index === objectIndex && item.text === replacement);
    if (!(await valid(output)) && !usedFallback) {
      output = editOnce(true);
    }
    if (!(await valid(output))) throw new Error('The PDF font could not reliably encode the new text. The PDF was not changed.');
  }
  return output;
}

async function moveOriginalText(rawBytes, pageIndex, objectIndex, expectedText, dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Invalid text movement.');
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return rawBytes;
  const pdfium = await engine();
  return withDocument(pdfium, rawBytes, (document) => {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdfium.FPDF_GetPageCount(document)) throw new Error('Invalid PDF page.');
    const page = pdfium.FPDF_LoadPage(document, pageIndex);
    if (!page) throw new Error('Could not load this PDF page.');
    let textPage = 0;
    const memory = pdfium.pdfium;
    const boundsPtr = memory.wasmExports.malloc(16);
    try {
      if (!Number.isInteger(objectIndex) || objectIndex < 0 || objectIndex >= pdfium.FPDFPage_CountObjects(page))
        throw new Error('The original text object changed. Select it again.');
      const object = pdfium.FPDFPage_GetObject(page, objectIndex);
      if (!object || pdfium.FPDFPageObj_GetType(object) !== 1) throw new Error('The selected item is not editable text.');
      textPage = pdfium.FPDFText_LoadPage(page);
      if (!textPage || objectText(pdfium, object, textPage) !== expectedText) throw new Error('The original text changed. Select it again.');
      pdfium.FPDFText_ClosePage(textPage); textPage = 0;
      const members = textGroupObjects(pdfium, page, object);
      const box = objectsBounds(pdfium, members, boundsPtr);
      const pageWidth = pdfium.FPDF_GetPageWidthF(page), pageHeight = pdfium.FPDF_GetPageHeightF(page);
      if (!box || box[0] + dx < -1 || box[1] + dy < -1 || box[2] + dx > pageWidth + 1 || box[3] + dy > pageHeight + 1)
        throw new Error('The text would move off the page.');
      for (const member of members) pdfium.FPDFPageObj_Transform(member, 1, 0, 0, 1, dx, dy);
      if (!pdfium.FPDFPage_GenerateContent(page)) throw new Error('Could not rebuild the PDF page content.');
      const writer = pdfium.PDFiumExt_OpenFileWriter();
      if (!writer) throw new Error('Could not create a PDF output writer.');
      try {
        if (!pdfium.PDFiumExt_SaveAsCopy(document, writer)) throw new Error('Could not save the moved PDF text.');
        const length = pdfium.PDFiumExt_GetFileWriterSize(writer);
        if (length < 8 || length > 1024 * 1024 * 1024) throw new Error('Invalid edited PDF size.');
        const ptr = memory.wasmExports.malloc(length);
        try {
          if (pdfium.PDFiumExt_GetFileWriterData(writer, ptr, length) !== length) throw new Error('Could not read the edited PDF.');
          return Uint8Array.from(memory.HEAPU8.subarray(ptr, ptr + length));
        } finally { memory.wasmExports.free(ptr); }
      } finally { pdfium.PDFiumExt_CloseFileWriter(writer); }
    } finally {
      memory.wasmExports.free(boundsPtr);
      if (textPage) pdfium.FPDFText_ClosePage(textPage);
      pdfium.FPDF_ClosePage(page);
    }
  });
}

async function embedShapedOverlays(rawBytes, placements) {
  if (!Array.isArray(placements) || placements.length > 5000) throw new Error('Invalid shaped text objects.');
  if (!placements.length) return rawBytes;
  const pdfium = await engine();
  const fonts = new Map();
  for (const item of placements) {
    const choice = item?.fontChoice || 'noto-naskh-arabic';
    if (typeof item?.text !== 'string' || item.text.length > 10000 || typeof choice !== 'string') throw new Error('Invalid shaped text object.');
    if (/^system:[a-f0-9]{24}$/.test(choice)) {
      fonts.set(item, (await getInstalledFont(choice.slice(7), item.text)).bytes);
    } else if (choice === 'helvetica' || fontFiles[choice]) {
      fonts.set(item, await fallbackFont(choice === 'helvetica' ? 'noto-naskh-arabic' : choice));
    } else throw new Error('Choose an available text font.');
  }
  return withDocument(pdfium, rawBytes, (document) => {
    for (const item of placements) {
      if (!Number.isInteger(item.pageIndex) || item.pageIndex < 0 || item.pageIndex >= pdfium.FPDF_GetPageCount(document) ||
        typeof item.text !== 'string' || !item.text || item.text.length > 10000 || /[\r\n]/.test(item.text) ||
        !Number.isFinite(item.size) || item.size < 4 || item.size > 500 ||
        !Array.isArray(item.matrix) || item.matrix.length !== 6 || !item.matrix.every(Number.isFinite) ||
        !Array.isArray(item.color) || item.color.length !== 3 || !item.color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))
        throw new Error('Invalid shaped text object.');
      const page = pdfium.FPDF_LoadPage(document, item.pageIndex);
      if (!page) throw new Error('Could not load the page for Arabic text.');
      try {
        addShapedText(pdfium, document, page, item.text, fonts.get(item), item.size, item.matrix, item.color, item.bold === true);
        if (!pdfium.FPDFPage_GenerateContent(page)) throw new Error('Could not save the Arabic page content.');
      } finally { pdfium.FPDF_ClosePage(page); }
    }
    const writer = pdfium.PDFiumExt_OpenFileWriter();
    if (!writer) throw new Error('Could not create a PDF output writer.');
    try {
      if (!pdfium.PDFiumExt_SaveAsCopy(document, writer)) throw new Error('Could not save shaped Arabic text.');
      const length = pdfium.PDFiumExt_GetFileWriterSize(writer);
      if (length < 8 || length > 1024 * 1024 * 1024) throw new Error('Invalid edited PDF size.');
      const ptr = pdfium.pdfium.wasmExports.malloc(length);
      try {
        if (pdfium.PDFiumExt_GetFileWriterData(writer, ptr, length) !== length) throw new Error('Could not read the edited PDF.');
        return Uint8Array.from(pdfium.pdfium.HEAPU8.subarray(ptr, ptr + length));
      } finally { pdfium.pdfium.wasmExports.free(ptr); }
    } finally { pdfium.PDFiumExt_CloseFileWriter(writer); }
  });
}

module.exports = { listOriginalText, replaceOriginalText, moveOriginalText, embedShapedOverlays };
