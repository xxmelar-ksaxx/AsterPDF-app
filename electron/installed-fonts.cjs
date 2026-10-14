const fs = require('node:fs/promises');
const path = require('node:path');
const fontkit = require('@pdf-lib/fontkit');
const crypto = require('node:crypto');

const normalize = (name) => String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/-\d{3,}$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const canonical = (name) => String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[-_,]/g, ' ');

function canEmbedInstalledFont(font) {
  const rights = font['OS/2']?.fsType;
  // This check is for a locally installed font used to write PDF page content.
  // Preview/print permits that embedding; it restricts editing with the embedded
  // copy on another machine, not authoring with the installed font.
  // https://adobe-type-tools.github.io/font-tech-notes/pdfs/AcrobatDC_FontPolicies.pdf
  return Boolean(rights && !rights.noEmbedding && !rights.bitmapOnly);
}

function covers(font, value) {
  return Array.from(value).every((character) => font.hasGlyphForCodePoint(character.codePointAt(0)));
}

function matchScore(font, pdfName) {
  const wanted = normalize(pdfName);
  const family = normalize(font.familyName);
  const full = normalize(`${font.familyName} ${font.subfamilyName}`);
  const postscript = normalize(font.postscriptName);
  if (!wanted || !family) return 0;
  if (wanted === postscript) return 100;
  if (wanted === full) return 95;
  if (wanted === family) return normalize(font.subfamilyName) === 'regular' ? 85 : 80;
  return 0;
}

async function installedFontPaths() {
  const dirs = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')]
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts', '/Library/Fonts', '/Network/Library/Fonts', path.join(process.env.HOME || '', 'Library', 'Fonts')]
      : ['/usr/share/fonts', path.join(process.env.HOME || '', '.local', 'share', 'fonts')];
  const found = [];
  async function visit(dir, depth) {
    if (!dir || depth > 3) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile() && /\.(ttf|otf|ttc|otc)$/i.test(entry.name)) found.push(file);
    }
  }
  for (const dir of dirs) await visit(dir, 0);
  return found;
}

let catalogPromise;
function extractCollectionFace(bytes, faceIndex) {
  if (bytes.toString('ascii', 0, 4) !== 'ttcf') return bytes;
  const count = bytes.readUInt32BE(8);
  if (faceIndex < 0 || faceIndex >= count) throw new Error('Invalid system font collection.');
  const base = bytes.readUInt32BE(12 + faceIndex * 4);
  const tables = bytes.readUInt16BE(base + 4);
  if (tables < 1 || tables > 100) throw new Error('Invalid system font tables.');
  const records = [];
  let total = 12 + tables * 16;
  for (let index = 0; index < tables; index++) {
    const at = base + 12 + index * 16;
    const offset = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    if (!length || offset + length > bytes.length) throw new Error('Invalid system font table.');
    total = (total + 3) & ~3;
    records.push({ tag: bytes.toString('ascii', at, at + 4), offset, length, target: total });
    total += length;
  }
  const output = Buffer.alloc((total + 3) & ~3);
  bytes.copy(output, 0, base, base + 4);
  output.writeUInt16BE(tables, 4);
  const power = 2 ** Math.floor(Math.log2(tables));
  output.writeUInt16BE(power * 16, 6);
  output.writeUInt16BE(Math.log2(power), 8);
  output.writeUInt16BE(tables * 16 - power * 16, 10);
  let headOffset = -1;
  records.forEach((record, index) => {
    bytes.copy(output, record.target, record.offset, record.offset + record.length);
    if (record.tag === 'head') { headOffset = record.target; output.writeUInt32BE(0, headOffset + 8); }
    const at = 12 + index * 16;
    output.write(record.tag, at, 4, 'ascii');
    output.writeUInt32BE(checksum(output, record.target, record.length), at + 4);
    output.writeUInt32BE(record.target, at + 8);
    output.writeUInt32BE(record.length, at + 12);
  });
  if (headOffset >= 0) output.writeUInt32BE((0xB1B0AFBA - checksum(output, 0, output.length)) >>> 0, headOffset + 8);
  return output;
}
function checksum(bytes, offset, length) {
  let sum = 0;
  for (let at = offset; at < offset + length; at += 4) {
    const value = ((bytes[at] || 0) << 24) | ((bytes[at + 1] || 0) << 16) | ((bytes[at + 2] || 0) << 8) | (bytes[at + 3] || 0);
    sum = (sum + (value >>> 0)) >>> 0;
  }
  return sum;
}
async function listInstalledFonts() {
  catalogPromise ||= (async () => {
    const files = await installedFontPaths();
    const entries = [];
    // Keep the renderer's list independent of local paths. IDs are checked against this catalog on use.
    for (const file of files) {
      try {
        const bytes = await fs.readFile(file);
        const parsed = fontkit.create(bytes);
        const faces = Array.isArray(parsed.fonts) ? parsed.fonts : [parsed];
        for (const face of faces) {
          if (!face.familyName || !face.postscriptName || !canEmbedInstalledFont(face)) continue;
          const id = crypto.createHash('sha256').update(file).update('\0').update(face.postscriptName).digest('hex').slice(0, 24);
          entries.push({ id, family: face.familyName, style: face.subfamilyName || 'Regular', postscriptName: face.postscriptName, file });
        }
      } catch { /* Skip formats the PDF font engine cannot inspect. */ }
    }
    entries.sort((a, b) => `${a.family} ${a.style}`.localeCompare(`${b.family} ${b.style}`));
    return entries;
  })().catch((error) => { catalogPromise = null; throw error; });
  return catalogPromise;
}
async function getInstalledFont(id, replacement) {
  const entry = (await listInstalledFonts()).find((font) => font.id === id);
  if (!entry) throw new Error('This system font is no longer installed. Choose another font.');
  const bytes = await fs.readFile(entry.file);
  const parsed = fontkit.create(bytes);
  const faceIndex = Array.isArray(parsed.fonts) ? parsed.fonts.findIndex((font) => font.postscriptName === entry.postscriptName) : 0;
  if (faceIndex < 0) throw new Error('The selected system font is unavailable.');
  const individualBytes = extractCollectionFace(bytes, faceIndex);
  const face = fontkit.create(individualBytes);
  if (!face || !canEmbedInstalledFont(face) || !covers(face, replacement))
    throw new Error(`${entry.family} ${entry.style} cannot embed all characters in this text. Choose another font.`);
  return { bytes: individualBytes, name: `${entry.family} ${entry.style}`.trim(), postscriptName: entry.postscriptName };
}
async function matchFontFiles(files, pdfName, replacement) {
  if (!pdfName || !replacement) return null;
  let best = null;
  for (const file of files) {
    // A filename check avoids loading hundreds of unrelated system fonts.
    const filename = normalize(path.basename(file, '.ttf'));
    const wanted = normalize(pdfName);
    if (!wanted.includes(filename) && !filename.includes(wanted) && filename.slice(0, 4) !== wanted.slice(0, 4)) continue;
    let bytes, font;
    try { bytes = await fs.readFile(file); font = fontkit.create(bytes); } catch { continue; }
    const score = matchScore(font, pdfName);
    if (score > (best?.score || 0) && canEmbedInstalledFont(font) && covers(font, replacement))
      best = { name: `${font.familyName} ${font.subfamilyName}`.trim(), bytes, score };
  }
  return best && { name: best.name, bytes: best.bytes };
}
async function findInstalledFont(pdfName, replacement) {
  if (!pdfName || !replacement) return null;
  const matches = (await listInstalledFonts()).map((entry) => ({ entry, score: matchScore({
    familyName: entry.family, subfamilyName: entry.style, postscriptName: entry.postscriptName
  }, pdfName) })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
  for (const { entry } of matches) {
    try { return await getInstalledFont(entry.id, replacement); } catch { /* Try another matching face. */ }
  }
  return null;
}

module.exports = { canonical, normalize, canEmbedInstalledFont, covers, matchScore, matchFontFiles, findInstalledFont, listInstalledFonts, getInstalledFont, extractCollectionFace };
