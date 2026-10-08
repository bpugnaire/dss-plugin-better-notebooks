import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialSettings, compatibleSettings, validTable, valueText } from '../webapps/better-notebooks/modules/result-model.js';
import { serializeNotebook } from '../webapps/better-notebooks/modules/notebook-document.js';
import { compareCells } from '../webapps/better-notebooks/recovery-drafts.js';
const table = { version: 1, totalRows: 1000, columns: [{ id: 'c0', label: 'country', type: 'string' }, { id: 'c1', label: 'n', type: 'integer' }], preview: { rows: [] } };
test('versioned contract and exact scalar rendering', () => {
  assert(validTable(table)); assert(!validTable({ ...table, version: 2 }));
  assert.equal(valueText(null), 'NULL'); assert.equal(valueText(''), '');
  assert.equal(valueText({ type: 'integer', value: '1152921504606846977' }), '1152921504606846977');
});
test('schema changes never silently rebind referenced columns', () => {
  const settings = initialSettings(table);
  assert(compatibleSettings(settings, table));
  assert(!compatibleSettings(settings, { ...table, columns: table.columns.toReversed() .map((c, i) => ({ ...c, id: `c${i}` })) }));
  assert(!compatibleSettings(settings, { ...table, columns: [table.columns[0]] }));
  assert(!compatibleSettings({ ...settings, version: 2 }, table));
});
test('settings survive serialization, unknown metadata and recovery comparisons', () => {
  const settings = { version: 1, results: { 0: initialSettings(table) } };
  const cell = { id: 'c', type: 'python', source: 'df', execution: { status: 'succeeded' }, dssCell: { metadata: { custom: 'kept', betterNotebooks: { resultExplorer: settings } }, outputs: [{ output_type: 'display_data', data: { 'application/vnd.better-notebooks.table.v1+json': table } }] } };
  const result = serializeNotebook({ cells: [cell] }, null, c => c.execution);
  assert.deepEqual(result.cells[0].metadata.betterNotebooks.resultExplorer, settings);
  assert.equal(result.cells[0].metadata.custom, 'kept');
  const updated = structuredClone(cell); updated.dssCell.metadata.betterNotebooks.resultExplorer.results[0].tab = 'chart';
  assert(compareCells([updated], [cell])[0].differences.includes('result explorer settings'));
});
