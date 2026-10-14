import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees, decodePDFRawStream, PDFRawStream, PDFArray } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const { listOriginalText, replaceOriginalText, moveOriginalText, embedShapedOverlays } = require('../electron/original-text.cjs');
const { canEmbedInstalledFont, covers, matchScore, matchFontFiles, listInstalledFonts, getInstalledFont, normalize } = require('../electron/installed-fonts.cjs');

async function extracted(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;
  try { return (await (await document.getPage(1)).getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' '); }
  finally { await task.destroy(); }
}

test('original PDF text objects are replaced in saved page content, then editable again', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Original ABC', { x: 60, y: 500, size: 20, font });
  page.drawText('Leave me', { x: 60, y: 450, size: 16, font });
  const original = new Uint8Array(await pdf.save());
  const objects = await listOriginalText(original, 0);
  assert.equal(objects.length, 2);
  const first = objects.find((object: { text: string }) => object.text === 'Original ABC');
  assert.ok(first);
  const changed = await replaceOriginalText(original, 0, first.index, first.text, 'Changed XYZ');
  assert.match(await extracted(changed), /Changed XYZ/);
  assert.doesNotMatch(await extracted(changed), /Original ABC/);
  assert.match(await extracted(changed), /Leave me/);
  const next = (await listOriginalText(changed, 0)).find((object: { text: string }) => object.text === 'Changed XYZ');
  assert.ok(next);
  const repeated = await replaceOriginalText(changed, 0, next.index, next.text, 'Third pass');
  assert.match(await extracted(repeated), /Third pass/);
  assert.doesNotMatch(await extracted(repeated), /Changed XYZ/);
  const third = (await listOriginalText(repeated, 0)).find((object: { text: string }) => object.text === 'Third pass');
  const deleted = await replaceOriginalText(repeated, 0, third.index, third.text, '');
  assert.doesNotMatch(await extracted(deleted), /Third pass/);
  assert.match(await extracted(deleted), /Leave me/);
});

test('text color edits preserve original glyphs and layout, including shaped Arabic, and persist through later edits', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([500, 700]).drawText('Original color', { x: 60, y: 500, size: 20 });
  const source = new Uint8Array(await pdf.save());
  const arabic = await embedShapedOverlays(source, [{ pageIndex: 0, text: 'الأعمال', size: 24,
    matrix: [1, 0, 0, 1, 60, 400], color: [20, 30, 40] }]);
  let bytes = arabic;
  for (const text of ['Original color', 'الأعمال']) {
    const before = (await listOriginalText(bytes, 0)).find((object: { text: string }) => object.text === text);
    assert.ok(before);
    bytes = await replaceOriginalText(bytes, 0, before.index, text, text, 'original', [193, 55, 82]);
    const after = (await listOriginalText(bytes, 0)).find((object: { text: string }) => object.text === text);
    assert.deepEqual(after.color, [193, 55, 82, before.color[3]]);
    assert.deepEqual(after.box, before.box);
    assert.deepEqual(after.matrix, before.matrix);
    assert.equal(after.fontName, before.fontName);
    assert.equal(after.fontSize, before.fontSize);
  }
  const first = (await listOriginalText(bytes, 0)).find((object: { text: string }) => object.text === 'Original color');
  const replacement = await replaceOriginalText(bytes, 0, first.index, first.text, 'Changed color', 'noto-sans', [34, 150, 80]);
  const changed = (await listOriginalText(replacement, 0)).find((object: { text: string }) => object.text === 'Changed color');
  assert.deepEqual(changed.color.slice(0, 3), [34, 150, 80]);
  await assert.rejects(replaceOriginalText(bytes, 0, first.index, first.text, first.text, 'original', [999, 0, 0]), /Invalid text color/);
  assert.deepEqual((await listOriginalText(source, 0))[0].color, [0, 0, 0, 255]);
  // Inspect drawing operators too: the visible Arabic glyphs must be recolored,
  // not just the invisible logical text used for searching and selection.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;
  try {
    const operators = await (await document.getPage(1)).getOperatorList();
    const colors = operators.argsArray.filter((_: unknown, index: number) => operators.fnArray[index] === pdfjs.OPS.setFillRGBColor);
    assert.ok(colors.length > 0);
    assert.ok(colors.every((args: unknown[]) => args[0] === '#c13752'), JSON.stringify(colors));
  } finally { await task.destroy(); }
});

test('replacement that would run off the page fails without changing input', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Edge', { x: 420, y: 500, size: 20, font });
  const original = new Uint8Array(await pdf.save());
  const first = (await listOriginalText(original, 0)).find((object: { text: string }) => object.text === 'Edge');
  assert.ok(first);
  await assert.rejects(replaceOriginalText(original, 0, first.index, first.text, 'A much longer phrase'), /off the page/);
  assert.match(await extracted(original), /Edge/);
});

test('original text movement transforms saved content without changing its words or neighboring text', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Move me', { x: 60, y: 500, size: 20, font });
  page.drawText('Stay here', { x: 60, y: 450, size: 16, font });
  const original = new Uint8Array(await pdf.save());
  const before = (await listOriginalText(original, 0)).find((item: { text: string }) => item.text === 'Move me');
  assert.ok(before);
  assert.match(before.fontName, /Helvetica/);
  const moved = await moveOriginalText(original, 0, before.index, before.text, 45, -30);
  const after = (await listOriginalText(moved, 0)).find((item: { text: string }) => item.text === 'Move me');
  assert.ok(after);
  assert.ok(Math.abs(after.box[0] - before.box[0] - 45) < 1);
  assert.ok(Math.abs(after.box[1] - before.box[1] + 30) < 1);
  assert.match(await extracted(moved), /Stay here/);
  await assert.rejects(moveOriginalText(original, 0, before.index, before.text, -100, 0), /off the page/);
  await assert.rejects(moveOriginalText(original, 0, before.index, 'Wrong text', 20, 0), /changed/);
});

test('installed font matching checks name, glyph coverage, and permission to embed page content', async () => {
  const fontPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'NotoSans.ttf');
  const bytes = await readFile(fontPath);
  const font = fontkit.create(bytes);
  assert.equal(matchScore(font, 'ABCDEF+NotoSans-Regular'), 100);
  assert.equal(matchScore(font, 'ABCDEF+NotoSans-Regular-9742'), 100);
  assert.equal(matchScore(font, 'Unrelated'), 0);
  assert.equal(covers(font, 'Greek Ω text'), true);
  assert.equal(covers(font, '😀'), false);
  assert.equal(canEmbedInstalledFont(font), true);
  assert.equal(canEmbedInstalledFont({ 'OS/2': { fsType: { noEmbedding: true } } }), false);
  assert.equal(canEmbedInstalledFont({ 'OS/2': { fsType: { viewOnly: true } } }), true);
  assert.equal(canEmbedInstalledFont({ 'OS/2': { fsType: { bitmapOnly: true } } }), false);
  const matched = await matchFontFiles([fontPath], 'ABCDEF+NotoSans-Regular', 'Greek Ω text');
  assert.match(matched.name, /Noto Sans/);
  assert.equal(await matchFontFiles([fontPath], 'ABCDEF+NotoSans-Regular', '😀'), null);
  assert.equal(await matchFontFiles([fontPath], 'Unrelated', 'Greek Ω text'), null);
});

test('system font catalog exposes usable faces and extracts collection members', async (t) => {
  const fonts = await listInstalledFonts();
  assert.ok(fonts.length > 0);
  const first = fonts.find((entry: { file: string }) => /\.ttc$/i.test(entry.file));
  if (!first) { t.skip('No system font collection installed'); return; }
  const resolved = await getInstalledFont(first.id, 'Hello');
  assert.equal(fontkit.create(resolved.bytes).postscriptName, first.postscriptName);
});

test('installed SST Arabic styles are listed and retained through PDF edits', async (t) => {
  const fonts = await listInstalledFonts();
  let checked = 0;
  for (const style of ['Roman', 'Bold', 'Light', 'Medium']) {
    const file = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts', `SST Arabic ${style}.ttf`);
    let bytes: Uint8Array;
    try { bytes = await readFile(file); } catch { continue; }
    const name = fontkit.create(bytes).postscriptName;
    const installed = fonts.find((entry: { postscriptName: string }) => entry.postscriptName === name);
    assert.ok(installed, `${name} must appear when installed`);
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 800]);
    page.drawText('Original line', { x: 60, y: 500, size: 24, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const original = new Uint8Array(await pdf.save());
    const before = (await listOriginalText(original, 0))[0];
    const changed = await replaceOriginalText(original, 0, before.index, before.text, 'سلام', `system:${installed.id}`);
    const after = (await listOriginalText(changed, 0))[0];
    assert.equal(after.text, 'سلام');
    assert.equal(normalize(after.fontName), normalize(name));
    let repeated = changed;
    for (const text of ['الأعمال', 'الأعمالي', 'منهجية إنجاز كل الأعمالي', 'الأعمالي']) {
      const current = (await listOriginalText(repeated, 0))[0];
      repeated = await replaceOriginalText(repeated, 0, current.index, current.text, text, 'original');
      repeated = new Uint8Array(await (await PDFDocument.load(repeated)).save());
      const reopened = (await listOriginalText(repeated, 0))[0];
      assert.equal(reopened.text, text);
      assert.equal(normalize(reopened.fontName), normalize(name));
    }
    checked++;
  }
  if (!checked) t.skip('SST Arabic fixture is not installed');
});

test('Arabic marks use shaping offsets and the full line remains editable after moving and reopening', async () => {
  const fontBytes = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'NotoNaskhArabic.ttf'));
  const font = fontkit.create(fontBytes);
  const text = 'الأعمالي';
  const shaped = font.layout(text);
  assert.ok(shaped.positions.some((position: { yOffset: number }) => position.yOffset !== 0), 'fixture must contain positioned marks');
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]).drawText('Original line', { x: 60, y: 500, size: 24, font: await pdf.embedFont(StandardFonts.Helvetica) });
  let bytes = new Uint8Array(await pdf.save());
  const original = (await listOriginalText(bytes, 0))[0];
  bytes = await replaceOriginalText(bytes, 0, original.index, original.text, text, 'noto-naskh-arabic');
  const edited = (await listOriginalText(bytes, 0))[0];
  let penX = 0, penY = 0;
  const boxes = shaped.glyphs.map((glyph: { bbox: { minX: number; minY: number; maxX: number; maxY: number } }, index: number) => {
    const position = shaped.positions[index];
    const x = 60 + (penX + position.xOffset) * 24 / font.unitsPerEm;
    const y = 500 + (penY + position.yOffset) * 24 / font.unitsPerEm;
    penX += position.xAdvance; penY += position.yAdvance;
    return [x + glyph.bbox.minX * 24 / font.unitsPerEm, y + glyph.bbox.minY * 24 / font.unitsPerEm,
      x + glyph.bbox.maxX * 24 / font.unitsPerEm, y + glyph.bbox.maxY * 24 / font.unitsPerEm];
  });
  const expected = [Math.min(...boxes.map((box: number[]) => box[0])), Math.min(...boxes.map((box: number[]) => box[1])),
    Math.max(...boxes.map((box: number[]) => box[2])), Math.max(...boxes.map((box: number[]) => box[3]))];
  // PDFium uses the outline's control box; fontkit computes curve extrema.
  // The small tolerance still catches the missing 3.2pt/6.1pt mark offsets.
  expected.forEach((value, index) => assert.ok(Math.abs(edited.box[index] - value) < 0.5,
    `shaped bounds differ at coordinate ${index}: ${edited.box[index]} versus ${value}`));
  assert.equal(await extracted(bytes), text, 'copyable text must occur once');
  bytes = await moveOriginalText(bytes, 0, edited.index, edited.text, 35, -25);
  const moved = (await listOriginalText(bytes, 0))[0];
  assert.ok(Math.abs(moved.box[0] - edited.box[0] - 35) < 0.1);
  assert.ok(Math.abs(moved.box[1] - edited.box[1] + 25) < 0.1);
  for (const next of ['الأعمال', 'الأعمالي', 'الأعمالي 123 ABC', text]) {
    const current = (await listOriginalText(bytes, 0))[0];
    bytes = await replaceOriginalText(bytes, 0, current.index, current.text, next, 'original');
    bytes = new Uint8Array(await (await PDFDocument.load(bytes)).save());
    assert.equal((await listOriginalText(bytes, 0))[0].text, next);
  }
  let last = (await listOriginalText(bytes, 0))[0];
  assert.ok(Math.abs(last.box[0] - moved.box[0]) < 0.1, 'repeated edits must not drift from the moved anchor');
  bytes = await replaceOriginalText(bytes, 0, last.index, last.text, 'Latin text', 'noto-sans');
  last = (await listOriginalText(bytes, 0))[0];
  assert.equal(last.text, 'Latin text', 'switching away from Arabic must keep the new text visible');
  bytes = await replaceOriginalText(bytes, 0, last.index, last.text, text, 'noto-naskh-arabic');
  last = (await listOriginalText(bytes, 0))[0];
  bytes = await replaceOriginalText(bytes, 0, last.index, last.text, '');
  assert.equal((await listOriginalText(bytes, 0)).length, 0);
  const deleted = await PDFDocument.load(bytes);
  const contents = deleted.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => deleted.context.lookup(ref)) : [contents];
  for (const stream of streams) if (stream instanceof PDFRawStream)
    assert.doesNotMatch(new TextDecoder().decode(decodePDFRawStream(stream).decode()), /AsterText/, 'deleting must remove every visible glyph');
});

test('changing the length of rotated Arabic text does not fail an unrelated bounding-box check', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]).drawText('Short', { x: 300, y: 150, size: 24, font: await pdf.embedFont(StandardFonts.Helvetica), rotate: degrees(90) });
  let bytes = new Uint8Array(await pdf.save());
  for (const text of ['الأعمالي', 'منهجية إنجاز كل الأعمالي', 'الأعمالي']) {
    const current = (await listOriginalText(bytes, 0))[0];
    bytes = await replaceOriginalText(bytes, 0, current.index, current.text, text, 'noto-naskh-arabic');
    assert.equal((await listOriginalText(bytes, 0))[0].text, text);
  }
});

test('external Arabic ligatures retain logical order on first edit without changing separate alef-lam letters', async (t) => {
  const fonts: { name: string; bytes: Uint8Array }[] = [];
  for (const installed of (await listInstalledFonts()).filter((item: { postscriptName: string }) =>
    ['SSTArabic-Roman', 'ArialMT'].includes(item.postscriptName))) {
    fonts.push({ name: installed.postscriptName, bytes: (await getInstalledFont(installed.id, 'الأعمال')).bytes });
  }
  if (!fonts.length) { t.skip('SST Arabic or Arial is required for this external-font fixture'); return; }
  for (const face of fonts) for (const subset of [false, true]) {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(face.bytes, { subset });
    const page = pdf.addPage([800, 800]);
    const lines = ['الأعمال', 'منهجية إنجاز الأعمال ', 'لا لأ لإ لآ', 'ال أل إل آل'];
    lines.forEach((text, index) => page.drawText(text, { font, size: 24, x: 60, y: 650 - index * 70 }));
    page.drawText('الأعمال', { font, size: 24, x: 600, y: 200, rotate: degrees(90) });
    const original = await pdf.save();
    const objects = await listOriginalText(original, 0);
    assert.deepEqual(objects.map((item: { text: string }) => item.text.trimEnd()), [...lines.map((text) => text.trimEnd()), 'الأعمال'], `${face.name}, subset=${subset}`);
    let bytes = original;
    for (const replacement of ['الأعمالي', 'الأعمال']) {
      const selected = (await listOriginalText(bytes, 0))[0];
      bytes = await replaceOriginalText(bytes, 0, selected.index, selected.text, replacement);
      const reopened = await listOriginalText(await (await PDFDocument.load(bytes)).save(), 0);
      assert.equal(reopened[0].text, replacement);
      assert.equal(reopened[3].text.trimEnd(), 'ال أل إل آل', 'separate letters must not be swapped');
    }
  }
});

test('editing Arabic retains the installed original font, including PDF-generated name suffixes', async (t) => {
  const fonts = await listInstalledFonts();
  const installed = fonts.find((entry: { postscriptName: string }) => entry.postscriptName === '29LTZaridSerif-Regular');
  if (!installed) { t.skip('Arabic fixture font is not installed'); return; }
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([600, 800]);
  page.drawText('مرحبا', { x: 60, y: 500, size: 24, font: await pdf.embedFont((await getInstalledFont(installed.id, 'مرحبا')).bytes) });
  const original = new Uint8Array(await pdf.save());
  const before = (await listOriginalText(original, 0))[0];
  const changed = await replaceOriginalText(original, 0, before.index, before.text, 'سلام', 'original');
  const after = (await listOriginalText(changed, 0))[0];
  assert.equal(after.text, 'سلام');
  assert.equal(normalize(after.fontName), normalize(installed.postscriptName));
});

test('subset font missing a new glyph is genuinely replaced with embedded Noto Sans', async () => {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fontBytes = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'NotoSans.ttf'));
  const subset = await pdf.embedFont(fontBytes, { subset: true });
  const page = pdf.addPage([500, 700]);
  page.drawText('Subset text', { x: 60, y: 500, size: 20, font: subset });
  page.drawText('Keep this', { x: 60, y: 450, size: 16, font: subset });
  const original = new Uint8Array(await pdf.save());
  const found = (await listOriginalText(original, 0)).find((object: { text: string }) => object.text === 'Subset text');
  assert.ok(found);
  const updated = await replaceOriginalText(original, 0, found.index, found.text, 'Greek Ω text');
  assert.ok(updated.length > original.length + 10_000, 'replacement should embed a full fallback font');
  const content = await extracted(updated);
  assert.match(content, /Greek Ω text/);
  assert.doesNotMatch(content, /Subset text/);
  assert.match(content, /Keep this/);
  const next = (await listOriginalText(updated, 0)).find((object: { text: string }) => object.text === 'Greek Ω text');
  assert.ok(next);
  assert.ok(Math.abs(next.box[0] - found.box[0]) < 8);
  assert.ok(Math.abs(next.box[3] - found.box[3]) < 12);
});

test('explicit Noto Serif choice embeds replacement and stays editable', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 700]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Selected font', { x: 60, y: 500, size: 20, font });
  const original = new Uint8Array(await pdf.save());
  const first = (await listOriginalText(original, 0))[0];
  const changed = await replaceOriginalText(original, 0, first.index, first.text, 'Serif text', 'noto-serif');
  assert.match(await extracted(changed), /Serif text/);
  assert.ok((await listOriginalText(changed, 0)).some((item: { text: string }) => item.text === 'Serif text'));
});

test('Arabic replacement keeps joining data, Unicode, neighbors, and repeated edits', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Original line', { x: 60, y: 550, size: 24, font });
  page.drawText('Neighbor stays', { x: 60, y: 490, size: 16, font });
  const original = new Uint8Array(await pdf.save());
  const first = (await listOriginalText(original, 0)).find((item: { text: string }) => item.text === 'Original line');
  assert.ok(first);
  const mixed = '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 123 ABC';
  const changed = await replaceOriginalText(original, 0, first.index, first.text, mixed);
  assert.ok(changed.length > original.length + 100_000);
  const pdfJsMixed = await extracted(changed);
  assert.ok(pdfJsMixed.includes('\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645'));
  assert.ok(pdfJsMixed.includes('ABC 123'));
  assert.ok((await extracted(changed)).includes('Neighbor stays'));
  assert.doesNotMatch(await extracted(changed), /Original line/);
  const next = (await listOriginalText(changed, 0)).find((item: { text: string }) => item.text === mixed);
  assert.ok(next);
  const variants = '\u0644\u0627 \u0644\u0623 \u0644\u0625 \u0644\u0622';
  const repeated = await replaceOriginalText(changed, 0, next.index, next.text, variants, 'noto-naskh-arabic');
  assert.ok((await extracted(repeated)).includes(variants));
  const last = (await listOriginalText(repeated, 0)).find((item: { text: string }) => item.text === variants);
  assert.ok(last);
  const diacritics = '\u0633\u064e\u0644\u064e\u0627\u0645\u064c';
  const final = await replaceOriginalText(repeated, 0, last.index, last.text, diacritics);
  assert.ok((await extracted(final)).includes(diacritics));
  assert.ok((await extracted(final)).includes('Neighbor stays'));
});

test('added Arabic text is embedded in PDF content and remains inspectable', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  const source = new Uint8Array(await pdf.save());
  const arabic = '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645';
  const changed = await embedShapedOverlays(source, [
    { pageIndex: 0, text: arabic, size: 24, matrix: [1, 0, 0, 1, 60, 500], color: [20, 30, 40] },
  ]);
  assert.ok((await extracted(changed)).includes(arabic));
  assert.ok((await listOriginalText(changed, 0)).some((item: { text: string }) => item.text === arabic));
});
