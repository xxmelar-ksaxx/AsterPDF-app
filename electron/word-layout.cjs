// Coordinates are PDF points in the displayed page's top-left coordinate system.
const close = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;
function unique(values) {
  return values.sort((a, b) => a - b).reduce((out, value) => {
    if (!out.length || !close(out[out.length - 1], value)) out.push(value);
    return out;
  }, []);
}
const intersects = (a, b) => a[0] <= b[2] + 2 && a[2] >= b[0] - 2 && a[1] <= b[3] + 2 && a[3] >= b[1] - 2;
const contains = (box, run) => {
  const x = (run.box[0] + run.box[2]) / 2, y = (run.box[1] + run.box[3]) / 2;
  return x >= box[0] - 1 && x <= box[2] + 1 && y >= box[1] - 1 && y <= box[3] + 1;
};

function textLines(runs, splitColumns = false) {
  const lines = [];
  for (const run of [...runs].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
    const center = (run.box[1] + run.box[3]) / 2;
    let line = lines.find(item => close(item.center, center, Math.max(2, Math.min(item.height, run.box[3] - run.box[1]) * .35)));
    if (!line) {
      line = { center, height: run.box[3] - run.box[1], runs: [] };
      lines.push(line);
    }
    line.runs.push(run);
  }
  return lines.flatMap(line => {
    const groups = [[]];
    for (const run of line.runs.sort((a, b) => a.box[0] - b.box[0])) {
      const previous = groups.at(-1).at(-1);
      if (splitColumns && previous && run.box[0] - previous.box[2] > Math.max(24, 2.5 * Math.max(previous.size, run.size))) groups.push([]);
      groups.at(-1).push(run);
    }
    return groups.map(group => {
      const rtl = group.reduce((count, run) => count + (run.text.match(/[\u0590-\u08ff]/g)?.length || 0), 0) >
        group.reduce((count, run) => count + (run.text.match(/[a-z]/gi)?.length || 0), 0);
      const sorted = group.sort((a, b) => rtl ? b.box[0] - a.box[0] : a.box[0] - b.box[0]);
      return { runs: sorted, rtl, box: [Math.min(...sorted.map(run => run.box[0])), Math.min(...sorted.map(run => run.box[1])),
        Math.max(...sorted.map(run => run.box[2])), Math.max(...sorted.map(run => run.box[3]))] };
    });
  });
}

function detectTables(segments, runs) {
  // Join touching horizontal/vertical rules, then reconstruct cells from the
  // actual separators. Missing separators produce merged Word cells.
  const groups = [];
  for (const segment of segments) {
    const matches = groups.filter(group => group.some(item => intersects(item, segment)));
    if (!matches.length) groups.push([segment]);
    else {
      const combined = [segment, ...matches.flat()];
      for (const match of matches) groups.splice(groups.indexOf(match), 1);
      groups.push(combined);
    }
  }
  const tables = [];
  for (const group of groups) {
    const verticals = group.filter(line => close(line[0], line[2], .8) && line[3] - line[1] > 5);
    const horizontals = group.filter(line => close(line[1], line[3], .8) && line[2] - line[0] > 5);
    const xs = unique(verticals.map(line => line[0])), ys = unique(horizontals.map(line => line[1]));
    if (xs.length < 3 || ys.length < 3 || xs.length > 64 || ys.length > 300) continue;
    const box = [xs[0], ys[0], xs.at(-1), ys.at(-1)];
    const members = runs.filter(run => contains(box, run));
    if (!members.length) continue;
    const cols = xs.length - 1, rows = ys.length - 1;
    const parent = Array.from({ length: cols * rows }, (_, index) => index);
    const root = index => parent[index] === index ? index : (parent[index] = root(parent[index]));
    const join = (a, b) => { parent[root(a)] = root(b); };
    const covers = (lines, axis, at, start, end) => {
      const spans = lines.filter(line => close(line[axis], at)).map(line => axis === 0 ? [line[1], line[3]] : [line[0], line[2]]).sort((a, b) => a[0] - b[0]);
      let reached = start;
      for (const [a, b] of spans) { if (a > reached + 2) break; reached = Math.max(reached, b); }
      return reached >= end - 2;
    };
    if (!covers(verticals, 0, xs[0], ys[0], ys.at(-1)) || !covers(verticals, 0, xs.at(-1), ys[0], ys.at(-1)) ||
      !covers(horizontals, 1, ys[0], xs[0], xs.at(-1)) || !covers(horizontals, 1, ys.at(-1), xs[0], xs.at(-1))) continue;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      if (col + 1 < cols && !covers(verticals, 0, xs[col + 1], ys[row], ys[row + 1])) join(row * cols + col, row * cols + col + 1);
      if (row + 1 < rows && !covers(horizontals, 1, ys[row + 1], xs[col], xs[col + 1])) join(row * cols + col, (row + 1) * cols + col);
    }
    const cells = new Map();
    parent.forEach((_, index) => {
      const key = root(index);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push([Math.floor(index / cols), index % cols]);
    });
    const grid = [...cells.values()].map(indices => {
      const r0 = Math.min(...indices.map(item => item[0])), r1 = Math.max(...indices.map(item => item[0])) + 1;
      const c0 = Math.min(...indices.map(item => item[1])), c1 = Math.max(...indices.map(item => item[1])) + 1;
      return { r0, r1, c0, c1, count: indices.length, box: [xs[c0], ys[r0], xs[c1], ys[r1]] };
    });
    // A nonrectangular merged region is ambiguous: retain editable positioned
    // text rather than assign words to the wrong table cell.
    if (grid.some(cell => cell.count !== (cell.r1 - cell.r0) * (cell.c1 - cell.c0))) continue;
    for (const cell of grid) cell.runs = members.filter(run => contains(cell.box, run));
    if (members.some(run => grid.filter(cell => cell.runs.includes(run)).length !== 1)) continue;
    tables.push({ box, xs, ys, cells: grid, runs: members, segments: group });
  }
  return tables;
}

module.exports = { textLines, detectTables };
