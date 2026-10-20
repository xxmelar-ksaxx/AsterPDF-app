const { textLines } = require('./word-layout.cjs');

const hasDigits = text => /[0-9\u0660-\u0669\u06f0-\u06f9]/u.test(text);
const isRtl = text => /[\u0590-\u08ff]/u.test(text);
const digitInventory = text => [...text].filter(character => hasDigits(character)).sort().join('');
const numericPiece = text => /^[0-9\u0660-\u0669\u06f0-\u06f9.,\u066b\u066c+\-\u2212()%\u066a\/:\s]+$/u.test(text);

// Never parse, localize, round, or reverse extracted numeric strings.
// RTL paragraphs still place contiguous number fragments left to right.
// Wide gaps remain spaces; inferred fragment grouping is flagged by the caller.
function lineText(line) {
  const pieces = [];
  for (let index = 0; index < line.runs.length;) {
    const group = [line.runs[index++]];
    if (line.rtl && numericPiece(group[0].text)) {
      while (index < line.runs.length && numericPiece(line.runs[index].text)) {
        const previous = group.at(-1), next = line.runs[index];
        const gap = previous.box[0] - next.box[2];
        if (gap < -.5 || gap > .3 * Math.min(previous.size, next.size)) break;
        group.push(next); index++;
      }
      group.sort((a, b) => a.box[0] - b.box[0]);
    }
    pieces.push(...group.map(run => ({ run, group })));
  }
  return pieces.reduce((text, { run, group }, index) => {
    if (!index || /\s$/.test(text) || /^\s/.test(run.text)) return text + run.text;
    const previous = pieces[index - 1].run;
    const sameNumericGroup = group === pieces[index - 1].group;
    // Nearest geometric edges work at the boundary of reordered numeric runs.
    const gap = Math.max(run.box[0], previous.box[0]) - Math.min(run.box[2], previous.box[2]);
    return text + (!sameNumericGroup && gap > Math.min(previous.size, run.size) * .15 ? ' ' : '') + run.text;
  }, '');
}

function dataBlocks(runs, tables) {
  // A run spanning a separator cannot safely be assigned to either cell.
  // Keep it as text and flag the table instead of moving a value under a header.
  const safeTables = tables.filter(table => !tables.some(other => other !== table && other.runs.some(run => table.runs.includes(run))) &&
    table.cells.every(cell => cell.runs.every(run =>
    run.box[0] >= cell.box[0] - 1 && run.box[2] <= cell.box[2] + 1 &&
    run.box[1] >= cell.box[1] - 1 && run.box[3] <= cell.box[3] + 1)));
  const assigned = new Set(safeTables.flatMap(table => table.runs));
  const lines = textLines(runs.filter(run => !assigned.has(run)), true);
  const blocks = [
    ...lines.map(line => ({ type: 'text', box: line.box, line })),
    ...safeTables.map(table => ({ type: 'table', box: table.box, table }))
  ];
  // Cut at full-height gutters before splitting rows, keeping each column's
  // content together. Use a stack to handle dense pages without recursion.
  const pending = [blocks], ordered = [];
  while (pending.length) {
    const items = pending.pop();
    if (items.length < 2) { ordered.push(...items); continue; }
    let groups = null;
    for (const axis of [0, 1]) {
      const sorted = [...items].sort((a, b) => a.box[axis] - b.box[axis]);
      let edge = sorted[0].box[axis + 2];
      for (let index = 1; index < sorted.length; index++) {
        const gap = sorted[index].box[axis] - edge;
        if (gap > (axis === 0 ? 24 : 3)) {
          groups = [sorted.slice(0, index), sorted.slice(index)];
          if (axis === 0 && items.filter(item => item.line?.rtl).length > items.filter(item => item.line && !item.line.rtl).length) groups.reverse();
          break;
        }
        edge = Math.max(edge, sorted[index].box[axis + 2]);
      }
      if (groups) break;
    }
    if (groups) pending.push(groups[1], groups[0]);
    else ordered.push(...items.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]));
  }
  return { blocks: ordered, rejectedTables: tables.length - safeTables.length };
}

module.exports = { dataBlocks, lineText, isRtl, hasDigits, digitInventory };
