import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { colorChannels } from './compression-predictor';

const name = PDFName.of;

function groupKey(stream: PDFRawStream, masks: Set<PDFRawStream>) {
  const dict = stream.dict;
  const color = dict.lookup(name('ColorSpace'));
  const family = color instanceof PDFArray ? color.lookup(0) : color;
  return [dict.get(name('Subtype')), dict.get(name('Filter')), family,
    colorChannels(color), dict.get(name('BitsPerComponent')), masks.has(stream)].join('|');
}

export function compressionSamples(pdf: PDFDocument, masks: Set<PDFRawStream>) {
  // Reading resource dictionaries is inexpensive. Decoding images to measure
  // actual savings only happens for the selected pages.
  const byResources = new Map<PDFDict, Set<PDFRawStream>>();
  function resources(root: PDFDict | undefined) {
    if (!root) return [];
    const cached = byResources.get(root);
    if (cached) return cached;
    const streams = new Set<PDFRawStream>(), visited = new Set<PDFDict>(), pending = [root];
    while (pending.length) {
      const dict = pending.pop()!;
      if (visited.has(dict)) continue;
      visited.add(dict);
      const objects = dict.lookup(name('XObject'));
      if (!(objects instanceof PDFDict)) continue;
      for (const [, ref] of objects.entries()) {
        const stream = pdf.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) continue;
        streams.add(stream);
        for (const key of ['Mask', 'SMask']) {
          const mask = stream.dict.lookup(name(key));
          if (mask instanceof PDFRawStream) streams.add(mask);
        }
        const nested = stream.dict.lookup(name('Resources'));
        if (nested instanceof PDFDict) pending.push(nested);
      }
    }
    byResources.set(root, streams);
    return streams;
  }

  const all = new Map<PDFRawStream, string>();
  const groups = new Map<string, { total: number; largest: number; measured: number }>();
  const candidates = pdf.getPages().map(page => {
    const streams = new Set(resources(page.node.Resources()));
    const contents = page.node.Contents();
    if (contents instanceof PDFRawStream) streams.add(contents);
    if (contents instanceof PDFArray) {
      for (let j = 0; j < contents.size(); j++) {
        const stream = contents.lookup(j);
        if (stream instanceof PDFRawStream) streams.add(stream);
      }
    }
    const examples = new Map<string, PDFRawStream[]>();
    for (const stream of streams) {
      let key = all.get(stream);
      if (key === undefined) {
        key = groupKey(stream, masks);
        all.set(stream, key);
        const group = groups.get(key) ?? { total: 0, largest: 0, measured: 0 };
        group.total += stream.contents.length;
        group.largest = Math.max(group.largest, stream.contents.length);
        groups.set(key, group);
      }
      const items = examples.get(key) ?? [];
      items.push(stream);
      examples.set(key, items);
    }
    // Bound the decoding work even if many pages share a resource dictionary.
    for (const [key, streams] of examples) {
      examples.set(key, streams.sort((a, b) => b.contents.length - a.contents.length).slice(0, 2));
    }
    return examples;
  });

  const sampled = new Set<PDFRawStream>();
  // Prioritize the image formats that account for the most bytes in this PDF.
  // After a group is represented, additional samples have diminishing weight.
  // Small examples earn less weight than full-sized examples of the same kind.
  for (let slot = 0; slot < Math.min(4, pdf.getPageCount()); slot++) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      let score = 0;
      for (const [key, streams] of candidates[i]) {
        const group = groups.get(key)!;
        const extra = streams.reduce((sum, stream) => sum + (sampled.has(stream) ? 0 : stream.contents.length), 0);
        if (!extra) continue;
        score += group.total * Math.exp(-group.measured / group.largest) * (1 - Math.exp(-extra / group.largest));
      }
      if (score > bestScore) { bestScore = score; best = i; }
    }
    const selected = candidates.splice(best, 1)[0];
    for (const [key, streams] of selected) {
      for (const stream of streams) {
        if (sampled.has(stream)) continue;
        groups.get(key)!.measured += stream.contents.length;
        sampled.add(stream);
      }
    }
  }
  return { all, sampled };
}
