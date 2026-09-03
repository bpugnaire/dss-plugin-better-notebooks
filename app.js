const DATASETS = [
  { name: 'customers_enriched', kind: 'blue' },
  { name: 'orders_clean', kind: 'orange' },
  { name: 'web_sessions', kind: 'purple' },
  { name: 'product_catalog', kind: 'blue' },
  { name: 'support_tickets', kind: 'orange' },
];

const TABLE = {
  columns: [['customer_id', 'string'], ['country', 'string'], ['orders', 'int'], ['lifetime_value', 'decimal'], ['last_order', 'date']],
  rows: [
    ['CUS-10423', 'France', '12', '$1,849.50', '2026-08-29'],
    ['CUS-10781', 'United Kingdom', '9', '$1,224.00', '2026-08-27'],
    ['CUS-11056', 'Germany', '7', '$976.20', '2026-08-31'],
    ['CUS-11402', 'France', '6', '$845.90', '2026-08-30'],
    ['CUS-11987', 'Spain', '5', '$642.00', '2026-08-22'],
    ['CUS-12219', 'Italy', '4', '$515.75', '2026-08-28'],
  ]
};

const starterCells = [
  { id: crypto.randomUUID(), type: 'markdown', source: '# Customer behaviour exploration\nA quick investigation of customer purchase patterns, using project datasets.', meta: '' },
  { id: crypto.randomUUID(), type: 'python', source: 'import dataiku\nimport pandas as pd\n\ncustomers = dataiku.Dataset("customers_enriched").get_dataframe()\ncustomers.head()', meta: 'Ran just now · 0.41s', output: 'table' },
  { id: crypto.randomUUID(), type: 'sql', source: 'SELECT\n  country,\n  COUNT(*) AS customers,\n  ROUND(AVG(lifetime_value), 2) AS avg_ltv\nFROM customers_enriched\nGROUP BY 1\nORDER BY customers DESC', meta: 'Ran just now · 0.18s', output: 'query' },
  { id: crypto.randomUUID(), type: 'python', source: '# Try a quick check\ncustomers.isna().sum().sort_values(ascending=False).head(10)', meta: '' },
];

const state = { cells: loadCells(), selected: new Set(), clipboard: [], dragId: null, history: [], historyIndex: -1 };
const cellsEl = document.querySelector('#cells');
const template = document.querySelector('#cell-template');

function loadCells() {
  try { return JSON.parse(localStorage.getItem('better-notebooks-cells')) || starterCells; }
  catch { return starterCells; }
}
function save(recordHistory = true) {
  localStorage.setItem('better-notebooks-cells', JSON.stringify(state.cells));
  if (recordHistory) {
    const snapshot = JSON.stringify(state.cells);
    if (state.history[state.historyIndex] !== snapshot) {
      state.history.splice(state.historyIndex + 1);
      state.history.push(snapshot);
      state.historyIndex = state.history.length - 1;
    }
  }
  const status = document.querySelector('#saved-state');
  status.textContent = 'Saved locally';
  setTimeout(() => { status.textContent = 'Saved locally'; }, 400);
}
function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  state.cells = JSON.parse(state.history[state.historyIndex]);
  state.selected.clear();
  save(false); renderCells();
}
function escapeHTML(value) { return value.replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]); }
function cellIndex(id) { return state.cells.findIndex(cell => cell.id === id); }
function getCell(id) { return state.cells.find(cell => cell.id === id); }
function newCell(type = 'python') { return { id: crypto.randomUUID(), type, source: type === 'markdown' ? '## New section' : type === 'sql' ? 'SELECT *\nFROM customers_enriched\nLIMIT 100' : '# Start writing Python', meta: '' }; }

function renderDatasets(filter = '') {
  const query = filter.toLowerCase();
  document.querySelector('#dataset-list').innerHTML = DATASETS.filter(dataset => dataset.name.includes(query)).map(dataset => `<button class="dataset" data-dataset="${dataset.name}"><i class="${dataset.kind}"></i><span>${dataset.name}</span></button>`).join('');
}
function outputMarkup(kind) {
  if (kind === 'query') return `<div class="query-output success">Query completed · 5 rows returned</div>`;
  if (kind === 'table') return `<div class="output-header"><strong>customers</strong><span>6 rows × 5 columns</span><div class="output-controls"><button>⌕ Search</button><button>⇅ Sort</button><button>▤ Explore</button></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th></th>${TABLE.columns.map(([name, type]) => `<th>${name}<span>${type}</span></th>`).join('')}</tr></thead><tbody>${TABLE.rows.map((row, index) => `<tr><td class="row-num">${index + 1}</td>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return '';
}
function markdownMarkup(source) {
  return escapeHTML(source).split('\n').map(line => {
    if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
    if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
    if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
    return line ? `<p>${line}</p>` : '';
  }).join('');
}
function autoHeight(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.max(60, textarea.scrollHeight)}px`; }
function renderCells() {
  const scrollY = window.scrollY;
  cellsEl.innerHTML = '';
  state.cells.forEach((data, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = data.id; node.dataset.type = data.type; node.draggable = true;
    if (state.selected.has(data.id)) node.classList.add('selected');
    const language = node.querySelector('.cell-language'); language.classList.add(data.type);
    const textarea = node.querySelector('.code-input'); textarea.value = data.source;
    textarea.placeholder = data.type === 'markdown' ? 'Write Markdown' : data.type === 'sql' ? 'Write SQL' : 'Write Python';
    node.querySelector('.cell-check').checked = state.selected.has(data.id);
    node.querySelector('.cell-output').innerHTML = data.type === 'markdown' ? `<div class="markdown-render">${markdownMarkup(data.source)}</div>` : outputMarkup(data.output);
    const meta = node.querySelector('.execution-meta'); meta.textContent = data.meta || ''; if (data.meta) meta.classList.add('success');
    node.querySelector('.cell-footer').hidden = !data.meta;
    node.querySelector('.more-cell').setAttribute('aria-label', `More actions for cell ${index + 1}`);
    cellsEl.appendChild(node); autoHeight(textarea);
    const gap = document.createElement('div'); gap.className = 'cell-insert-gap'; gap.innerHTML = `<div class="insert-menu"><button data-insert-after="${data.id}" data-insert-type="python">+&nbsp; Code Cell</button><button data-insert-after="${data.id}" data-insert-type="markdown">+&nbsp; Markdown Cell</button></div>`; cellsEl.appendChild(gap);
  });
  renderToolbar(); renderOutline();
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' }));
}
function renderToolbar() {
  const toolbar = document.querySelector('#batch-toolbar'); const count = state.selected.size;
  toolbar.classList.toggle('hidden', count === 0); document.querySelector('#selection-count').textContent = `${count} cell${count === 1 ? '' : 's'} selected`;
}
function renderOutline() {
  const list = document.querySelector('#outline-list');
  list.innerHTML = state.cells.map((cell, index) => `<button class="outline-item" data-outline-id="${cell.id}"><span>${cell.type === 'markdown' ? 'M' : cell.type === 'sql' ? 'S' : 'P'}${index + 1}</span>${escapeHTML(cell.source.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '') || 'Empty cell').slice(0, 27)}</button>`).join('');
}
function updateCell(id, patch) { Object.assign(getCell(id), patch); save(); renderOutline(); }
function insertAfter(id, cell = newCell()) { state.cells.splice(cellIndex(id) + 1, 0, cell); save(); renderCells(); focusCell(cell.id); }
function focusCell(id) { requestAnimationFrame(() => document.querySelector(`[data-id="${id}"] .code-input`)?.focus()); }
function runCell(id) { const cell = getCell(id); cell.meta = `Ran just now · ${cell.type === 'sql' ? '0.18' : '0.24'}s`; cell.output = cell.type === 'sql' ? 'query' : cell.type === 'markdown' ? '' : 'table'; save(); renderCells(); }
function selectCell(id, selected) { selected ? state.selected.add(id) : state.selected.delete(id); renderCells(); }
function duplicateSelected() { const selection = state.cells.filter(cell => state.selected.has(cell.id)); if (!selection.length) return; const last = Math.max(...selection.map(cell => cellIndex(cell.id))); const copies = selection.map(cell => ({ ...cell, id: crypto.randomUUID(), meta: '' })); state.cells.splice(last + 1, 0, ...copies); state.selected = new Set(copies.map(cell => cell.id)); save(); renderCells(); }
function copySelected(remove = false) { const selected = state.cells.filter(cell => state.selected.has(cell.id)); if (!selected.length) return; state.clipboard = selected.map(cell => ({ ...cell, id: crypto.randomUUID(), meta: '' })); if (remove) { state.cells = state.cells.filter(cell => !state.selected.has(cell.id)); state.selected.clear(); } save(); renderCells(); }
function pasteCells(afterId) { if (!state.clipboard.length) return; const cells = state.clipboard.map(cell => ({ ...cell, id: crypto.randomUUID(), meta: '' })); const index = afterId ? cellIndex(afterId) + 1 : state.cells.length; state.cells.splice(index, 0, ...cells); state.selected = new Set(cells.map(cell => cell.id)); save(); renderCells(); }
function deleteSelected() { if (!state.selected.size) return; state.cells = state.cells.filter(cell => !state.selected.has(cell.id)); state.selected.clear(); save(); renderCells(); }
function moveCell(dragId, targetId) { if (dragId === targetId) return; const from = cellIndex(dragId); const to = cellIndex(targetId); const [moved] = state.cells.splice(from, 1); state.cells.splice(from < to ? to - 1 : to, 0, moved); save(); renderCells(); }

cellsEl.addEventListener('input', event => {
  if (!event.target.matches('.code-input')) return;
  autoHeight(event.target); updateCell(event.target.closest('.cell').dataset.id, { source: event.target.value });
});
cellsEl.addEventListener('change', event => { if (event.target.matches('.cell-check')) selectCell(event.target.closest('.cell').dataset.id, event.target.checked); });
cellsEl.addEventListener('click', event => {
  const cell = event.target.closest('.cell'); if (!cell) return; const id = cell.dataset.id;
  if (event.target.closest('.run-cell')) runCell(id);
  if (event.target.closest('.delete-cell')) { state.selected = new Set([id]); deleteSelected(); }
  if (event.target.closest('.cell-type-selector')) { cell.querySelector('.cell-type').classList.toggle('open'); }
  const typeOption = event.target.closest('[data-cell-type]');
  if (typeOption) { const target = getCell(id); target.type = typeOption.dataset.cellType; target.output = ''; target.meta = ''; save(); renderCells(); }
  if (event.target.closest('.markdown-render')) { const renderer = event.target.closest('.markdown-render'); renderer.classList.add('editing'); cell.querySelector('.code-input').classList.add('editing'); cell.querySelector('.code-input').focus(); autoHeight(cell.querySelector('.code-input')); }
});
cellsEl.addEventListener('focusout', event => { if (event.target.matches('.code-input.editing')) { event.target.classList.remove('editing'); event.target.closest('.cell').querySelector('.markdown-render')?.classList.remove('editing'); } });
cellsEl.addEventListener('click', event => { const button = event.target.closest('[data-insert-after]'); if (button) insertAfter(button.dataset.insertAfter, newCell(button.dataset.insertType)); });
cellsEl.addEventListener('dragstart', event => { const cell = event.target.closest('.cell'); if (!cell || event.target.closest('textarea')) { event.preventDefault(); return; } state.dragId = cell.dataset.id; cell.classList.add('dragging'); });
cellsEl.addEventListener('dragover', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell && cell.dataset.id !== state.dragId) cell.classList.add('drop-target'); });
cellsEl.addEventListener('dragleave', event => event.target.closest('.cell')?.classList.remove('drop-target'));
cellsEl.addEventListener('drop', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell) moveCell(state.dragId, cell.dataset.id); });
cellsEl.addEventListener('dragend', () => { state.dragId = null; document.querySelectorAll('.cell').forEach(cell => cell.classList.remove('dragging', 'drop-target')); });

document.querySelector('#add-cell-row').addEventListener('click', () => { const cell = newCell(); state.cells.push(cell); save(); renderCells(); focusCell(cell.id); });
document.querySelector('#run-all').addEventListener('click', () => { state.cells.filter(cell => cell.type !== 'markdown').forEach(cell => { cell.meta = 'Ran just now · 0.20s'; cell.output = cell.type === 'sql' ? 'query' : 'table'; }); save(); renderCells(); });
document.querySelector('#dataset-search').addEventListener('input', event => renderDatasets(event.target.value));
document.querySelector('#dataset-list').addEventListener('click', event => { const dataset = event.target.closest('[data-dataset]'); if (!dataset) return; const cell = newCell('python'); cell.source = `import dataiku\n\n${dataset.dataset.dataset.replace(/\W/g, '_')} = dataiku.Dataset("${dataset.dataset.dataset}").get_dataframe()\n${dataset.dataset.dataset.replace(/\W/g, '_')}.head()`; state.cells.push(cell); save(); renderCells(); focusCell(cell.id); });
document.querySelector('#outline-toggle').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('outline-collapsed'));
document.querySelector('#outline-list').addEventListener('click', event => document.querySelector(`[data-id="${event.target.closest('[data-outline-id]')?.dataset.outlineId}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' }));
document.querySelector('#dismiss-notice').addEventListener('click', event => event.target.closest('.notice').remove());
document.querySelector('#batch-toolbar').addEventListener('click', event => { const action = event.target.dataset.batchAction; if (!action) return; if (action === 'run') state.selected.forEach(runCell); if (action === 'duplicate') duplicateSelected(); if (action === 'copy') copySelected(); if (action === 'cut') copySelected(true); if (action === 'delete') deleteSelected(); if (action === 'clear') { state.selected.clear(); renderCells(); } });
document.querySelector('.workspace').addEventListener('click', event => { if (!state.selected.size || event.target.closest('.cell, button, textarea, input, .batch-toolbar')) return; state.selected.clear(); renderCells(); });
const settingsModal = document.querySelector('#settings-modal');
const closeSettings = () => settingsModal.classList.add('hidden');
document.querySelector('#settings-button').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.querySelector('#close-settings').addEventListener('click', closeSettings);
document.querySelector('#done-settings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', event => { if (event.target === settingsModal) closeSettings(); });
document.addEventListener('keydown', event => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') { closeSettings(); return; }
  if (event.shiftKey && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); const cell = document.activeElement.closest?.('.cell'); if (cell) { runCell(cell.dataset.id); const next = cell.nextElementSibling?.nextElementSibling; next?.querySelector('.code-input, .markdown-render')?.focus(); } return; }
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
  if (mod && event.key === 'Enter') { event.preventDefault(); (state.selected.size ? [...state.selected] : [document.activeElement.closest?.('.cell')?.dataset.id]).filter(Boolean).forEach(runCell); }
  if (mod && event.key.toLowerCase() === 'c' && state.selected.size) { event.preventDefault(); copySelected(); }
  if (mod && event.key.toLowerCase() === 'x' && state.selected.size) { event.preventDefault(); copySelected(true); }
  if (mod && event.key.toLowerCase() === 'v' && state.clipboard.length && !document.activeElement.matches('.code-input')) { event.preventDefault(); pasteCells(); }
  if (event.key === 'Backspace' && state.selected.size && !document.activeElement.matches('.code-input')) { event.preventDefault(); deleteSelected(); }
});

save(); renderDatasets(); renderCells();
