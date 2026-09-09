import assert from 'node:assert/strict';
import { compareCells } from '../webapps/better-notebooks/recovery-drafts.js';
import { pythonExport } from '../webapps/better-notebooks/modules/notebook-export.js';

assert.deepEqual(compareCells([{ type: 'python', source: 'a = 1' }], [{ type: 'python', source: 'a = 1' }]), []);
assert.equal(compareCells([{ type: 'python', source: 'a = 1' }], [{ type: 'python', source: 'a = 2' }])[0].kind, 'changed');
const exportedPython = pythonExport([{ type: 'markdown', source: '# Intro\nA note' }, { type: 'python', source: 'print(1)' }]);
assert.match(exportedPython, /^# ---- Markdown cell ----\n# # Intro\n# A note/m);
assert.equal((exportedPython.match(/---- Markdown cell ----/g) || []).length, 1);
assert.match(exportedPython, /# ---- Code cell ----/);
console.log('Recovery and export unit checks passed.');
