import Plotly from 'plotly.js-dist-min';

import { TABLE_MIME, validTable, validSettings, initialSettings, compatibleSettings, valueText } from './result-model.js';
export { TABLE_MIME, validTable } from './result-model.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = value => structuredClone(value);
const numeric = column => ['integer', 'number', 'decimal'].includes(column.type);
const figureValue = value => value && typeof value === 'object' ? value.type === 'tuple' ? valueText(value) : value.value : value;

/** One model per notebook/cell/tabular ordinal; inline and expanded views share it. */
export class ResultExplorerUI {
  constructor({ query, save, exportBytes = 100 * 1024 ** 2 }) {
    Object.assign(this, { query, save, exportBytes });
    this.models = new Map(); this.notebooks = new WeakMap();
    document.addEventListener('click', e => this.click(e));
    document.addEventListener('change', e => this.change(e));
    document.addEventListener('input', e => this.input(e));
    document.addEventListener('keydown', e => this.keydown(e));
  }
  bind(notebook, cell, ordinal, table) {
    let notebookKey = this.notebooks.get(notebook);
    if (!notebookKey) { notebookKey = crypto.randomUUID(); this.notebooks.set(notebook, notebookKey); }
    const key = `${notebookKey}/${cell.id}/${ordinal}`;
    let m = this.models.get(key);
    if (!m || m.ownerCell !== cell || m.table.resultId !== table.resultId || m.table.generation !== table.generation) {
      if (m) { clearTimeout(m.timer); m.sequence++; }
      const saved = cell.dssCell?.metadata?.betterNotebooks?.resultExplorer?.results?.[ordinal];
      const usable = validSettings(saved);
      const settings = usable ? clone(saved) : initialSettings(table);
      m = { key, notebook, ownerCell: cell, cellId: cell.id, ordinal, table, settings, sequence: 0, offset: 0, previous: [], live: null,
        error: '', invalid: Boolean(saved && (!usable || !compatibleSettings(settings, table))), page: null, loading: false, exporting: false };
      this.models.set(key, m);
    }
    return `<section class="result-explorer" data-result-key="${esc(key)}">${this.content(m)}</section>`;
  }
  cell(m) { return m.notebook.cells.find(c => c.id === m.cellId); }
  remember(m) {
    const cell = this.cell(m); if (!cell) return;
    cell.dssCell ||= {};
    cell.dssCell.metadata ||= {};
    cell.dssCell.metadata.betterNotebooks ||= {};
    const metadata = cell.dssCell.metadata.betterNotebooks;
    metadata.resultExplorer ||= { version: 1, results: {} };
    metadata.resultExplorer.results[m.ordinal] = clone(m.settings);
    this.save(m.notebook);
  }
  sections(m) { return [...document.querySelectorAll('.result-explorer')].filter(el => el.dataset.resultKey === m.key); }
  replace(m) {
    for (const el of this.sections(m)) {
      el.querySelectorAll('.result-plot').forEach(plot => Plotly.purge(plot));
      el.innerHTML = this.content(m);
    }
    this.hydratePlots(m);
  }
  hydrate(root) {
    root.querySelectorAll('.result-explorer').forEach(el => {
      const m = this.models.get(el.dataset.resultKey); if (!m) return;
      this.hydratePlots(m);
      if (m.live !== false && !m.loading && !m.invalid) this.load(m);
    });
  }
  dispose(root) { root.querySelectorAll('.result-plot').forEach(plot => Plotly.purge(plot)); }
  content(m) {
    const t = m.table, s = m.settings;
    const historical = m.live === false || !t.available;
    const status = historical ? 'Historical preview — reexecute for the complete result' : m.live ? 'Complete snapshot in kernel' : 'Saved preview — checking snapshot…';
    const notice = m.invalid ? 'The result schema changed. Reset the explorer settings to select valid columns.' : m.error || t.reason || '';
    return `<header class="result-header"><strong>DataFrame</strong><span>${t.totalRows.toLocaleString()} rows × ${t.columns.length} columns</span><span class="result-scope">${esc(status)}</span><button data-result-action="expand">Expand</button>${m.notebook.remote ? `<button data-create-dataset-from-cell="${esc(m.cellId)}">Create dataset</button>` : ''}<button data-result-action="reset">Reset</button>${historical && t.available ? '<button data-result-action="check-snapshot">Check snapshot</button>' : ''}</header>
      ${notice ? `<p class="result-notice" role="status">${esc(notice)}</p>` : ''}
      <nav class="result-tabs" aria-label="Result views" role="tablist">${['table', 'chart', 'profile'].map(tab => `<button role="tab" aria-selected="${s.tab === tab}" data-result-tab="${tab}">${{ table: 'Table', chart: 'Graphique', profile: 'Profil' }[tab]}</button>`).join('')}</nav>
      <div class="result-progress" role="status">${m.loading ? 'Computing on the complete filtered result…' : m.exporting ? esc(m.exportProgress || 'Exporting…') : ''}</div>
      ${s.tab === 'chart' ? this.chartMarkup(m) : s.tab === 'profile' ? this.profileMarkup(m) : this.tableMarkup(m)}`;
  }
  options(columns, selected, empty = false) {
    return `${empty ? '<option value="">None</option>' : ''}${columns.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.label)} (${esc(c.type)})</option>`).join('')}`;
  }
  tableMarkup(m) {
    const s = m.settings, t = m.table;
    const columns = t.columns.filter(c => !s.hidden.includes(c.id));
    const page = m.page || { ...t.preview, offset: 0, filteredRows: t.totalRows, totalRows: t.totalRows, nextOffset: t.preview.rows.length };
    const rows = page.rows;
    const controls = `<div class="result-toolbar"><details><summary>Columns</summary><div class="result-column-picker">${t.columns.map(c => `<label><input type="checkbox" data-result-column="${esc(c.id)}" ${s.hidden.includes(c.id) ? '' : 'checked'} />${esc(c.label)}</label>`).join('')}</div></details>
      <span>Click headers to sort; Shift-click adds a sort</span><label>CSV columns <select data-result-export-scope><option value="visible">Visible</option><option value="all">All</option></select></label><button data-result-action="export" ${m.exporting || m.live === false || !t.available || m.invalid ? 'disabled' : ''}>Export CSV</button>${m.exporting ? '<button data-result-action="cancel-export">Cancel export</button>' : ''}</div>`;
    return `${controls}<div class="result-table-wrap" tabindex="0" aria-label="Result grid: arrows move between cells"><table class="result-grid"><thead><tr><th scope="col">Index</th>${columns.map(c => {
      const sort = s.sorts.findIndex(v => v.column === c.id);
      return `<th scope="col" aria-sort="${sort < 0 ? 'none' : s.sorts[sort].direction === 'asc' ? 'ascending' : 'descending'}"><button data-result-sort="${esc(c.id)}">${esc(c.label)} ${sort < 0 ? '' : `${s.sorts[sort].direction === 'asc' ? '↑' : '↓'}${sort + 1}`}</button><small>${esc(c.pandasType)} · ${esc(c.type)}</small></th>`;
    }).join('')}</tr><tr class="result-filters"><th></th>${columns.map(c => {
      const f = s.filters.find(v => v.column === c.id) || {};
      const operators = [['', 'No filter'], ...(numeric(c) || c.type === 'datetime' ? [['eq', '='], ['ne', '≠'], ['gt', '>'], ['ge', '≥'], ['lt', '<'], ['le', '≤'], ['between', 'Between']] : c.type === 'boolean' ? [['eq', '=']] : [['contains', 'Contains'], ['eq', '='], ['ne', '≠']]), ['isNull', 'Is NULL'], ['notNull', 'Not NULL']];
      return `<th data-filter-column="${esc(c.id)}"><select data-filter-op aria-label="Filter operator ${esc(c.label)}">${operators.map(([v, label]) => `<option value="${v}" ${v === (f.op || '') ? 'selected' : ''}>${label}</option>`).join('')}</select><input data-filter-value aria-label="Filter value ${esc(c.label)}" value="${esc(f.value || '')}" placeholder="${c.type === 'boolean' ? 'true / false' : 'Value'}" ${!f.op || ['isNull', 'notNull'].includes(f.op) ? 'disabled' : ''} />${f.op === 'between' ? `<input data-filter-upper aria-label="Upper bound ${esc(c.label)}" value="${esc(f.upper || '')}" placeholder="Upper bound" />` : ''}</th>`;
    }).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr><th scope="row">${esc(valueText(page.index?.[index] ?? (page.offset + index)))}</th>${columns.map(c => {
      const value = row[t.columns.findIndex(v => v.id === c.id)];
      return `<td tabindex="-1" ${value === null ? 'class="result-null"' : ''}>${esc(valueText(value))}</td>`;
    }).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length + 1}">No rows</td></tr>`}</tbody></table></div>
      <footer class="result-pagination"><span>${rows.length ? page.offset + 1 : 0}–${page.offset + rows.length} / ${page.filteredRows.toLocaleString()} filtered · ${t.totalRows.toLocaleString()} total${!m.page && t.preview.truncated ? ' · truncated saved preview' : ''}</span><button data-result-action="prev" ${!m.previous.length || m.live !== true ? 'disabled' : ''}>Previous</button><button data-result-action="next" ${page.nextOffset >= page.filteredRows || m.live !== true ? 'disabled' : ''}>Next</button><label>Rows <select data-result-page-size>${[50, 100, 500].map(n => `<option ${s.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label></footer>`;
  }
  chartMarkup(m) {
    const c = m.settings.chart || {}, columns = m.table.columns;
    const field = (name, label, choices, empty = false) => `<label>${label}<select data-chart-field="${name}">${this.options(choices, c[name], empty)}</select></label>`;
    return `<div class="result-chart-editor"><label>Type<select data-chart-field="kind">${['bar', 'line', 'scatter', 'histogram'].map(v => `<option value="${v}" ${c.kind === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${field('x', 'X', columns)}${field('y', 'Y', columns.filter(numeric), true)}${field('series', 'Series', columns, true)}
      <label>Aggregation<select data-chart-field="aggregate">${['count', 'sum', 'mean', 'min', 'max'].map(v => `<option ${c.aggregate === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>Title<input data-chart-field="title" value="${esc(c.title)}" /></label><button data-result-action="apply-chart" ${m.live === false || !m.table.available || m.invalid ? 'disabled' : ''}>Apply</button></div>
      <p class="result-scope">All filtered rows${m.settings.chartResult ? ` · ${m.settings.chartResult.rows.toLocaleString()} rows${m.settings.chartResult.sampled ? ` · deterministic sample: ${m.settings.chartResult.points} points` : ''}` : ''}. Histogram uses X; scatter uses X and Y without aggregation.</p>
      ${m.settings.chartResult && m.settings.chartSource !== `${m.table.generation}/${m.table.resultId}` ? '<p class="result-scope">Saved chart from an earlier result; apply to recompute.</p>' : ''}${m.settings.chartResult ? '<div class="result-plot" aria-label="Result chart"></div>' : '<p>Select axes and apply the chart settings.</p>'}`;
  }
  distributionMarkup(distribution) {
    if (!distribution) return '';
    const counts = distribution.counts || [], max = Math.max(1, ...counts);
    const labels = distribution.values || (distribution.edges || []).slice(0, -1).map((edge, i) => `${valueText(edge)} – ${valueText(distribution.edges[i + 1])}`);
    return `<div class="result-distribution">${counts.map((n, i) => `<div><span title="${esc(valueText(labels[i]))}">${esc(valueText(labels[i]))}</span><meter min="0" max="${max}" value="${n}"></meter><span>${n}</span></div>`).join('')}${distribution.other ? `<p>Other: ${distribution.other}</p>` : ''}</div>`;
  }
  profileMarkup(m) {
    const result = m.settings.profileResult;
    return `<p class="result-scope">Profile of all filtered rows${result ? ` · ${result.rows.toLocaleString()} rows` : ''}${result?.truncated ? ' · saved summary truncated by transfer budget' : ''}</p><button data-result-action="refresh-profile" ${m.live === false || !m.table.available || m.invalid ? 'disabled' : ''}>Refresh profile</button>
      ${result && m.settings.profileSource !== `${m.table.generation}/${m.table.resultId}` ? '<p class="result-scope">Saved profile from an earlier result; refresh to recompute.</p>' : ''}${result ? `<div class="result-profile">${result.columns.map(p => {
        const column = m.table.columns.find(c => c.id === p.id);
        return `<article><h4>${esc(column?.label || p.id)} <small>${esc(column?.type)}</small></h4><p>Missing: ${p.missing.toLocaleString()} (${p.missingPercent.toFixed(2)}%) · Cardinality: ${p.cardinality ?? 'unavailable'}</p>${!p.supported ? '<p>Mixed or unsupported objects: statistics unavailable.</p>' : `${p.statistics ? `<dl>${Object.entries(p.statistics).map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(valueText(value))}</dd></div>`).join('')}</dl>` : ''}${this.distributionMarkup(p.distribution)}`}</article>`;
      }).join('')}</div>` : '<p>Open this view with an available snapshot to compute the profile.</p>'}`;
  }
  hydratePlots(m) {
    const figure = m.settings.chartResult; if (!figure || m.settings.tab !== 'chart') return;
    const data = figure.data.map(trace => ({ ...trace, x: trace.x.map(figureValue), y: trace.y.map(figureValue) }));
    for (const el of this.sections(m)) {
      const plot = el.querySelector('.result-plot');
      if (plot && !plot.dataset.hydrated) {
        plot.dataset.hydrated = 'true';
        Plotly.newPlot(plot, data, { title: { text: m.settings.chart?.title || '' }, autosize: true, margin: { t: 45, b: 65, l: 65, r: 25 } }, { responsive: true, displaylogo: false }).catch(error => { plot.textContent = error.message; });
      }
    }
  }
  async request(m, op, extra = {}) {
    const response = await this.query(m.notebook, { op, resultId: m.table.resultId, generation: m.table.generation, filters: m.settings.filters, sorts: m.settings.sorts, ...extra });
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'Explorer unavailable. Reexecute the cell.'), { code: response?.code });
    return response.result;
  }
  async load(m, force = false) {
    if (!this.cell(m) || m.loading || m.invalid || !m.table.available || m.live === false) return;
    const tab = m.settings.tab;
    const source = `${m.table.generation}/${m.table.resultId}`;
    if (!force && m.live && (tab === 'table' ? m.page : tab === 'chart' ? m.settings.chartResult && m.settings.chartSource === source : m.settings.profileResult && m.settings.profileSource === source)) return;
    const sequence = m.sequence;
    m.loading = true; this.replace(m);
    try {
      if (m.live === null) await this.request(m, 'describe');
      if (sequence !== m.sequence || !this.cell(m)) return;
      m.live = true;
      if (tab === 'table') {
        const page = await this.request(m, 'page', { offset: m.offset, limit: m.settings.pageSize });
        if (sequence === m.sequence && this.cell(m)) m.page = page;
      }
      else if (tab === 'chart') {
        const figure = await this.request(m, 'chart', { chart: clone(m.settings.chart) });
        if (sequence === m.sequence && this.cell(m)) { m.settings.chartResult = figure; m.settings.chartSource = source; this.remember(m); }
      } else {
        const profile = await this.request(m, 'profile');
        if (sequence === m.sequence && this.cell(m)) { m.settings.profileResult = profile; m.settings.profileSource = source; this.remember(m); }
      }
      if (sequence !== m.sequence || !this.cell(m)) return;
      m.error = '';
    } catch (error) {
      if (sequence !== m.sequence) return;
      m.error = error.message;
      if (['EXPIRED', 'UNAVAILABLE', 'RESULT_UNCONFIRMED'].includes(error.code)) { m.live = false; m.page = null; }
    } finally {
      if (sequence === m.sequence) { m.loading = false; this.replace(m); }
    }
  }
  changed(m, { data = false, render = true } = {}) {
    m.sequence++; m.loading = false; m.error = '';
    if (data) { m.page = null; m.offset = 0; m.previous = []; delete m.settings.chartResult; delete m.settings.profileResult; }
    this.remember(m);
    if (render) this.replace(m);
  }
  model(event) { return this.models.get(event.target.closest('.result-explorer')?.dataset.resultKey); }
  click(event) {
    const m = this.model(event); if (!m) return;
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.resultTab) {
      m.settings.tab = button.dataset.resultTab; this.changed(m); this.load(m); return;
    }
    if (button.dataset.resultSort) {
      const id = button.dataset.resultSort, previous = m.settings.sorts.find(s => s.column === id);
      const next = { column: id, direction: previous?.direction === 'asc' ? 'desc' : 'asc' };
      m.settings.sorts = event.shiftKey ? previous ? m.settings.sorts.map(s => s.column === id ? next : s) : [...m.settings.sorts, next] : [next];
      this.changed(m, { data: true }); this.load(m); return;
    }
    switch (button.dataset.resultAction) {
      case 'check-snapshot': m.live = null; this.changed(m); this.load(m, true); break;
      case 'reset': m.settings = initialSettings(m.table); m.invalid = false; this.changed(m, { data: true }); this.load(m); break;
      case 'next': m.previous.push(m.offset); m.offset = m.page.nextOffset; m.sequence++; m.page = null; m.loading = false; this.load(m); break;
      case 'prev': m.offset = m.previous.pop() || 0; m.sequence++; m.page = null; m.loading = false; this.load(m); break;
      case 'apply-chart': delete m.settings.chartResult; this.changed(m); this.load(m, true); break;
      case 'refresh-profile': delete m.settings.profileResult; this.changed(m); this.load(m, true); break;
      case 'expand': {
        const content = document.querySelector('#dataframe-modal-content');
        if (!content) break;
        this.dispose(content); content.innerHTML = `<section class="result-explorer" data-result-key="${esc(m.key)}">${this.content(m)}</section>`;
        document.querySelector('#dataframe-modal').classList.remove('hidden'); this.hydratePlots(m); break;
      }
      case 'export': this.export(m, event.target.closest('.result-explorer').querySelector('[data-result-export-scope]').value); break;
      case 'cancel-export': m.exportCancelled = true; break;
    }
  }
  updateFilter(m, target) {
    const field = target.closest('[data-filter-column]'); if (!field) return false;
    const column = field.dataset.filterColumn, op = field.querySelector('[data-filter-op]').value;
    const value = field.querySelector('[data-filter-value]').value, upper = field.querySelector('[data-filter-upper]')?.value || '';
    m.settings.filters = m.settings.filters.filter(f => f.column !== column);
    if (op) m.settings.filters.push({ column, op, value, upper });
    this.changed(m, { data: true, render: false });
    clearTimeout(m.timer);
    m.timer = setTimeout(() => { this.replace(m); this.load(m); }, 350);
    return true;
  }
  change(event) {
    const m = this.model(event); if (!m) return;
    const target = event.target;
    if (target.hasAttribute('data-filter-op')) { this.updateFilter(m, target); this.replace(m); return; }
    if (target.hasAttribute('data-result-column')) {
      m.settings.hidden = m.settings.hidden.filter(id => id !== target.dataset.resultColumn);
      if (!target.checked) m.settings.hidden.push(target.dataset.resultColumn);
      this.changed(m); return;
    }
    if (target.hasAttribute('data-result-page-size')) {
      m.settings.pageSize = Number(target.value); this.changed(m, { data: true }); this.load(m); return;
    }
    if (target.dataset.chartField) {
      m.settings.chart[target.dataset.chartField] = target.value;
      delete m.settings.chartResult; this.changed(m);
    }
  }
  input(event) {
    const m = this.model(event); if (!m) return;
    if (event.target.matches('[data-filter-value], [data-filter-upper]')) this.updateFilter(m, event.target);
    if (event.target.dataset.chartField === 'title') {
      m.settings.chart.title = event.target.value; this.remember(m);
    }
  }
  keydown(event) {
    const target = event.target;
    if (!target.matches('.result-table-wrap, .result-grid td')) return;
    const deltas = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    const delta = deltas[event.key]; if (!delta) return;
    const wrap = target.closest('.result-table-wrap'), rows = [...wrap.querySelectorAll('tbody tr')];
    const row = target.closest('tr'); const ri = row ? rows.indexOf(row) : 0;
    const cells = row ? [...row.querySelectorAll('td')] : [];
    const ci = Math.max(0, cells.indexOf(target));
    const nextRow = rows[Math.max(0, Math.min(rows.length - 1, ri + (row ? delta[0] : 0)))];
    const nextCells = [...(nextRow?.querySelectorAll('td') || [])];
    nextCells[Math.max(0, Math.min(nextCells.length - 1, ci + (row ? delta[1] : 0)))]?.focus();
    event.preventDefault(); event.stopPropagation();
  }
  async export(m, scope) {
    if (m.exporting) return;
    m.exporting = true; m.exportCancelled = false; m.exportProgress = 'Preparing CSV…'; this.replace(m);
    const sequence = m.sequence;
    let token;
    try {
      const columns = m.table.columns.filter(c => scope === 'all' || !m.settings.hidden.includes(c.id)).map(c => c.id);
      const start = await this.request(m, 'exportStart', { columns }); token = start.token;
      const chunks = []; let bytes = 0, done = false;
      while (!done) {
        if (m.exportCancelled || sequence !== m.sequence || !this.cell(m)) throw new Error('Export cancelled; no file was downloaded.');
        const chunk = await this.request(m, 'exportChunk', { token });
        const blob = new Blob([chunk.text], { type: 'text/csv;charset=utf-8' });
        bytes += blob.size;
        if (bytes > this.exportBytes) throw new Error('CSV exceeds the browser export budget. Add a filter or increase the configured limit. No partial file was downloaded.');
        chunks.push(blob); done = chunk.done;
        m.exportProgress = `Exporting ${chunk.rows.toLocaleString()} / ${chunk.total.toLocaleString()} rows`; this.replace(m);
      }
      if (m.exportCancelled || sequence !== m.sequence || !this.cell(m)) throw new Error('Export cancelled; no file was downloaded.');
      const url = URL.createObjectURL(new Blob(chunks, { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${m.notebook.name.replace(/[^\w.-]+/g, '_')}-result-${m.ordinal + 1}.csv`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0); m.error = '';
    } catch (error) { m.error = error.message; }
    finally {
      if (token) await this.request(m, 'exportClose', { token }).catch(() => {});
      m.exporting = false; m.exportProgress = ''; this.replace(m);
    }
  }
  forgetNotebook(notebook) {
    for (const [key, m] of this.models) if (m.notebook === notebook) {
      clearTimeout(m.timer); m.sequence++; m.exportCancelled = true; this.models.delete(key);
    }
  }
  invalidateNotebook(notebook) {
    for (const m of this.models.values()) if (m.notebook === notebook) {
      clearTimeout(m.timer); m.sequence++; m.loading = false; m.exportCancelled = true;
      m.live = false; m.page = null; m.error = 'Kernel restarted. Reexecute the cell to explore the complete result.';
      this.replace(m);
    }
  }
  reconcile(notebook, cell, outputs) {
    const next = new Set(outputs.map(o => o.data?.[TABLE_MIME]?.resultId).filter(Boolean));
    for (const output of cell.dssCell?.outputs || []) {
      const table = output.data?.[TABLE_MIME];
      if (table?.resultId && !next.has(table.resultId)) {
        this.releaseTable(notebook, cell.id, table);
        for (const [key, m] of this.models) if (m.notebook === notebook && m.cellId === cell.id && m.table.resultId === table.resultId) {
          clearTimeout(m.timer); m.sequence++; m.exportCancelled = true; this.models.delete(key);
        }
      }
    }
  }
  releaseTable(notebook, cellId, table, removing = [cellId]) {
    const referenced = notebook.cells.some(cell => !removing.includes(cell.id) && (cell.dssCell?.outputs || cell.output?.outputs || []).some(output => {
      const other = output.data?.[TABLE_MIME];
      return other?.resultId === table.resultId && other?.generation === table.generation;
    }));
    if (!referenced) this.query(notebook, { op: 'release', resultId: table.resultId, generation: table.generation }).catch(() => {});
  }
  releaseCell(notebook, cell, removing = [cell.id]) {
    for (const [key, m] of this.models) if (m.notebook === notebook && m.cellId === cell.id) {
      clearTimeout(m.timer); m.sequence++; m.exportCancelled = true;
      this.models.delete(key);
    }
    const tables = (cell.dssCell?.outputs || cell.output?.outputs || []).map(o => o.data?.[TABLE_MIME]).filter(t => t?.resultId);
    for (const table of tables) this.releaseTable(notebook, cell.id, table, removing);
  }
}
