const webappConfig = typeof dataiku !== 'undefined' && typeof dataiku.getWebAppConfig === 'function'
  ? dataiku.getWebAppConfig() : {};
const storageNamespace = String(webappConfig.storage_namespace || 'better-notebooks').replace(/[^a-z0-9_-]/gi, '-');
const storageKey = suffix => `${storageNamespace}-${suffix}`;

let DATASETS = [
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

const state = { notebooks: loadNotebooks(), activeNotebookId: null, notebookListMode: 'all', cells: [], selected: new Set(), clipboard: [], dragId: null, activeCellId: null, history: [], historyIndex: -1 };
const cellsEl = document.querySelector('#cells');
const template = document.querySelector('#cell-template');

function loadCells() {
  try { return JSON.parse(localStorage.getItem(storageKey('cells'))) || starterCells; }
  catch { return starterCells; }
}
function cloneCells(cells) { return cells.map(cell => ({ ...cell, id: crypto.randomUUID() })); }
function loadNotebooks() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey('notebooks')));
    if (saved?.notebooks?.length) return { ...saved, folders: saved.folders ?? [], notebooks: saved.notebooks.map(notebook => ({ ...notebook, open: notebook.open ?? true, updatedAt: notebook.updatedAt ?? 0, folderId: notebook.folderId ?? null })) };
  } catch { /* Start from the browser-only prototype notebook. */ }
  return {
    activeNotebookId: 'customer-behaviour',
    folders: [],
    notebooks: [
      { id: 'customer-behaviour', name: 'Explore customer behaviour', language: 'PYTHON', cells: loadCells(), open: true, updatedAt: 3, folderId: null },
      { id: 'revenue-check', name: 'Revenue quality checks', language: 'SQL', cells: cloneCells(starterCells).slice(1, 3), open: true, updatedAt: 2, folderId: null },
      { id: 'retention-analysis', name: 'Retention analysis', language: 'PYTHON', cells: cloneCells(starterCells).slice(0, 2), open: true, updatedAt: 1, folderId: null },
    ]
  };
}
function activeNotebook() { return state.notebooks.notebooks.find(notebook => notebook.id === state.activeNotebookId); }
function resetHistory() { state.history = [JSON.stringify(state.cells)]; state.historyIndex = 0; }
function switchNotebook(id) {
  const notebook = state.notebooks.notebooks.find(item => item.id === id); if (!notebook || id === state.activeNotebookId) return;
  notebook.open = true; state.activeNotebookId = id; state.notebooks.activeNotebookId = id; state.cells = notebook.cells; state.selected.clear(); state.activeCellId = null; resetHistory(); persistNotebooks(); renderWorkspace(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function persistNotebooks() { localStorage.setItem(storageKey('notebooks'), JSON.stringify(state.notebooks)); }
function save(recordHistory = true) {
  activeNotebook().cells = state.cells; activeNotebook().updatedAt = Date.now(); state.notebooks.activeNotebookId = state.activeNotebookId; persistNotebooks();
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
function isDssWebappRuntime() { return typeof getWebAppBackendUrl === 'function'; }
async function loadProjectDatasets() {
  if (!isDssWebappRuntime()) return;
  try {
    const response = await fetch(getWebAppBackendUrl('project-context/datasets'));
    if (!response.ok) throw new Error(`Dataset endpoint returned ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.datasets)) throw new Error('Dataset response is invalid');
    DATASETS = payload.datasets.map((dataset, index) => ({
      name: dataset.name,
      kind: ['blue', 'orange', 'purple'][index % 3],
    }));
    renderDatasets(document.querySelector('#dataset-search').value);
  } catch (error) {
    console.warn('Better Notebooks could not load project datasets; using local examples.', error);
  }
}
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
    if (state.activeCellId === data.id) node.classList.add('active');
    const language = node.querySelector('.cell-language'); language.classList.add(data.type);
    const textarea = node.querySelector('.code-input'); textarea.value = data.source;
    textarea.placeholder = data.type === 'markdown' ? 'Write Markdown' : data.type === 'sql' ? 'Write SQL' : 'Write Python';
    node.querySelector('.cell-check').checked = state.selected.has(data.id);
    node.querySelector('.cell-output').innerHTML = data.type === 'markdown' ? `<div class="markdown-render" tabindex="0">${markdownMarkup(data.source)}</div>` : outputMarkup(data.output);
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
  const headings = state.cells.flatMap(cell => cell.type === 'markdown'
    ? cell.source.split('\n').flatMap(line => {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      return match ? [{ id: cell.id, level: match[1].length, title: match[2] }] : [];
    })
    : []);
  list.innerHTML = headings.length
    ? headings.map(heading => `<button class="outline-item level-${heading.level}" data-outline-id="${heading.id}"><span>H${heading.level}</span>${escapeHTML(heading.title)}</button>`).join('')
    : '<p class="outline-empty">Add Markdown headings to build an outline.</p>';
}
function renderNotebookNavigation() {
  const notebook = activeNotebook();
  const recentNotebooks = [...state.notebooks.notebooks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const openNotebooks = state.notebooks.notebooks.filter(item => item.open);
  const notebookButton = item => `<div class="project-notebook-row ${item.id === state.activeNotebookId ? 'active' : ''}" data-drag-notebook-id="${item.id}" draggable="true"><button class="project-notebook" data-notebook-id="${item.id}" title="${escapeHTML(item.name)}"><span class="notebook-file-icon">▣</span><span>${escapeHTML(item.name)}</span>${item.open ? '<i class="open-file-indicator" title="Open in editor"></i>' : ''}</button></div>`;
  const folderTree = state.notebooks.folders.map(folder => `<div class="notebook-folder"><div class="folder-label" data-folder-id="${folder.id}" title="${escapeHTML(folder.name)}"><span class="folder-icon">▣</span> <strong>${escapeHTML(folder.name)}</strong></div>${state.notebooks.notebooks.filter(item => item.folderId === folder.id).map(notebookButton).join('') || '<span class="empty-folder">Empty</span>'}</div>`).join('');
  const rootNotebooks = state.notebooks.notebooks.filter(item => !item.folderId).map(notebookButton).join('');
  document.querySelector('#notebook-tree').innerHTML = `${folderTree}<div class="folder-label root-label" data-folder-id="root"><span class="folder-icon">▣</span> <strong>Root</strong></div>${rootNotebooks || '<span class="empty-folder">Empty</span>'}`;
  document.querySelector('#recent-notebook-list').innerHTML = recentNotebooks.map(notebookButton).join('');
  document.querySelector('#notebook-tabs').innerHTML = openNotebooks.map(item => `<div class="notebook-tab ${item.id === state.activeNotebookId ? 'active' : ''}" data-notebook-id="${item.id}"><button class="tab-select" aria-label="Open ${escapeHTML(item.name)}"><span class="notebook-file-icon">▣</span><span>${escapeHTML(item.name)}</span></button><button class="close-tab" aria-label="Close ${escapeHTML(item.name)}">×</button></div>`).join('');
  document.querySelector('#notebook-title').textContent = notebook.name;
  document.querySelector('#crumb-notebook-name').textContent = notebook.name;
  document.querySelector('.notebook-head .eyebrow').firstChild.textContent = `${notebook.language} NOTEBOOK `;
}
function renderWorkspace() { renderNotebookNavigation(); renderDatasets(); renderCells(); }
function closeNotebook(id) {
  const openNotebooks = state.notebooks.notebooks.filter(item => item.open);
  if (openNotebooks.length === 1) return;
  const notebook = state.notebooks.notebooks.find(item => item.id === id); if (!notebook) return;
  notebook.open = false;
  if (id === state.activeNotebookId) {
    const next = openNotebooks.find(item => item.id !== id);
    state.activeNotebookId = next.id; state.notebooks.activeNotebookId = next.id; state.cells = next.cells; state.selected.clear(); state.activeCellId = null; resetHistory();
  }
  persistNotebooks(); renderWorkspace();
}
function renameActiveNotebook() {
  const title = document.querySelector('#notebook-title'); const notebook = activeNotebook();
  if (title.querySelector('input')) return;
  title.innerHTML = `<input id="notebook-rename-input" value="${escapeHTML(notebook.name)}" aria-label="Notebook name" />`;
  const input = title.querySelector('input'); input.focus(); input.select();
  const commit = () => { const nextName = input.value.trim(); if (nextName) { notebook.name = nextName; notebook.updatedAt = Date.now(); persistNotebooks(); } renderNotebookNavigation(); };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); if (event.key === 'Escape') { input.value = notebook.name; input.blur(); } });
}
function renameNotebookInTree(id) {
  const notebook = state.notebooks.notebooks.find(item => item.id === id); const row = document.querySelector(`[data-drag-notebook-id="${id}"]`); if (!notebook || !row) return;
  const button = row.querySelector('.project-notebook'); button.innerHTML = `<input class="tree-rename" value="${escapeHTML(notebook.name)}" aria-label="Notebook name" />`;
  const input = button.querySelector('input'); input.focus(); input.select();
  const commit = () => { const name = input.value.trim(); if (name) { notebook.name = name; notebook.updatedAt = Date.now(); persistNotebooks(); } renderNotebookNavigation(); };
  input.addEventListener('blur', commit, { once: true }); input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); if (event.key === 'Escape') { input.value = notebook.name; input.blur(); } });
}
function renameFolderInTree(id) {
  if (id === 'root') return; const folder = state.notebooks.folders.find(item => item.id === id); const label = document.querySelector(`[data-folder-id="${id}"]`); if (!folder || !label) return;
  label.innerHTML = `<span class="folder-icon">▣</span><input class="tree-rename" value="${escapeHTML(folder.name)}" aria-label="Folder name" />`;
  const input = label.querySelector('input'); input.focus(); input.select();
  const commit = () => { const name = input.value.trim(); if (name) { folder.name = name; persistNotebooks(); } renderNotebookNavigation(); };
  input.addEventListener('blur', commit, { once: true }); input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); if (event.key === 'Escape') { input.value = folder.name; input.blur(); } });
}
function copyActiveNotebook() { const source = activeNotebook(); const copy = { ...source, id: crypto.randomUUID(), name: `Copy of ${source.name}`, cells: cloneCells(source.cells), open: true, updatedAt: Date.now() }; state.notebooks.notebooks.push(copy); switchNotebook(copy.id); }
function deleteActiveNotebook() { const notebook = activeNotebook(); if (!window.confirm(`Delete “${notebook.name}” from this prototype workspace?`)) return; state.notebooks.notebooks = state.notebooks.notebooks.filter(item => item.id !== notebook.id); if (!state.notebooks.notebooks.length) return; const next = state.notebooks.notebooks[0]; state.activeNotebookId = next.id; state.cells = next.cells; state.selected.clear(); state.activeCellId = null; resetHistory(); persistNotebooks(); renderWorkspace(); }
function addFolder() { const modal = document.querySelector('#folder-modal'); modal.classList.remove('hidden'); requestAnimationFrame(() => document.querySelector('#folder-name-input').focus()); }
function updateCell(id, patch) { Object.assign(getCell(id), patch); save(); renderOutline(); }
function insertAfter(id, cell = newCell()) { state.cells.splice(cellIndex(id) + 1, 0, cell); save(); renderCells(); focusCell(cell.id); }
function focusCell(id, preventScroll = false) { requestAnimationFrame(() => document.querySelector(`[data-id="${id}"] .code-input`)?.focus({ preventScroll })); }
function setActiveCell(id) { state.activeCellId = id; document.querySelectorAll('.cell.active').forEach(cell => cell.classList.remove('active')); document.querySelector(`[data-id="${id}"]`)?.classList.add('active'); }
function runCell(id) { const cell = getCell(id); state.activeCellId = id; cell.meta = `Ran just now · ${cell.type === 'sql' ? '0.18' : '0.24'}s`; cell.output = cell.type === 'sql' ? 'query' : cell.type === 'markdown' ? '' : 'table'; save(); renderCells(); }
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
  setActiveCell(id);
  if (event.target.closest('.run-cell')) runCell(id);
  if (event.target.closest('.delete-cell')) { state.selected = new Set([id]); deleteSelected(); }
  if (event.target.closest('.cell-type-selector')) { cell.querySelector('.cell-type').classList.toggle('open'); }
  const typeOption = event.target.closest('[data-cell-type]');
  if (typeOption) { const target = getCell(id); target.type = typeOption.dataset.cellType; target.output = ''; target.meta = ''; save(); renderCells(); }
  if (event.target.closest('.markdown-render')) { const renderer = event.target.closest('.markdown-render'); renderer.classList.add('editing'); cell.querySelector('.code-input').classList.add('editing'); cell.querySelector('.code-input').focus(); autoHeight(cell.querySelector('.code-input')); }
});
cellsEl.addEventListener('focusin', event => { const cell = event.target.closest('.cell'); if (cell) setActiveCell(cell.dataset.id); });
cellsEl.addEventListener('focusout', event => { if (event.target.matches('.code-input.editing')) { event.target.classList.remove('editing'); event.target.closest('.cell').querySelector('.markdown-render')?.classList.remove('editing'); } });
cellsEl.addEventListener('click', event => { const button = event.target.closest('[data-insert-after]'); if (button) insertAfter(button.dataset.insertAfter, newCell(button.dataset.insertType)); });
cellsEl.addEventListener('dragstart', event => { const cell = event.target.closest('.cell'); if (!cell || event.target.closest('textarea')) { event.preventDefault(); return; } state.dragId = cell.dataset.id; cell.classList.add('dragging'); });
cellsEl.addEventListener('dragover', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell && cell.dataset.id !== state.dragId) cell.classList.add('drop-target'); });
cellsEl.addEventListener('dragleave', event => event.target.closest('.cell')?.classList.remove('drop-target'));
cellsEl.addEventListener('drop', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell) moveCell(state.dragId, cell.dataset.id); });
cellsEl.addEventListener('dragend', () => { state.dragId = null; document.querySelectorAll('.cell').forEach(cell => cell.classList.remove('dragging', 'drop-target')); });

document.querySelector('#run-all').addEventListener('click', () => { state.cells.filter(cell => cell.type !== 'markdown').forEach(cell => { cell.meta = 'Ran just now · 0.20s'; cell.output = cell.type === 'sql' ? 'query' : 'table'; }); save(); renderCells(); });
document.querySelector('#dataset-search').addEventListener('input', event => renderDatasets(event.target.value));
document.querySelector('#dataset-list').addEventListener('click', event => { const dataset = event.target.closest('[data-dataset]'); if (!dataset) return; const cell = newCell('python'); cell.source = `import dataiku\n\n${dataset.dataset.dataset.replace(/\W/g, '_')} = dataiku.Dataset("${dataset.dataset.dataset}").get_dataframe()\n${dataset.dataset.dataset.replace(/\W/g, '_')}.head()`; state.cells.push(cell); save(); renderCells(); focusCell(cell.id); });
document.querySelector('#new-notebook-button').addEventListener('click', () => { const number = state.notebooks.notebooks.length + 1; const notebook = { id: crypto.randomUUID(), name: `Untitled notebook ${number}`, language: 'PYTHON', cells: [newCell('python')], open: true, updatedAt: Date.now(), folderId: null }; notebook.cells[0].source = ''; state.notebooks.notebooks.push(notebook); state.activeNotebookId = notebook.id; state.cells = notebook.cells; state.selected.clear(); state.activeCellId = notebook.cells[0].id; resetHistory(); persistNotebooks(); renderWorkspace(); focusCell(notebook.cells[0].id); });
document.querySelector('#notebook-tree').addEventListener('click', event => { const item = event.target.closest('[data-notebook-id]'); if (item) switchNotebook(item.dataset.notebookId); });
document.querySelector('#notebook-tree').addEventListener('dblclick', event => { const row = event.target.closest('[data-drag-notebook-id]'); const folder = event.target.closest('[data-folder-id]'); if (row) renameNotebookInTree(row.dataset.dragNotebookId); else if (folder) renameFolderInTree(folder.dataset.folderId); });
document.querySelector('#notebook-tree').addEventListener('dragstart', event => { const row = event.target.closest('[data-drag-notebook-id]'); if (!row) return; event.dataTransfer.setData('text/plain', row.dataset.dragNotebookId); event.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
document.querySelector('#notebook-tree').addEventListener('dragend', () => document.querySelectorAll('.folder-label.drop-target, .project-notebook-row.dragging').forEach(node => node.classList.remove('drop-target', 'dragging')));
document.querySelector('#notebook-tree').addEventListener('dragover', event => { const folder = event.target.closest('[data-folder-id]'); if (!folder) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; document.querySelectorAll('.folder-label.drop-target').forEach(node => node.classList.remove('drop-target')); folder.classList.add('drop-target'); });
document.querySelector('#notebook-tree').addEventListener('dragleave', event => event.target.closest('[data-folder-id]')?.classList.remove('drop-target'));
document.querySelector('#notebook-tree').addEventListener('drop', event => { const folder = event.target.closest('[data-folder-id]'); if (!folder) return; event.preventDefault(); const notebook = state.notebooks.notebooks.find(item => item.id === event.dataTransfer.getData('text/plain')); if (!notebook) return; notebook.folderId = folder.dataset.folderId === 'root' ? null : folder.dataset.folderId; notebook.updatedAt = Date.now(); persistNotebooks(); renderNotebookNavigation(); });
document.querySelector('#recent-notebook-list').addEventListener('click', event => { const item = event.target.closest('[data-notebook-id]'); if (item) switchNotebook(item.dataset.notebookId); });
document.querySelector('#notebook-tabs').addEventListener('click', event => { const close = event.target.closest('.close-tab'); if (close) { closeNotebook(close.closest('[data-notebook-id]').dataset.notebookId); return; } const item = event.target.closest('[data-notebook-id]'); if (item) switchNotebook(item.dataset.notebookId); });
document.querySelector('#notebooks-section-toggle').addEventListener('click', () => document.querySelector('.explorer-section').classList.toggle('collapsed'));
document.querySelector('#recents-section-toggle').addEventListener('click', () => document.querySelector('.recents-section').classList.toggle('collapsed'));
document.querySelector('#rename-notebook-button').addEventListener('click', renameActiveNotebook);
document.querySelector('#notebook-title').addEventListener('dblclick', renameActiveNotebook);
document.querySelector('#copy-notebook-button').addEventListener('click', copyActiveNotebook);
document.querySelector('#delete-notebook-button').addEventListener('click', deleteActiveNotebook);
document.querySelector('#new-folder-button').addEventListener('click', addFolder);
document.querySelector('#explorer-view-button').addEventListener('click', () => { document.querySelector('.sidebar').classList.remove('outline-view'); document.querySelector('.sidebar').classList.add('explorer-view'); document.querySelector('#explorer-view-button').classList.add('active'); document.querySelector('#outline-view-button').classList.remove('active'); });
document.querySelector('#outline-view-button').addEventListener('click', () => { document.querySelector('.sidebar').classList.remove('explorer-view'); document.querySelector('.sidebar').classList.add('outline-view'); document.querySelector('#outline-view-button').classList.add('active'); document.querySelector('#explorer-view-button').classList.remove('active'); });
document.querySelector('#sidebar-collapse-button').addEventListener('click', () => { document.querySelector('.sidebar').classList.toggle('collapsed'); document.querySelector('.app-shell').classList.toggle('sidebar-collapsed'); });
const folderModal = document.querySelector('#folder-modal');
const closeFolderModal = () => { folderModal.classList.add('hidden'); document.querySelector('#folder-form').reset(); };
document.querySelector('#close-folder-modal').addEventListener('click', closeFolderModal);
document.querySelector('#cancel-folder').addEventListener('click', closeFolderModal);
folderModal.addEventListener('click', event => { if (event.target === folderModal) closeFolderModal(); });
document.querySelector('#folder-form').addEventListener('submit', event => { event.preventDefault(); const name = document.querySelector('#folder-name-input').value.trim(); if (!name) return; state.notebooks.folders.push({ id: crypto.randomUUID(), name }); persistNotebooks(); renderNotebookNavigation(); closeFolderModal(); });
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
  if (event.key === 'Escape') { closeSettings(); closeFolderModal(); return; }
  if (event.shiftKey && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); const cell = document.activeElement.closest?.('.cell'); if (cell) { const nextId = state.cells[cellIndex(cell.dataset.id) + 1]?.id; if (nextId) { runCell(cell.dataset.id); requestAnimationFrame(() => { setActiveCell(nextId); document.querySelector(`[data-id="${nextId}"] .code-input, [data-id="${nextId}"] .markdown-render`)?.focus(); }); } else { const currentCell = getCell(cell.dataset.id); currentCell.meta = `Ran just now · ${currentCell.type === 'sql' ? '0.18' : '0.24'}s`; currentCell.output = currentCell.type === 'sql' ? 'query' : currentCell.type === 'markdown' ? '' : 'table'; const newCodeCell = newCell('python'); newCodeCell.source = ''; state.cells.push(newCodeCell); state.activeCellId = newCodeCell.id; save(); renderCells(); focusCell(newCodeCell.id, true); } } return; }
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
  if (mod && event.key === 'Enter') { event.preventDefault(); (state.selected.size ? [...state.selected] : [document.activeElement.closest?.('.cell')?.dataset.id]).filter(Boolean).forEach(runCell); }
  if (mod && event.key.toLowerCase() === 'c' && state.selected.size) { event.preventDefault(); copySelected(); }
  if (mod && event.key.toLowerCase() === 'x' && state.selected.size) { event.preventDefault(); copySelected(true); }
  if (mod && event.key.toLowerCase() === 'v' && state.clipboard.length && !document.activeElement.matches('.code-input')) { event.preventDefault(); pasteCells(); }
  if (event.key === 'Backspace' && state.selected.size && !document.activeElement.matches('.code-input')) { event.preventDefault(); deleteSelected(); }
});

state.activeNotebookId = state.notebooks.activeNotebookId || state.notebooks.notebooks[0].id;
state.cells = activeNotebook().cells;
resetHistory(); save(false); renderWorkspace(); loadProjectDatasets();
