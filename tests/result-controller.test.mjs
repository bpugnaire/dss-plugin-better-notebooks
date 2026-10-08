// Controller verification without a browser. Plotly is replaced at the import
// boundary; these tests exercise state/transport ownership, not its rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { ExecutionQueue } from '../webapps/better-notebooks/modules/execution-queue.js';
const bundled = await build({ entryPoints: ['webapps/better-notebooks/modules/result-explorer.js'], bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'plotly-test-boundary', setup(builder) {
    builder.onResolve({ filter: /^plotly.js-dist-min$/ }, () => ({ path: 'plotly', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default {purge(){},newPlot(){return Promise.resolve()}};' }));
  } }] });
const { ResultExplorerUI } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
globalThis.document = { addEventListener() {}, querySelectorAll() { return []; } };
const descriptor = (id = 'r') => ({ version: 1, resultId: id, generation: 'g', available: true, totalRows: 200,
  columns: [{ id: 'c0', label: 'n', type: 'integer' }], preview: { rows: [[0]], index: [0], truncated: true } });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const make = query => {
  const saved = [], ui = new ResultExplorerUI({ query, save: n => saved.push(n) });
  const notebook = { name: 'A', cells: [{ id: 'c' }] };
  ui.bind(notebook, notebook.cells[0], 0, descriptor());
  const model = [...ui.models.values()][0]; ui.replace = () => {};
  return { ui, model, notebook, saved };
};
test('a stale page cannot overwrite a newer filter result', async () => {
  const gate = deferred(); let calls = 0;
  const { ui, model } = make(async () => ++calls === 1 ? gate.promise : { ok: true, result: { rows: [[199]] } });
  model.live = true;
  const old = ui.load(model);
  model.settings.filters = [{ column: 'c0', op: 'ge', value: '199' }];
  ui.changed(model, { data: true });
  await ui.load(model);
  gate.resolve({ ok: true, result: { rows: [[1]] } }); await old;
  assert.deepEqual(model.page.rows, [[199]]);
});
test('chart/profile responses belong to their originating notebook and settings', async () => {
  const gate = deferred(); const { ui, model, notebook, saved } = make(() => gate.promise);
  model.live = true; model.settings.tab = 'chart';
  const old = ui.load(model);
  model.settings.chart.x = 'missing'; ui.changed(model);
  gate.resolve({ ok: true, result: { rows: 200, data: [] } }); await old;
  assert.equal(model.settings.chartResult, undefined);
  assert(saved.every(n => n === notebook));
});
test('metadata and transient models are isolated across notebooks and results', () => {
  const { ui, notebook } = make(async () => ({ ok: true }));
  const other = { name: 'B', cells: [{ id: 'c' }] };
  ui.bind(other, other.cells[0], 0, descriptor());
  ui.bind(notebook, notebook.cells[0], 1, descriptor('second'));
  const models = [...ui.models.values()]; assert.equal(new Set(models.map(m => m.key)).size, 3);
  models[0].settings.tab = 'profile'; ui.remember(models[0]);
  assert.equal(other.cells[0].dssCell, undefined);
  assert.equal(models[2].settings.tab, 'table');
});
test('expiry and restart preserve saved chart/profile but invalidate full pages', async () => {
  const { ui, model, notebook } = make(async () => ({ ok: false, code: 'EXPIRED', error: 'Expired' }));
  model.settings.chartResult = { rows: 200, data: [] }; model.live = true;
  await ui.load(model); assert.equal(model.live, false); assert.equal(model.page, null);
  ui.invalidateNotebook(notebook);
  assert.deepEqual(model.settings.chartResult, { rows: 200, data: [] });
});
test('export exceeding the budget closes the cursor without downloading a partial file', async () => {
  const ops = [];
  const { ui, model } = make(async (_, p) => {
    ops.push(p.op);
    return { ok: true, result: p.op === 'exportStart' ? { token: 'x' } : p.op === 'exportChunk' ? { text: 'larger than budget', done: true, rows: 200, total: 200 } : undefined };
  });
  ui.exportBytes = 1; await ui.export(model, 'all');
  assert.match(model.error, /No partial file/);
  assert.deepEqual(ops, ['exportStart', 'exportChunk', 'exportClose']);
});
test('result errors caught inside the queue leave user cell work runnable', async () => {
  const queue = new ExecutionQueue(), n = {}; const jobs = [];
  const query = queue.enqueue(n, async () => { try { throw new Error('expired'); } catch (error) { return { ok: false, error: error.message }; } });
  const cell = queue.enqueue(n, async () => { jobs.push('cell'); return true; });
  assert.equal((await query).ok, false); assert.equal(await cell, true); assert.deepEqual(jobs, ['cell']);
});

test('reexecution recalculates retained chart configuration against the new snapshot', async () => {
  const ops = [];
  const { ui, model } = make(async (_, payload) => {
    ops.push(payload.op);
    return { ok: true, result: { rows: 200, data: [] } };
  });
  model.live = true; model.settings.tab = 'chart';
  model.settings.chartResult = { rows: 99, data: [] }; model.settings.chartSource = 'g/old-result';
  await ui.load(model);
  assert.deepEqual(ops, ['chart']);
  assert.equal(model.settings.chartResult.rows, 200);
  assert.equal(model.settings.chartSource, 'g/r');
});

test('loading a remote/recovery cell replaces stale local explorer settings even with the same result ID', () => {
  const { ui, model, notebook } = make(async () => ({ ok: true }));
  model.settings.tab = 'profile'; ui.remember(model);
  const replacement = structuredClone(notebook.cells[0]);
  replacement.dssCell.metadata.betterNotebooks.resultExplorer.results[0].tab = 'table';
  notebook.cells = [replacement];
  ui.bind(notebook, replacement, 0, descriptor());
  assert.equal([...ui.models.values()][0].settings.tab, 'table');
});
