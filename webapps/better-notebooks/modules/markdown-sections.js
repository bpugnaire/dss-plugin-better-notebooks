export function headingForCell(cell) {
  if (cell?.type !== 'markdown') return null;
  const lines = String(cell.source || '').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = lines[lineIndex].match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (match) return { cellId: cell.id, level: match[1].length, title: match[2], lineIndex };
  }
  return null;
}

export function sectionModel(cells) {
  const headings = cells.map(headingForCell);
  const sections = new Map();
  headings.forEach((heading, index) => {
    if (!heading) return;
    let end = cells.length;
    for (let cursor = index + 1; cursor < cells.length; cursor += 1) {
      if (headings[cursor] && headings[cursor].level <= heading.level) { end = cursor; break; }
    }
    sections.set(heading.cellId, { ...heading, start: index, end, collapsedCount: Math.max(0, end - index - 1) });
  });

  const hidden = new Set();
  let collapsedLevel = 0;
  cells.forEach((cell, index) => {
    const heading = headings[index];
    if (collapsedLevel && heading && heading.level <= collapsedLevel) collapsedLevel = 0;
    if (collapsedLevel) { hidden.add(cell.id); return; }
    if (heading && cell.collapsed) collapsedLevel = heading.level;
  });
  return { headings: headings.filter(Boolean), sections, hidden };
}
