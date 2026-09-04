import * as BetterNotebookEditor from './editor.js';

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
const projectContext = { name: 'Current project', key: '', isDss: false, connections: [], sqlConnection: '', managedConnection: 'filesystem_managed' };
const dss = { enabled: false, loading: false, workspaceLoaded: false, runtimes: [], activeRuntimeId: 'dss_builtin', kernel: null };
let dssSaveTimer;
let selectedDatasetName = '';
const diagnosticsTimers = new Map();

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

const state = { notebooks: loadNotebooks(), activeNotebookId: null, notebookListMode: 'all', cells: [], selected: new Set(), clipboard: [], dragId: null, activeCellId: null, history: [], historyIndex: -1, collapsedHeadings: new Set(), searchQuery: '', searchIndex: 0 };
const execution = { runningAll: false, stopRequested: false };
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
    // Native DSS notebooks must always be rehydrated from DSS. Keeping them in
    // browser storage can render an obsolete one-cell copy and, worse, save it
    // back before the project discovery calls have completed.
    const localNotebooks = saved?.notebooks?.filter(notebook => !notebook.remote) || [];
    if (localNotebooks.length) return {
      ...saved,
      activeNotebookId: localNotebooks.some(notebook => notebook.id === saved.activeNotebookId) ? saved.activeNotebookId : localNotebooks[0].id,
      folders: saved.folders ?? [],
      notebooks: localNotebooks.map(notebook => ({ ...notebook, open: notebook.open ?? true, updatedAt: notebook.updatedAt ?? 0, folderId: notebook.folderId ?? null })),
    };
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
async function switchNotebook(id) {
  const notebook = state.notebooks.notebooks.find(item => item.id === id); if (!notebook || id === state.activeNotebookId) return;
  if (notebook.remote && !notebook.loaded) {
    setSavedState('Loading notebook from DSS…');
    try { await loadDssNotebook(notebook); }
    catch (error) { setSavedState('DSS notebook load failed', true); console.warn(error); return; }
  }
  notebook.open = true; state.activeNotebookId = id; state.notebooks.activeNotebookId = id; state.cells = notebook.cells; state.selected.clear(); state.activeCellId = null; dss.activeRuntimeId = notebook.runtimeId || 'dss_builtin'; resetHistory(); if (!notebook.remote) persistNotebooks(); renderWorkspace(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function persistNotebooks() { localStorage.setItem(storageKey('notebooks'), JSON.stringify(state.notebooks)); }
function save(recordHistory = true) {
  const notebook = activeNotebook();
  notebook.cells = state.cells; notebook.updatedAt = Date.now(); state.notebooks.activeNotebookId = state.activeNotebookId;
  if (!notebook.remote) persistNotebooks();
  if (recordHistory) {
    const snapshot = JSON.stringify(state.cells);
    if (state.history[state.historyIndex] !== snapshot) {
      state.history.splice(state.historyIndex + 1);
      state.history.push(snapshot);
      state.historyIndex = state.history.length - 1;
    }
  }
  if (notebook.remote && !dss.workspaceLoaded) {
    setSavedState('Waiting for the DSS notebook to load before saving…');
  } else if (notebook.remote) queueDssSave(notebook);
  else setSavedState('Saved locally');
}
function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex -= 1;
  state.cells = JSON.parse(state.history[state.historyIndex]);
  state.selected.clear();
  save(false); renderCells();
}
function escapeHTML(value) { return value.replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[ch]); }
function dssBackendBridge() {
  // DSS exposes this method on its injected `dataiku` API. The legacy global
  // alias exists in some DSS pages, but is not guaranteed to be a window
  // property (it is declared by DSS's inline bootstrap script).
  if (typeof dataiku !== 'undefined' && typeof dataiku.getWebAppBackendUrl === 'function') return dataiku.getWebAppBackendUrl.bind(dataiku);
  if (typeof getWebAppBackendUrl === 'function') return getWebAppBackendUrl;
  return null;
}
function dssBackendUrl(path) {
  const bridge = dssBackendBridge();
  if (!bridge) throw new Error('DSS webapp bridge is unavailable.');
  return bridge(`/${String(path).replace(/^\/+/, '')}`);
}
function isDssWebappRuntime() { return Boolean(dssBackendBridge()); }
async function dssRequest(path, options = {}) {
  const response = await fetch(dssBackendUrl(path), {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `DSS request failed (${response.status})`);
  return payload;
}
function xsrfToken() {
  const match = document.cookie.match(/(?:^|; )_xsrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
async function jupyterRequest(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = xsrfToken();
  if (token) headers['X-XSRFToken'] = token;
  const response = await fetch(`/jupyter/${path.replace(/^\//, '')}`, { credentials: 'same-origin', headers, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.reason || `Jupyter request failed (${response.status})`);
  return payload;
}
function notebookKernelName(notebook) {
  return dss.runtimes.find(runtime => runtime.id === notebook.runtimeId)?.kernelSpec?.name
    || notebook.dssContent?.metadata?.kernelspec?.name || 'python3';
}
function setKernelStatus(label, state = 'idle') {
  const pill = document.querySelector('#kernel-status');
  if (!pill) return;
  pill.textContent = `● ${label}`;
  pill.dataset.state = state;
}
function jupyterSocketUrl(kernelId, sessionId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/jupyter/api/kernels/${encodeURIComponent(kernelId)}/channels?session_id=${encodeURIComponent(sessionId)}`;
}
function jupyterMessage(type, content, sessionId) {
  return {
    header: { msg_id: crypto.randomUUID(), username: 'better-notebooks', session: sessionId, msg_type: type, version: '5.3' },
    parent_header: {}, metadata: {}, content,
  };
}
function jupyterOutput(message) {
  const type = message.header?.msg_type;
  const content = message.content || {};
  if (type === 'stream') return { output_type: 'stream', name: content.name || 'stdout', text: content.text || '' };
  if (type === 'error') return { output_type: 'error', ename: content.ename || 'Error', evalue: content.evalue || '', traceback: content.traceback || [] };
  if (type === 'execute_result') return { output_type: 'execute_result', execution_count: content.execution_count, data: content.data || {}, metadata: content.metadata || {} };
  if (type === 'display_data' || type === 'update_display_data') return { output_type: 'display_data', data: content.data || {}, metadata: content.metadata || {} };
  return null;
}
function finishJupyterExecution(kernel, messageId) {
  const request = kernel.pending.get(messageId); if (!request) return;
  clearTimeout(request.timeout); kernel.pending.delete(messageId); setKernelStatus('Connected', 'connected');
  request.resolve({ outputs: request.outputs, executionCount: request.executionCount });
}
function handleJupyterMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  const kernel = dss.kernel;
  if (!kernel) return;
  const request = kernel.pending.get(message.parent_header?.msg_id);
  if (!request) return;
  if (request.kind === 'inspect') {
    if (message.header?.msg_type === 'inspect_reply') {
      clearTimeout(request.timeout); kernel.pending.delete(message.parent_header?.msg_id);
      request.resolve(message.content?.found ? (message.content.data?.['text/plain'] || message.content.data?.['text/html'] || '') : '');
    }
    return;
  }
  const output = jupyterOutput(message);
  if (output) { request.outputs.push(output); request.onOutput?.(request.outputs); }
  if (message.header?.msg_type === 'execute_reply') {
    request.executionCount = message.content?.execution_count;
    // DSS/Jupyter normally follows with an IOPub idle message. Guard against
    // proxies that omit it so a completed cell cannot remain "Running…".
    setTimeout(() => finishJupyterExecution(kernel, message.parent_header?.msg_id), 500);
  }
  if (message.header?.msg_type === 'status' && message.content?.execution_state === 'idle') {
    finishJupyterExecution(kernel, message.parent_header?.msg_id);
  }
}
async function connectDssKernel(notebook) {
  if (!projectContext.key) await loadProjectContext();
  if (!projectContext.key) throw new Error('The current DSS project is not available. Refresh the webapp and try again.');
  if (dss.kernel?.notebookId === notebook.id && dss.kernel.socket.readyState === WebSocket.OPEN) return dss.kernel;
  if (dss.kernel?.socket) dss.kernel.socket.close();
  await flushDssSave(notebook);
  setKernelStatus('Starting…', 'starting');
  const session = await jupyterRequest('api/sessions', {
    method: 'POST', body: JSON.stringify({
      path: `${projectContext.key}/${notebook.name}.ipynb`, type: 'notebook', name: '',
      kernel: { id: null, name: notebookKernelName(notebook) },
    }),
  });
  if (!session.kernel?.id) throw new Error('DSS started a session without a kernel.');
  const sessionId = crypto.randomUUID();
  const socket = new WebSocket(jupyterSocketUrl(session.kernel.id, sessionId));
  const kernel = { notebookId: notebook.id, sessionId, dssSessionId: session.id, kernelId: session.kernel.id, socket, pending: new Map() };
  dss.kernel = kernel;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out while connecting to the DSS kernel.')), 20000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not connect to the DSS kernel WebSocket.')); }, { once: true });
  });
  socket.addEventListener('message', handleJupyterMessage);
  socket.addEventListener('close', () => { if (dss.kernel === kernel) { dss.kernel = null; setKernelStatus('Disconnected', 'error'); } });
  setKernelStatus('Connected', 'connected');
  return kernel;
}
async function executeInDssKernel(notebook, source, onOutput) {
  const kernel = await connectDssKernel(notebook);
  const message = jupyterMessage('execute_request', {
    code: source, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true,
  }, kernel.sessionId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      kernel.pending.delete(message.header.msg_id);
      reject(new Error('Cell execution timed out after 90 seconds.'));
    }, 90000);
    kernel.pending.set(message.header.msg_id, { outputs: [], executionCount: null, resolve, reject, timeout, onOutput });
    setKernelStatus('Running…', 'busy');
    kernel.socket.send(JSON.stringify({ ...message, channel: 'shell' }));
  });
}
async function inspectInDssKernel(notebook, code, cursorPos) {
  // Keep hover passive: only inspect an already-running notebook kernel.
  const kernel = dss.kernel;
  if (!kernel || kernel.notebookId !== notebook.id || kernel.socket.readyState !== WebSocket.OPEN) return '';
  const message = jupyterMessage('inspect_request', { code, cursor_pos: cursorPos, detail_level: 0 }, kernel.sessionId);
  return new Promise(resolve => {
    const timeout = setTimeout(() => { kernel.pending.delete(message.header.msg_id); resolve(''); }, 2500);
    kernel.pending.set(message.header.msg_id, { kind: 'inspect', resolve, timeout });
    kernel.socket.send(JSON.stringify({ ...message, channel: 'shell' }));
  });
}
async function interruptDssExecution() {
  if (!dss.kernel?.kernelId) return;
  setKernelStatus('Interrupting…', 'busy');
  await jupyterRequest(`api/kernels/${encodeURIComponent(dss.kernel.kernelId)}/interrupt`, { method: 'POST', body: '{}' });
}
function setSavedState(message, isError = false) {
  const status = document.querySelector('#saved-state');
  status.textContent = message;
  status.classList.toggle('error', isError);
}
function sourceText(source) { return Array.isArray(source) ? source.join('') : String(source || ''); }
function outputText(value) {
  // Jupyter tracebacks can retain ANSI terminal colour sequences. They are not
  // useful in a browser output block and make long tracebacks unreadable.
  return sourceText(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
function sourceLines(source) { return source ? source.match(/[^\n]*\n|[^\n]+/g) || [] : []; }
function dssDocumentFor(notebook) {
  const document = structuredClone(notebook.dssContent || { nbformat: 4, nbformat_minor: 5, metadata: {} });
  document.metadata = document.metadata || {};
  const runtime = dss.runtimes.find(item => item.id === notebook.runtimeId);
  if (runtime?.kernelSpec) document.metadata.kernelspec = runtime.kernelSpec;
  document.cells = notebook.cells.map(cell => {
    const metadata = { ...(cell.dssCell?.metadata || {}) };
    if (cell.type === 'sql') metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), cellType: 'sql' };
    else if (metadata.betterNotebooks?.cellType === 'sql') delete metadata.betterNotebooks.cellType;
    return {
      ...(cell.dssCell || {}), metadata, cell_type: cell.type === 'markdown' ? 'markdown' : 'code',
      source: sourceLines(cell.source), execution_count: cell.dssCell?.execution_count ?? null,
      outputs: cell.dssCell?.outputs || [],
    };
  });
  return document;
}
async function saveDssNotebook(notebook) {
  const payload = await dssRequest(`notebooks/${encodeURIComponent(notebook.name)}`, {
    method: 'PUT', body: JSON.stringify({ notebook: dssDocumentFor(notebook) }),
  });
  notebook.dssContent = payload.notebook;
}
function queueDssSave(notebook) {
  clearTimeout(dssSaveTimer); setSavedState('Saving to DSS…');
  dssSaveTimer = setTimeout(async () => {
    try { await saveDssNotebook(notebook); setSavedState('Saved to DSS'); }
    catch (error) { setSavedState(`DSS save failed: ${error.message}`, true); console.warn(error); }
  }, 650);
}
async function flushDssSave(notebook) {
  clearTimeout(dssSaveTimer);
  setSavedState('Saving to DSS…');
  await saveDssNotebook(notebook);
}
function queuePythonCheck(cell) {
  if (!dss.enabled || cell.type !== 'python') return;
  clearTimeout(diagnosticsTimers.get(cell.id));
  diagnosticsTimers.set(cell.id, setTimeout(async () => {
    try {
      const result = await dssRequest('python-check', { method: 'POST', body: JSON.stringify({ source: cell.source }) });
      cell.diagnostic = result.valid ? null : result;
    } catch (error) { cell.diagnostic = { message: 'Syntax check unavailable' }; }
    BetterNotebookEditor.setDiagnostic(cell.id, cell.diagnostic);
    const diagnostic = document.querySelector(`[data-id="${cell.id}"] .cell-diagnostic`);
    if (diagnostic) { diagnostic.hidden = !cell.diagnostic; diagnostic.textContent = cell.diagnostic ? `Line ${cell.diagnostic.line || '?'}: ${cell.diagnostic.message}` : ''; }
  }, 500));
}
function cellsFromDss(raw) {
  return (raw.cells || []).map(cell => ({
    id: crypto.randomUUID(),
    type: cell.cell_type === 'markdown' ? 'markdown' : cell.metadata?.betterNotebooks?.cellType === 'sql' ? 'sql' : 'python',
    source: sourceText(cell.source),
    meta: cell.execution_count ? `Previously run · #${cell.execution_count}` : '',
    output: cell.outputs?.length ? { outputs: cell.outputs } : '',
    dssCell: cell,
  }));
}
function runtimeIdFor(kernelSpec) {
  const name = kernelSpec?.name || '';
  if (name === 'python3') return 'dss_builtin';
  const match = name.match(/^py-dku-venv-(.+)$/);
  return match ? match[1] : 'dss_builtin';
}
function renderRuntimeSelector() {
  const selector = document.querySelector('#executor-selector');
  const runtimes = dss.runtimes.length ? dss.runtimes : [{ id: 'dss_builtin', label: 'DSS built-in Python' }];
  selector.innerHTML = runtimes.map(runtime => `<option value="${escapeHTML(runtime.id)}">${escapeHTML(runtime.label)}</option>`).join('');
  selector.value = runtimes.some(runtime => runtime.id === dss.activeRuntimeId) ? dss.activeRuntimeId : 'dss_builtin';
}
async function loadDssNotebook(notebook) {
  const payload = await dssRequest(`notebooks/${encodeURIComponent(notebook.name)}`);
  notebook.dssContent = payload.notebook;
  notebook.cells = cellsFromDss(payload.notebook);
  notebook.loaded = true;
  notebook.language = 'PYTHON';
  notebook.runtimeId = runtimeIdFor(payload.notebook.metadata?.kernelspec);
}
async function loadDssWorkspace() {
  if (!isDssWebappRuntime()) return;
  dss.loading = true;
  try {
    const [notebookPayload, runtimePayload] = await Promise.all([
      dssRequest('notebooks'), dssRequest('python-runtimes'),
    ]);
    dss.enabled = true;
    dss.runtimes = runtimePayload.runtimes || [];
    const notebooks = (notebookPayload.notebooks || []).map((item, index) => ({
      id: item.name, name: item.name, language: 'PYTHON', cells: [], open: index === 0,
      updatedAt: 0, folderId: null, remote: true, loaded: false, runtimeId: runtimeIdFor(item.kernelSpec),
    }));
    if (!notebooks.length) {
      dss.loading = false; dss.workspaceLoaded = true;
      setSavedState('No DSS notebooks yet');
      renderRuntimeSelector();
      return;
    }
    state.notebooks = { activeNotebookId: notebooks[0].id, folders: [], notebooks };
    state.activeNotebookId = notebooks[0].id;
    await loadDssNotebook(notebooks[0]);
    state.cells = notebooks[0].cells;
    dss.activeRuntimeId = notebooks[0].runtimeId;
    dss.loading = false; dss.workspaceLoaded = true; resetHistory(); renderRuntimeSelector(); renderWorkspace();
    setSavedState('Loaded from DSS');
  } catch (error) {
    dss.loading = false; dss.enabled = false; dss.workspaceLoaded = false;
    console.warn('Better Notebooks could not load native DSS notebooks.', error);
    setSavedState('DSS notebook load failed', true);
  }
}
function renderProjectContext() {
  document.querySelector('#crumb-project-name').textContent = projectContext.name;
  document.querySelector('#datasets-panel-title').textContent = projectContext.key
    ? `${projectContext.name.toUpperCase()} DATASETS`
    : 'PROJECT DATASETS';
  document.querySelector('#notebook-subtitle').textContent = projectContext.isDss
    ? `${projectContext.name} · Native DSS notebook view`
    : 'Browser-local notebook workspace';
  const notice = document.querySelector('#runtime-notice');
  if (notice) notice.innerHTML = projectContext.isDss
    ? '<strong>Native DSS mode.</strong> Changes save to this project’s Jupyter notebook. Run starts or reconnects to its DSS kernel.'
    : '<strong>Browser preview.</strong> Run outputs are illustrative until this webapp is opened inside DSS.';
}
async function loadProjectContext() {
  if (!isDssWebappRuntime()) return;
  try {
    const payload = await dssRequest('project-context');
    if (!payload.project?.name || !Array.isArray(payload.datasets)) throw new Error('Project context response is invalid');
    projectContext.name = payload.project.name;
    projectContext.key = payload.project.key || '';
    projectContext.isDss = true;
    DATASETS = payload.datasets.map((dataset, index) => ({
      name: dataset.name,
      kind: ['blue', 'orange', 'purple'][index % 3],
      type: dataset.type || 'Dataset',
      columns: Array.isArray(dataset.columns) ? dataset.columns : [],
      connection: dataset.connection || '', tableName: dataset.tableName || '',
    }));
    projectContext.connections = Array.isArray(payload.connections) ? payload.connections : [];
    const sqlConnections = projectContext.connections.filter(connection => connection.type !== 'Filesystem');
    if (!sqlConnections.some(connection => connection.name === projectContext.sqlConnection)) projectContext.sqlConnection = sqlConnections[0]?.name || '';
    projectContext.managedConnection = projectContext.sqlConnection || projectContext.connections.find(connection => connection.name === 'filesystem_managed')?.name || 'filesystem_managed';
    renderProjectContext();
    renderDatasets(document.querySelector('#dataset-search').value);
    renderSqlConnectionSelector();
    renderLinkedDatasets();
  } catch (error) {
    console.warn('Better Notebooks could not load project context; using local examples.', error);
  }
}
function cellIndex(id) { return state.cells.findIndex(cell => cell.id === id); }
function getCell(id) { return state.cells.find(cell => cell.id === id); }
function newCell(type = 'python') { return { id: crypto.randomUUID(), type, source: type === 'markdown' ? '## New section' : type === 'sql' ? 'SELECT *\nFROM customers_enriched\nLIMIT 100' : '', meta: '' }; }

function symbolsBefore(cellId) {
  const symbols = new Map();
  state.cells.slice(0, Math.max(cellIndex(cellId), 0)).filter(cell => cell.type === 'python').forEach(cell => {
    cell.source.matchAll(/^\s*def\s+([A-Za-z_]\w*)\s*(\([^\n)]*\))/gm).forEach(match => symbols.set(match[1], { name: match[1], kind: 'function', detail: `${match[1]}${match[2]} · defined above` }));
    cell.source.matchAll(/^\s*class\s+([A-Za-z_]\w*)/gm).forEach(match => symbols.set(match[1], { name: match[1], kind: 'class', detail: `${match[1]} · class defined above` }));
    cell.source.matchAll(/^\s*([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/gm).forEach(match => {
      const rhs = match[2];
      const type = /dataiku\.Dataset\s*\(/.test(rhs) ? 'dataiku.Dataset'
        : /(?:\.get_dataframe\s*\(|pd\.DataFrame\s*\(|pandas\.DataFrame\s*\()/.test(rhs) ? 'pandas.DataFrame'
          : /SQLExecutor2\s*\(/.test(rhs) ? 'dataiku.SQLExecutor2'
            : /\[.*\]/.test(rhs) ? 'list' : /\{.*\}/.test(rhs) ? 'dict' : 'variable';
      symbols.set(match[1], { name: match[1], kind: 'variable', detail: `${match[1]} · ${type} defined above` });
    });
    cell.source.matchAll(/^\s*(?:from\s+\S+\s+import|import)\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/gm).forEach(match => { const name = match[2] || match[1]; symbols.set(name, { name, kind: 'variable', detail: `${name} · imported above` }); });
  });
  return [...symbols.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function linkedDatasets() {
  const source = state.cells.map(cell => cell.source || '').join('\n');
  return DATASETS.filter(dataset => source.includes(`"${dataset.name}"`) || source.includes(`'${dataset.name}'`) || new RegExp(`\\b${dataset.name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(source));
}
function sqlExecutionSource(source) {
  // SQLExecutor2 is the DSS-supported way to run notebook SQL against an
  // explicitly selected connection, while keeping the visible cell as SQL.
  if (!projectContext.sqlConnection) return `%sql\n${source}`;
  return `from dataiku import SQLExecutor2\n\n_sql_executor = SQLExecutor2(connection=${JSON.stringify(projectContext.sqlConnection)})\n_sql_result = _sql_executor.query_to_df(${JSON.stringify(source)})\n_sql_result`;
}

function renderDatasets(filter = '') {
  const query = filter.toLowerCase();
  const matches = DATASETS.filter(dataset => dataset.name.toLowerCase().includes(query));
  document.querySelector('#dataset-list').innerHTML = matches.length
    ? matches.map(dataset => {
      const columns = dataset.columns?.length ? ` · ${dataset.columns.length} columns` : '';
      return `<button class="dataset ${dataset.name === selectedDatasetName ? 'active' : ''}" data-dataset="${escapeHTML(dataset.name)}" title="${escapeHTML(`${dataset.type || 'Dataset'}${columns}`)}"><i class="${dataset.kind}"></i><span>${escapeHTML(dataset.name)}</span></button>`;
    }).join('')
    : '<p class="dataset-empty">No project datasets found.</p>';
}
function datasetVariableName(name) { return name.replace(/\W/g, '_'); }
function insertDatasetCell(dataset, mode = 'python') {
  const cell = newCell(mode === 'sql' ? 'sql' : 'python');
  const variable = datasetVariableName(dataset.name);
  cell.source = mode === 'sql'
    ? `SELECT *\nFROM ${dataset.tableName}\nLIMIT 100`
    : `import dataiku\n\n${variable} = dataiku.Dataset("${dataset.name}").get_dataframe()\n${variable}.head()`;
  state.cells.push(cell); save(); renderCells(); focusCell(cell.id);
}
function previewTableMarkup(preview) {
  if (!preview?.columns?.length) return '<span class="dataset-preview-empty">No preview rows available.</span>';
  return `<div class="dataset-preview-table"><table><thead><tr>${preview.columns.map(column => `<th>${escapeHTML(String(column))}</th>`).join('')}</tr></thead><tbody>${preview.rows.map(row => `<tr>${row.map(value => `<td>${escapeHTML(value == null ? '' : String(value))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function selectDataset(name) {
  const dataset = DATASETS.find(item => item.name === name); if (!dataset) return;
  selectedDatasetName = name; renderDatasets(document.querySelector('#dataset-search').value);
  const inspector = document.querySelector('#dataset-inspector'); inspector.classList.remove('hidden');
  inspector.innerHTML = `<span class="eyebrow">DATASET</span><strong>${escapeHTML(dataset.name)}</strong><span class="dataset-inspector-meta">${escapeHTML(dataset.type || 'Dataset')}${dataset.connection ? ` · ${escapeHTML(dataset.connection)}` : ''}</span><div class="dataset-inspector-actions"><button data-insert-dataset="${escapeHTML(dataset.name)}">+ Load Python</button>${dataset.tableName ? `<button data-insert-dataset-sql="${escapeHTML(dataset.name)}">+ Insert SQL</button>` : ''}</div><div class="dataset-schema">${dataset.columns.slice(0, 8).map(column => `<span>${escapeHTML(column.name)}<i>${escapeHTML(column.type || '')}</i></span>`).join('') || '<span>No schema available.</span>'}</div><div class="dataset-preview-loading">Loading sample…</div>`;
  if (!projectContext.isDss) { inspector.querySelector('.dataset-preview-loading').textContent = 'Open this webapp inside DSS to preview rows.'; return; }
  try {
    const preview = await dssRequest(`datasets/${encodeURIComponent(dataset.name)}/preview`);
    if (selectedDatasetName !== name) return;
    inspector.querySelector('.dataset-preview-loading').outerHTML = previewTableMarkup(preview);
  } catch (error) {
    if (selectedDatasetName === name) inspector.querySelector('.dataset-preview-loading').textContent = 'Preview unavailable for this dataset.';
  }
}
function renderLinkedDatasets() {
  const container = document.querySelector('#linked-datasets');
  if (!container) return;
  const linked = linkedDatasets();
  container.innerHTML = linked.length
    ? linked.map(dataset => `<span title="Used by this notebook">● ${escapeHTML(dataset.name)}</span>`).join('')
    : '<span class="linked-empty">No linked project datasets yet.</span>';
}
function renderSqlConnectionSelector() {
  const selector = document.querySelector('#sql-executor-selector');
  if (!selector) return;
  const connections = projectContext.connections.filter(connection => connection.type !== 'Filesystem');
  selector.innerHTML = connections.length
    ? connections.map(connection => `<option value="${escapeHTML(connection.name)}">${escapeHTML(connection.name)}</option>`).join('')
    : '<option value="">No SQL connection</option>';
  selector.value = projectContext.sqlConnection;
  selector.title = connections.length ? 'SQL connection for SQL cells' : 'No SQL connection available in this project';
}
function outputMarkup(kind, cellId = '') {
  if (kind && typeof kind === 'object' && Array.isArray(kind.outputs)) {
    const rendered = [];
    let streamText = '';
    const flushStream = () => {
      if (!streamText) return;
      rendered.push(`<pre class="runtime-output stream">${escapeHTML(streamText)}</pre>`);
      streamText = '';
    };
    kind.outputs.forEach(output => {
      if (output.output_type === 'stream') {
        streamText += outputText(output.text);
        return;
      }
      flushStream();
      if (output.output_type === 'error') {
        rendered.push(`<pre class="runtime-output error-output">${escapeHTML(outputText([`${output.ename || 'Error'}: ${output.evalue || ''}`, ...(output.traceback || [])].join('\n')))}</pre>`);
        return;
      }
      const dataframe = dataframeMarkup(output.data?.['text/html'], cellId);
      if (dataframe) {
        rendered.push(dataframe);
        return;
      }
      const text = outputText(output.data?.['text/plain']);
      if (text) rendered.push(`<pre class="runtime-output">${escapeHTML(text)}</pre>`);
    });
    flushStream();
    const content = rendered.join('');
    return content;
  }
  if (kind === 'query') return `<div class="query-output success">Query completed · 5 rows returned</div>`;
  if (kind === 'table') return `<div class="output-header"><strong>customers</strong><span>6 rows × 5 columns</span><div class="output-controls"><button>⌕ Search</button><button>⇅ Sort</button><button>▤ Explore</button></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th></th>${TABLE.columns.map(([name, type]) => `<th>${name}<span>${type}</span></th>`).join('')}</tr></thead><tbody>${TABLE.rows.map((row, index) => `<tr><td class="row-num">${index + 1}</td>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return '';
}
function updateRenderedCellOutput(cell) {
  const node = document.querySelector(`[data-id="${cell.id}"]`); if (!node) return;
  node.querySelector('.cell-output').innerHTML = cell.type === 'markdown' ? `<div class="markdown-render" tabindex="0">${markdownMarkup(cell.source)}</div>` : outputMarkup(cell.output, cell.id);
}
function updateRenderedRunState(cell) {
  const node = document.querySelector(`[data-id="${cell.id}"]`); if (!node) return;
  node.classList.toggle('running', Boolean(cell.running));
  const button = node.querySelector('.run-cell'); button.classList.toggle('is-running', Boolean(cell.running));
  button.title = cell.running ? 'Interrupt execution' : 'Run cell'; button.setAttribute('aria-label', button.title);
}
function dataframeMarkup(html, cellId = '') {
  if (!html) return '';
  const document = new DOMParser().parseFromString(outputText(html), 'text/html');
  const sourceTable = document.querySelector('table.dataframe');
  if (!sourceTable) return '';
  const renderRows = selector => [...sourceTable.querySelectorAll(selector)].map(row => `<tr>${[...row.cells].map((cell, index) => {
    const tag = cell.tagName.toLowerCase();
    const sort = tag === 'th' && row.parentElement.tagName === 'THEAD' && index ? ` data-sort-column="${index}" title="Sort by ${escapeHTML(cell.textContent || '')}"` : '';
    return `<${tag}${sort}>${escapeHTML(cell.textContent || '')}</${tag}>`;
  }).join('')}</tr>`).join('');
  const columnCount = sourceTable.querySelector('thead tr')?.cells.length ? sourceTable.querySelector('thead tr').cells.length - 1 : 0;
  const rowCount = sourceTable.querySelectorAll('tbody tr').length;
  return `<section class="dataframe-output"><header><strong>DataFrame</strong><span>${rowCount} rows × ${columnCount} columns</span><label class="dataframe-filter">⌕<input type="search" placeholder="Filter rows" aria-label="Filter DataFrame rows" /></label><button type="button" class="create-dataset" data-create-dataset-from-cell="${escapeHTML(cellId)}">Create dataset</button><button type="button" class="chart-dataframe">Chart</button><button type="button" class="explore-dataframe">Explore</button></header><div class="dataframe-table-wrap"><table class="rich-dataframe"><thead>${renderRows('thead tr')}</thead><tbody>${renderRows('tbody tr')}</tbody></table></div></section>`;
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
function captureScrollPositions() {
  const positions = [{ node: window, top: window.scrollY, left: window.scrollX }];
  let node = cellsEl.parentElement;
  while (node) {
    if (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) positions.push({ node, top: node.scrollTop, left: node.scrollLeft });
    node = node.parentElement;
  }
  return positions;
}
function restoreScrollPositions(positions) {
  positions.forEach(({ node, top, left }) => {
    if (node === window) window.scrollTo({ top, left, behavior: 'instant' });
    else { node.scrollTop = top; node.scrollLeft = left; }
  });
}
function renderCells() {
  const scrollPositions = captureScrollPositions();
  const editorApi = BetterNotebookEditor;
  editorApi.destroyAll();
  cellsEl.innerHTML = '';
  let collapsedAtLevel = 0;
  state.cells.forEach((data, index) => {
    const heading = data.type === 'markdown' ? data.source.match(/^(#{1,3})\s+/) : null;
    const headingLevel = heading ? heading[1].length : 0;
    if (headingLevel && headingLevel <= collapsedAtLevel) collapsedAtLevel = 0;
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = data.id; node.dataset.type = data.type; node.draggable = true;
    if (state.selected.has(data.id)) node.classList.add('selected');
    if (state.activeCellId === data.id) node.classList.add('active');
    if (data.running) node.classList.add('running');
    if (collapsedAtLevel) node.classList.add('section-hidden');
    const language = node.querySelector('.cell-language'); language.classList.add(data.type);
    const editorHost = node.querySelector('.code-editor');
    node.querySelector('.cell-check').checked = state.selected.has(data.id);
    node.querySelector('.cell-output').innerHTML = data.type === 'markdown' ? `<div class="markdown-render" tabindex="0">${markdownMarkup(data.source)}</div>` : outputMarkup(data.output, data.id);
    const diagnostic = node.querySelector('.cell-diagnostic'); diagnostic.hidden = !data.diagnostic; diagnostic.textContent = data.diagnostic ? `Line ${data.diagnostic.line || '?'}: ${data.diagnostic.message}` : '';
    const hasError = data.meta === 'Execution failed' || data.output?.outputs?.some(output => output.output_type === 'error');
    const meta = node.querySelector('.execution-meta-top'); meta.textContent = data.meta ? `${hasError ? '✕' : '✓'} ${data.meta}` : ''; if (data.meta) meta.classList.add(hasError ? 'error' : 'success');
    node.querySelector('.cell-footer').hidden = true;
    node.querySelector('.more-cell').setAttribute('aria-label', `More actions for cell ${index + 1}`);
    if (data.running) { const run = node.querySelector('.run-cell'); run.classList.add('is-running'); run.title = 'Interrupt execution'; run.setAttribute('aria-label', 'Interrupt execution'); }
    cellsEl.appendChild(node);
    editorApi.mount({
      id: data.id, parent: editorHost, source: data.source, type: data.type, datasets: DATASETS, symbols: () => symbolsBefore(data.id), connections: projectContext.connections,
      onChange: source => updateCell(data.id, { source }), onRun: () => runCell(data.id), onRunAndAdvance: () => runAndAdvance(data.id), onInspect: ({ code, pos }) => inspectInDssKernel(activeNotebook(), code, pos),
    });
    editorApi.setDiagnostic(data.id, data.diagnostic);
    const gap = document.createElement('div'); gap.className = 'cell-insert-gap'; gap.innerHTML = `<div class="insert-menu"><button data-insert-after="${data.id}" data-insert-type="python">+&nbsp; Code Cell</button><button data-insert-after="${data.id}" data-insert-type="markdown">+&nbsp; Markdown Cell</button></div>`; cellsEl.appendChild(gap);
    if (headingLevel && state.collapsedHeadings.has(data.id)) collapsedAtLevel = headingLevel;
  });
  renderToolbar(); renderOutline();
  requestAnimationFrame(() => restoreScrollPositions(scrollPositions));
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
    ? headings.map(heading => `<button class="outline-item level-${heading.level}" data-outline-id="${heading.id}"><span class="outline-section-toggle" data-collapse-heading="${heading.id}">${state.collapsedHeadings.has(heading.id) ? '›' : '⌄'}</span>${escapeHTML(heading.title)}</button>`).join('')
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
  dss.activeRuntimeId = notebook.runtimeId || dss.activeRuntimeId;
  renderRuntimeSelector();
}
function renderWorkspace() { renderProjectContext(); renderNotebookNavigation(); renderSqlConnectionSelector(); renderDatasets(); renderLinkedDatasets(); renderCells(); }
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
  if (notebook.remote) { renameRemoteNotebook(notebook); return; }
  if (title.querySelector('input')) return;
  title.innerHTML = `<input id="notebook-rename-input" value="${escapeHTML(notebook.name)}" aria-label="Notebook name" />`;
  const input = title.querySelector('input'); input.focus(); input.select();
  const commit = () => { const nextName = input.value.trim(); if (nextName) { notebook.name = nextName; notebook.updatedAt = Date.now(); persistNotebooks(); } renderNotebookNavigation(); };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); if (event.key === 'Escape') { input.value = notebook.name; input.blur(); } });
}
async function renameRemoteNotebook(notebook) {
  const nextName = window.prompt(`Rename “${notebook.name}”`, notebook.name)?.trim();
  if (!nextName || nextName === notebook.name) return;
  if (!window.confirm(`Rename “${notebook.name}” to “${nextName}”? DSS will copy the notebook, then remove the old notebook and any active session.`)) return;
  try {
    await flushDssSave(notebook);
    setSavedState('Renaming in DSS…');
    const payload = await dssRequest(`notebooks/${encodeURIComponent(notebook.name)}/rename`, { method: 'POST', body: JSON.stringify({ name: nextName }) });
    notebook.id = payload.name; notebook.name = payload.name; state.activeNotebookId = payload.name; state.notebooks.activeNotebookId = payload.name;
    renderWorkspace(); setSavedState('Renamed in DSS');
  } catch (error) { setSavedState(`DSS rename failed: ${error.message}`, true); console.warn(error); }
}
function renameNotebookInTree(id) {
  const notebook = state.notebooks.notebooks.find(item => item.id === id); const row = document.querySelector(`[data-drag-notebook-id="${id}"]`); if (!notebook || !row) return;
  if (notebook.remote) { renameRemoteNotebook(notebook); return; }
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
async function copyActiveNotebook() {
  const source = activeNotebook();
  if (source.remote) {
    const name = window.prompt(`Copy “${source.name}” as`, `Copy of ${source.name}`)?.trim();
    if (!name) return;
    try {
      await flushDssSave(source);
      setSavedState('Copying in DSS…');
      const payload = await dssRequest(`notebooks/${encodeURIComponent(source.name)}/copy`, { method: 'POST', body: JSON.stringify({ name }) });
      const copy = { id: name, name, language: 'PYTHON', cells: cellsFromDss(payload.notebook), open: true, updatedAt: Date.now(), folderId: source.folderId, remote: true, loaded: true, dssContent: payload.notebook, runtimeId: runtimeIdFor(payload.notebook.metadata?.kernelspec) };
      state.notebooks.notebooks.push(copy); await switchNotebook(copy.id); setSavedState('Copied in DSS');
    } catch (error) { setSavedState(`DSS copy failed: ${error.message}`, true); console.warn(error); }
    return;
  }
  const copy = { ...source, id: crypto.randomUUID(), name: `Copy of ${source.name}`, cells: cloneCells(source.cells), open: true, updatedAt: Date.now() }; state.notebooks.notebooks.push(copy); switchNotebook(copy.id);
}
async function deleteActiveNotebook() {
  const notebook = activeNotebook();
  if (notebook.remote) {
    const next = state.notebooks.notebooks.find(item => item.id !== notebook.id);
    if (!next) { setSavedState('Create another notebook before deleting the last open notebook'); return; }
    if (!window.confirm(`Permanently delete native DSS notebook “${notebook.name}”? This also stops active sessions.`)) return;
    try {
      clearTimeout(dssSaveTimer);
      setSavedState('Deleting from DSS…');
      await dssRequest(`notebooks/${encodeURIComponent(notebook.name)}`, { method: 'DELETE' });
      state.notebooks.notebooks = state.notebooks.notebooks.filter(item => item.id !== notebook.id);
      state.activeNotebookId = next.id; await switchNotebook(next.id); renderWorkspace(); setSavedState('Deleted from DSS');
    } catch (error) { setSavedState(`DSS delete failed: ${error.message}`, true); console.warn(error); }
    return;
  }
  if (!window.confirm(`Delete “${notebook.name}” from this prototype workspace?`)) return; state.notebooks.notebooks = state.notebooks.notebooks.filter(item => item.id !== notebook.id); if (!state.notebooks.notebooks.length) return; const next = state.notebooks.notebooks[0]; state.activeNotebookId = next.id; state.cells = next.cells; state.selected.clear(); state.activeCellId = null; resetHistory(); persistNotebooks(); renderWorkspace();
}
function addFolder() { const modal = document.querySelector('#folder-modal'); modal.classList.remove('hidden'); requestAnimationFrame(() => document.querySelector('#folder-name-input').focus()); }
function updateCell(id, patch) { const cell = getCell(id); Object.assign(cell, patch); save(); queuePythonCheck(cell); renderOutline(); renderLinkedDatasets(); }
function insertAfter(id, cell = newCell()) { state.cells.splice(cellIndex(id) + 1, 0, cell); save(); renderCells(); focusCell(cell.id); }
function focusCell(id, preventScroll = false) { requestAnimationFrame(() => BetterNotebookEditor.focus(id, preventScroll)); }
function setActiveCell(id) { state.activeCellId = id; document.querySelectorAll('.cell.active').forEach(cell => cell.classList.remove('active')); document.querySelector(`[data-id="${id}"]`)?.classList.add('active'); }
async function runCell(id) {
  const cell = getCell(id); if (!cell) return;
  if (dss.loading || (activeNotebook().remote && !dss.workspaceLoaded)) { setSavedState('Waiting for the native DSS notebook to finish loading…'); return false; }
  state.activeCellId = id;
  if (cell.type === 'markdown') { cell.meta = 'Rendered just now'; save(); renderCells(); return true; }
  if (!activeNotebook().remote) { cell.meta = `Ran just now · ${cell.type === 'sql' ? '0.18' : '0.24'}s`; cell.output = cell.type === 'sql' ? 'query' : 'table'; save(); renderCells(); return true; }
  const started = performance.now(); cell.meta = 'Running…'; cell.running = true; renderCells();
  try {
    const source = cell.type === 'sql' ? sqlExecutionSource(cell.source) : cell.source;
    const result = await executeInDssKernel(activeNotebook(), source, outputs => {
      cell.output = { outputs: [...outputs] }; updateRenderedCellOutput(cell);
    });
    cell.output = { outputs: result.outputs };
    cell.dssCell = { ...(cell.dssCell || {}), outputs: result.outputs, execution_count: result.executionCount };
    const failed = result.outputs.some(output => output.output_type === 'error');
    cell.meta = failed ? 'Execution failed' : `Ran just now · ${((performance.now() - started) / 1000).toFixed(2)}s`;
    cell.running = false; save(); renderCells(); setSavedState(failed ? 'Execution failed' : 'Executed in DSS', failed); return !failed;
  } catch (error) {
    cell.running = false; cell.meta = 'Execution failed'; cell.output = { outputs: [{ output_type: 'error', ename: 'DSS execution error', evalue: error.message, traceback: [] }] };
    renderCells(); setSavedState(`Execution failed: ${error.message}`, true); console.warn(error); return false;
  }
}
async function runAndAdvance(id) {
  const nextId = state.cells[cellIndex(id) + 1]?.id;
  const succeeded = await runCell(id);
  if (!succeeded) return;
  if (nextId) { setActiveCell(nextId); focusCell(nextId); return; }
  const newCodeCell = newCell('python'); newCodeCell.source = ''; state.cells.push(newCodeCell); state.activeCellId = newCodeCell.id; save(); renderCells(); focusCell(newCodeCell.id, true);
}
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
  if (event.target.closest('.run-cell')) {
    const current = getCell(id);
    if (current.running) interruptDssExecution().catch(error => setSavedState(`Interrupt failed: ${error.message}`, true));
    else runCell(id);
  }
  if (event.target.closest('.delete-cell')) { state.selected = new Set([id]); deleteSelected(); }
  if (event.target.closest('.cell-type-selector')) { cell.querySelector('.cell-type').classList.toggle('open'); }
  const typeOption = event.target.closest('[data-cell-type]');
  if (typeOption) { const target = getCell(id); target.type = typeOption.dataset.cellType; target.output = ''; target.meta = ''; save(); queuePythonCheck(target); renderCells(); }
  if (event.target.closest('.markdown-render')) { const renderer = event.target.closest('.markdown-render'); renderer.classList.add('editing'); cell.querySelector('.code-editor').classList.add('editing'); focusCell(id); }
});
cellsEl.addEventListener('focusin', event => { const cell = event.target.closest('.cell'); if (cell) setActiveCell(cell.dataset.id); });
cellsEl.addEventListener('focusout', event => { const editor = event.target.closest?.('.code-editor.editing'); if (editor && !editor.contains(event.relatedTarget)) { editor.classList.remove('editing'); editor.closest('.cell').querySelector('.markdown-render')?.classList.remove('editing'); } });
cellsEl.addEventListener('click', event => { const button = event.target.closest('[data-insert-after]'); if (button) insertAfter(button.dataset.insertAfter, newCell(button.dataset.insertType)); });
cellsEl.addEventListener('dragstart', event => { const cell = event.target.closest('.cell'); if (!cell || event.target.closest('.code-editor')) { event.preventDefault(); return; } state.dragId = cell.dataset.id; cell.classList.add('dragging'); });
cellsEl.addEventListener('dragover', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell && cell.dataset.id !== state.dragId) cell.classList.add('drop-target'); });
cellsEl.addEventListener('dragleave', event => event.target.closest('.cell')?.classList.remove('drop-target'));
cellsEl.addEventListener('drop', event => { event.preventDefault(); const cell = event.target.closest('.cell'); if (cell) moveCell(state.dragId, cell.dataset.id); });
cellsEl.addEventListener('dragend', () => { state.dragId = null; document.querySelectorAll('.cell').forEach(cell => cell.classList.remove('dragging', 'drop-target')); });

function renderExecutionControls() {
  document.querySelector('#run-all').disabled = execution.runningAll;
  document.querySelector('#run-all').innerHTML = execution.runningAll ? '<span>◌</span> Running all' : '<span>▶</span> Run all';
  document.querySelector('#stop-run-all').classList.toggle('hidden', !execution.runningAll);
}
document.querySelector('#run-all').addEventListener('click', async () => {
  if (execution.runningAll) return;
  execution.runningAll = true; execution.stopRequested = false; renderExecutionControls();
  let ran = 0;
  for (const cell of state.cells) {
    if (execution.stopRequested) break;
    const succeeded = await runCell(cell.id); ran += 1;
    if (!succeeded) { setSavedState(`Run all stopped after cell ${ran} because it failed`, true); break; }
  }
  if (execution.stopRequested) setSavedState(`Run all stopped after ${ran} cell${ran === 1 ? '' : 's'}`);
  execution.runningAll = false; renderExecutionControls();
});
document.querySelector('#stop-run-all').addEventListener('click', () => { execution.stopRequested = true; setSavedState('Stopping after the current cell…'); });
document.querySelector('#dataset-search').addEventListener('input', event => renderDatasets(event.target.value));
document.querySelector('#refresh-datasets').addEventListener('click', loadProjectContext);
document.querySelector('#executor-selector').addEventListener('change', event => {
  dss.activeRuntimeId = event.target.value;
  const notebook = activeNotebook();
  if (dss.enabled && notebook?.remote) {
    notebook.runtimeId = dss.activeRuntimeId;
    save(false);
    setSavedState('Saving Python environment to DSS…');
  } else if (dss.enabled) setSavedState('Runtime selected for the next DSS notebook');
});
document.querySelector('#sql-executor-selector').addEventListener('change', event => {
  projectContext.sqlConnection = event.target.value;
  if (projectContext.sqlConnection) projectContext.managedConnection = projectContext.sqlConnection;
  setSavedState(projectContext.sqlConnection ? `SQL connection: ${projectContext.sqlConnection}` : 'No SQL connection selected');
});
document.querySelector('#dataset-list').addEventListener('click', event => { const dataset = event.target.closest('[data-dataset]'); if (dataset) selectDataset(dataset.dataset.dataset); });
document.querySelector('#dataset-inspector').addEventListener('click', event => {
  const python = event.target.closest('[data-insert-dataset]'); if (python) { const dataset = DATASETS.find(item => item.name === python.dataset.insertDataset); if (dataset) insertDatasetCell(dataset); return; }
  const sql = event.target.closest('[data-insert-dataset-sql]'); if (sql) { const dataset = DATASETS.find(item => item.name === sql.dataset.insertDatasetSql); if (dataset) insertDatasetCell(dataset, 'sql'); }
});
document.querySelector('#new-notebook-button').addEventListener('click', async () => {
  if (dss.enabled) {
    const name = `Untitled notebook ${state.notebooks.notebooks.length + 1}`;
    setSavedState('Creating notebook in DSS…');
    try {
      const payload = await dssRequest('notebooks', { method: 'POST', body: JSON.stringify({ name, runtimeId: dss.activeRuntimeId }) });
      const notebook = {
        id: name, name, language: 'PYTHON', cells: cellsFromDss(payload.notebook), open: true,
        updatedAt: Date.now(), folderId: null, remote: true, loaded: true, dssContent: payload.notebook,
        runtimeId: runtimeIdFor(payload.notebook.metadata?.kernelspec),
      };
      state.notebooks.notebooks.push(notebook); state.activeNotebookId = notebook.id; state.cells = notebook.cells;
      state.selected.clear(); state.activeCellId = notebook.cells[0]?.id || null; resetHistory(); renderWorkspace();
      setSavedState('Created in DSS'); if (notebook.cells[0]) focusCell(notebook.cells[0].id);
    } catch (error) { setSavedState(`Create failed: ${error.message}`, true); console.warn(error); }
    return;
  }
  const number = state.notebooks.notebooks.length + 1; const notebook = { id: crypto.randomUUID(), name: `Untitled notebook ${number}`, language: 'PYTHON', cells: [newCell('python')], open: true, updatedAt: Date.now(), folderId: null }; notebook.cells[0].source = ''; state.notebooks.notebooks.push(notebook); state.activeNotebookId = notebook.id; state.cells = notebook.cells; state.selected.clear(); state.activeCellId = notebook.cells[0].id; resetHistory(); persistNotebooks(); renderWorkspace(); focusCell(notebook.cells[0].id);
});
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
document.querySelector('#data-panel-toggle').addEventListener('click', event => {
  const shell = document.querySelector('.app-shell'); const collapsed = shell.classList.toggle('data-panel-collapsed');
  event.currentTarget.setAttribute('aria-pressed', String(collapsed));
  event.currentTarget.setAttribute('aria-label', collapsed ? 'Show project datasets' : 'Hide project datasets');
  event.currentTarget.title = collapsed ? 'Show project datasets' : 'Hide project datasets';
  event.currentTarget.textContent = collapsed ? '▰' : '▱';
});
const folderModal = document.querySelector('#folder-modal');
const closeFolderModal = () => { folderModal.classList.add('hidden'); document.querySelector('#folder-form').reset(); };
document.querySelector('#close-folder-modal').addEventListener('click', closeFolderModal);
document.querySelector('#cancel-folder').addEventListener('click', closeFolderModal);
folderModal.addEventListener('click', event => { if (event.target === folderModal) closeFolderModal(); });
document.querySelector('#folder-form').addEventListener('submit', event => { event.preventDefault(); const name = document.querySelector('#folder-name-input').value.trim(); if (!name) return; state.notebooks.folders.push({ id: crypto.randomUUID(), name }); persistNotebooks(); renderNotebookNavigation(); closeFolderModal(); });
document.querySelector('#outline-toggle').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('outline-collapsed'));
document.querySelector('#outline-list').addEventListener('click', event => {
  const collapsed = event.target.closest('[data-collapse-heading]');
  if (collapsed) { const id = collapsed.dataset.collapseHeading; state.collapsedHeadings.has(id) ? state.collapsedHeadings.delete(id) : state.collapsedHeadings.add(id); renderCells(); return; }
  document.querySelector(`[data-id="${event.target.closest('[data-outline-id]')?.dataset.outlineId}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
});
document.querySelector('#dismiss-notice').addEventListener('click', event => event.target.closest('.notice').remove());
function filterDataframe(section, query) {
  const normalized = query.trim().toLowerCase();
  section.querySelectorAll('tbody tr').forEach(row => { row.hidden = Boolean(normalized) && !row.textContent.toLowerCase().includes(normalized); });
}
function sortDataframe(table, column) {
  const body = table.tBodies[0]; const rows = [...body.rows];
  const direction = table.dataset.sortColumn === String(column) && table.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
  rows.sort((left, right) => left.cells[column].textContent.localeCompare(right.cells[column].textContent, undefined, { numeric: true }));
  if (direction === 'desc') rows.reverse(); rows.forEach(row => body.append(row));
  table.dataset.sortColumn = String(column); table.dataset.sortDirection = direction;
}
function chartDataframe(section) {
  const existing = section.querySelector('.dataframe-chart'); if (existing) { existing.remove(); return; }
  const table = section.querySelector('table'); const headers = [...table.tHead.rows[0].cells].slice(1).map(cell => cell.textContent);
  const rows = [...table.tBodies[0].rows].slice(0, 12).filter(row => !row.hidden);
  const numericColumn = headers.findIndex((_, index) => rows.some(row => Number.parseFloat(row.cells[index + 1]?.textContent.replace(/[^0-9.-]/g, '')) === Number.parseFloat(row.cells[index + 1]?.textContent.replace(/[^0-9.-]/g, ''))));
  if (numericColumn < 0 || !rows.length) { setSavedState('No numeric column is available for a quick chart', true); return; }
  const values = rows.map(row => Number.parseFloat(row.cells[numericColumn + 1].textContent.replace(/[^0-9.-]/g, '')) || 0); const max = Math.max(...values, 1);
  const categoryColumn = headers.findIndex((_, index) => index !== numericColumn && rows.some(row => row.cells[index + 1]?.textContent));
  const chart = document.createElement('div'); chart.className = 'dataframe-chart';
  chart.innerHTML = `<strong>${escapeHTML(headers[numericColumn])}</strong>${rows.map((row, index) => `<div><span title="${escapeHTML(categoryColumn >= 0 ? row.cells[categoryColumn + 1].textContent : String(index + 1))}">${escapeHTML(categoryColumn >= 0 ? row.cells[categoryColumn + 1].textContent : String(index + 1))}</span><i><b style="width:${Math.max(2, values[index] / max * 100)}%"></b></i><em>${escapeHTML(String(values[index]))}</em></div>`).join('')}`;
  section.append(chart);
}
async function createDatasetFromDataframe(cellId) {
  if (!dss.enabled || !projectContext.isDss) { setSavedState('Create datasets is available inside DSS', true); return; }
  const cell = getCell(cellId);
  const inferred = cell?.source.match(/([A-Za-z_]\w*)\.(?:head|tail|sample|describe)\s*\(/)?.[1]
    || cell?.source.match(/^\s*([A-Za-z_]\w*)\s*=/m)?.[1] || 'df';
  const datasetName = window.prompt(`Create a managed dataset from ${inferred}`, `${inferred}_output`)?.trim();
  if (!datasetName) return;
  try {
    setSavedState('Creating managed dataset in DSS…');
    await dssRequest('datasets', { method: 'POST', body: JSON.stringify({ name: datasetName, connection: projectContext.managedConnection }) });
    const writeCell = newCell('python');
    writeCell.source = `# Materialize ${inferred} as the managed dataset ${datasetName}\noutput_dataset = dataiku.Dataset("${datasetName}")\noutput_dataset.write_with_schema(${inferred})`;
    insertAfter(cellId, writeCell);
    await loadProjectContext();
    setSavedState(`Created ${datasetName}; run the inserted write cell to populate it`);
  } catch (error) { setSavedState(`Dataset creation failed: ${error.message}`, true); console.warn(error); }
}
cellsEl.addEventListener('input', event => { const filter = event.target.closest('.dataframe-filter input'); if (filter) filterDataframe(filter.closest('.dataframe-output'), filter.value); });
cellsEl.addEventListener('click', event => {
  const header = event.target.closest('[data-sort-column]'); if (header) { sortDataframe(header.closest('table'), Number(header.dataset.sortColumn)); return; }
  const createDataset = event.target.closest('[data-create-dataset-from-cell]'); if (createDataset) { createDatasetFromDataframe(createDataset.dataset.createDatasetFromCell); return; }
  const chart = event.target.closest('.chart-dataframe'); if (chart) { chartDataframe(chart.closest('.dataframe-output')); return; }
  const explore = event.target.closest('.explore-dataframe'); if (explore) { const section = explore.closest('.dataframe-output'); document.querySelector('#dataframe-modal-content').innerHTML = section.outerHTML; document.querySelector('#dataframe-modal').classList.remove('hidden'); }
});
const dataframeModal = document.querySelector('#dataframe-modal');
const closeDataframeModal = () => dataframeModal.classList.add('hidden');
document.querySelector('#close-dataframe-modal').addEventListener('click', closeDataframeModal);
dataframeModal.addEventListener('click', event => { if (event.target === dataframeModal) closeDataframeModal(); });
document.querySelector('#cell-search').addEventListener('input', event => {
  state.searchQuery = event.target.value.trim().toLowerCase(); state.searchIndex = 0;
  const matches = state.cells.filter(cell => state.searchQuery && cell.source.toLowerCase().includes(state.searchQuery));
  document.querySelector('#cell-search-count').textContent = state.searchQuery ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : '';
  document.querySelectorAll('.cell.search-match').forEach(cell => cell.classList.remove('search-match'));
  matches.forEach(cell => document.querySelector(`[data-id="${cell.id}"]`)?.classList.add('search-match'));
  if (matches[0]) document.querySelector(`[data-id="${matches[0].id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#cell-search').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !state.searchQuery) return;
  const matches = state.cells.filter(cell => cell.source.toLowerCase().includes(state.searchQuery)); if (!matches.length) return;
  event.preventDefault(); state.searchIndex = (state.searchIndex + 1) % matches.length;
  document.querySelector(`[data-id="${matches[state.searchIndex].id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#batch-toolbar').addEventListener('click', event => { const action = event.target.dataset.batchAction; if (!action) return; if (action === 'run') state.selected.forEach(runCell); if (action === 'duplicate') duplicateSelected(); if (action === 'copy') copySelected(); if (action === 'cut') copySelected(true); if (action === 'delete') deleteSelected(); if (action === 'clear') { state.selected.clear(); renderCells(); } });
document.querySelector('.workspace').addEventListener('click', event => { if (!state.selected.size || event.target.closest('.cell, button, textarea, input, .batch-toolbar')) return; state.selected.clear(); renderCells(); });
const settingsModal = document.querySelector('#settings-modal');
const closeSettings = () => settingsModal.classList.add('hidden');
document.querySelector('#settings-button').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.querySelector('#close-settings').addEventListener('click', closeSettings);
document.querySelector('#done-settings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', event => { if (event.target === settingsModal) closeSettings(); });
document.addEventListener('keydown', async event => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') { closeSettings(); closeFolderModal(); closeDataframeModal(); return; }
  if (event.shiftKey && event.key === 'Enter' && !event.isComposing) { if (event.target.closest?.('.cm-editor')) return; event.preventDefault(); const cell = document.activeElement.closest?.('.cell'); if (cell) await runAndAdvance(cell.dataset.id); return; }
  // A focused CodeMirror editor owns its own undo stack. Let it handle Cmd/Ctrl+Z
  // so the edit is undone in place and the cursor never leaves the cell.
  if (mod && event.key.toLowerCase() === 'z' && event.target.closest?.('.cm-editor')) return;
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); if (state.activeCellId) focusCell(state.activeCellId, true); return; }
  if (mod && event.key === 'Enter') { if (event.target.closest?.('.cm-editor')) return; event.preventDefault(); (state.selected.size ? [...state.selected] : [document.activeElement.closest?.('.cell')?.dataset.id]).filter(Boolean).forEach(runCell); }
  if (mod && event.key.toLowerCase() === 'c' && state.selected.size) { event.preventDefault(); copySelected(); }
  if (mod && event.key.toLowerCase() === 'x' && state.selected.size) { event.preventDefault(); copySelected(true); }
  if (mod && event.key.toLowerCase() === 'v' && state.clipboard.length && !document.activeElement.matches('.code-input')) { event.preventDefault(); pasteCells(); }
  if (event.key === 'Backspace' && state.selected.size && !document.activeElement.matches('.code-input')) { event.preventDefault(); deleteSelected(); }
});

async function startDssIntegration() {
  dss.loading = true;
  setSavedState('Connecting to DSS project…');
  const deadline = Date.now() + 5000;
  while (!isDssWebappRuntime() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (!isDssWebappRuntime()) {
    dss.loading = false;
    setSavedState('DSS bridge unavailable — native project data was not loaded', true);
    return;
  }
  await Promise.all([loadProjectContext(), loadDssWorkspace()]);
}
state.activeNotebookId = state.notebooks.activeNotebookId || state.notebooks.notebooks[0].id;
state.cells = activeNotebook().cells;
// Start native discovery before constructing editors. A third-party editor
// rendering failure must never leave the page looking like browser preview
// while silently preventing the DSS project handshake.
resetHistory(); startDssIntegration(); renderWorkspace(); renderExecutionControls();
