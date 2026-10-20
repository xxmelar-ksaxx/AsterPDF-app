const { BuilderElement, TextRun } = require('docx');
const rtl = text => /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, ''));
const xml = (name, attrs = {}, children = []) => new BuilderElement({
  name, attributes: Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, { key, value }])), children
});
const emu = points => Math.round(points * 12700);

function positionedLines(runs) {
  const rows = [];
  for (const run of [...runs].sort((a, b) => (a.baseline?.[1] ?? a.box[3]) - (b.baseline?.[1] ?? b.box[3]))) {
    const baseline = run.baseline?.[1] ?? run.box[3];
    let row = rows.find(item => Math.abs(item.baseline - baseline) <= Math.max(.8, Math.min(item.size, run.size) * .12));
    if (!row) { row = { baseline, size: run.size, runs: [] }; rows.push(row); }
    row.runs.push(run);
  }
  return rows.flatMap(row => {
    const groups = [];
    for (const run of row.runs.sort((a, b) => a.box[0] - b.box[0])) {
      const previous = groups.at(-1)?.at(-1);
      // Card gutters in the supplied PDF are 30–33 points. The former
      // 2.5-em threshold joined four independent cards into one paragraph.
      // Join only adjacent fragments; preserve separated objects' positions.
      const gap = previous ? run.box[0] - previous.box[2] : Infinity;
      if (!previous || gap > Math.max(2, Math.min(previous.size, run.size) * .6) || gap < -1) groups.push([]);
      groups.at(-1).push(run);
    }
    return groups.map(group => {
      const direction = group.some(run => rtl(run.text));
      const sorted = [...group].sort((a, b) => direction ? b.box[0] - a.box[0] : a.box[0] - b.box[0]);
      // Numeric fragments in an RTL line still read left to right.
      for (let start = 0; start < sorted.length;) {
        if (!/^[\d\u0660-\u0669\u06f0-\u06f9.,\u066b\u066c+\-()%\s]+$/u.test(sorted[start].text)) { start++; continue; }
        let end = start + 1;
        while (end < sorted.length && /^[\d\u0660-\u0669\u06f0-\u06f9.,\u066b\u066c+\-()%\s]+$/u.test(sorted[end].text)) end++;
        sorted.splice(start, end - start, ...sorted.slice(start, end).sort((a, b) => a.box[0] - b.box[0]));
        start = end;
      }
      return { runs: sorted, rtl: direction, baseline: row.baseline,
        box: [Math.min(...group.map(run => run.box[0])), Math.min(...group.map(run => run.box[1])),
          Math.max(...group.map(run => run.box[2])), Math.max(...group.map(run => run.box[3]))] };
    });
  });
}

// A drawing anchor has page coordinates independent of the paragraph's bidi
// direction. wrap="none" here controls text INSIDE the box; wp:wrapNone only
// controls surrounding document text. Paragraph frames had no inside-wrap flag.
function positionedTextbox(paragraph, { x, y, width, height, id }) {
  const cx = emu(width), cy = emu(height);
  return new TextRun({ children: [xml('w:drawing', {}, [
    xml('wp:anchor', { distT: 0, distB: 0, distL: 0, distR: 0, simplePos: 0,
      relativeHeight: id, behindDoc: 0, locked: 1, layoutInCell: 1, allowOverlap: 1 }, [
      xml('wp:simplePos', { x: 0, y: 0 }),
      xml('wp:positionH', { relativeFrom: 'page' }, [xml('wp:posOffset', {}, [String(emu(x))])]),
      xml('wp:positionV', { relativeFrom: 'page' }, [xml('wp:posOffset', {}, [String(emu(y))])]),
      xml('wp:extent', { cx, cy }), xml('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }),
      xml('wp:wrapNone'), xml('wp:docPr', { id, name: `PDF text ${id}` }),
      xml('wp:cNvGraphicFramePr', {}, [xml('a:graphicFrameLocks', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main', noChangeAspect: 1 })]),
      xml('a:graphic', { 'xmlns:a': 'http://schemas.openxmlformats.org/drawingml/2006/main' }, [
        xml('a:graphicData', { uri: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape' }, [
          xml('wps:wsp', { 'xmlns:wps': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape' }, [
            xml('wps:cNvSpPr', { txBox: 1 }),
            xml('wps:spPr', {}, [
              xml('a:xfrm', {}, [xml('a:off', { x: 0, y: 0 }), xml('a:ext', { cx, cy })]),
              xml('a:prstGeom', { prst: 'rect' }, [xml('a:avLst')]),
              xml('a:noFill'), xml('a:ln', {}, [xml('a:noFill')])
            ]),
            xml('wps:txbx', {}, [xml('w:txbxContent', {}, [paragraph])]),
            xml('wps:bodyPr', { rot: 0, vert: 'horz', wrap: 'none', lIns: 0, tIns: 0, rIns: 0, bIns: 0,
              anchor: 't', anchorCtr: 0, vertOverflow: 'overflow', horzOverflow: 'overflow' }, [xml('a:noAutofit')])
          ])
        ])
      ])
    ])
  ])] });
}

module.exports = { positionedLines, positionedTextbox, rtl };
