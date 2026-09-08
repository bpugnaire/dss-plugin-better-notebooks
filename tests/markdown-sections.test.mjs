import assert from 'node:assert/strict';
import { headingForCell, sectionModel } from '../webapps/better-notebooks/modules/markdown-sections.js';

const cells = [
  { id: 'intro', type: 'markdown', source: '# Introduction', collapsed: true },
  { id: 'code-a', type: 'python', source: 'a = 1' },
  { id: 'detail', type: 'markdown', source: '## Detail', collapsed: false },
  { id: 'code-b', type: 'python', source: 'b = 2' },
  { id: 'next', type: 'markdown', source: '# Next section', collapsed: false },
  { id: 'code-c', type: 'python', source: 'c = 3' },
];

assert.deepEqual(headingForCell(cells[0]), { cellId: 'intro', level: 1, title: 'Introduction', lineIndex: 0 });
const model = sectionModel(cells);
assert.equal(model.sections.get('intro').collapsedCount, 3);
assert.deepEqual([...model.hidden], ['code-a', 'detail', 'code-b']);
assert.equal(model.hidden.has('next'), false);

cells[0].collapsed = false;
cells[2].collapsed = true;
const nested = sectionModel(cells);
assert.equal(nested.sections.get('detail').collapsedCount, 1);
assert.deepEqual([...nested.hidden], ['code-b']);

console.log('Markdown section model checks passed.');
