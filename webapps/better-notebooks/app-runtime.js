import * as BetterNotebookEditor from './editor.js';
import { hydrateRichMime, renderRichMime } from './mime-renderers.js';
import { createNotebookState, recordHistory, resetHistory as resetNotebookHistory, restoreHistory } from './notebook-state.js';
import { compareCells, loadDraft, removeDraft, saveDraft } from './recovery-drafts.js';
import { pythonExport } from './modules/notebook-export.js';
import { jupyterMessage as makeJupyterMessage, jupyterOutput as parseJupyterOutput } from './modules/kernel-protocol.js';
import { captureScrollPositions as captureRenderScroll, restoreScrollPositions as restoreRenderScroll } from './modules/rendering.js';
import { datasetVariableName as datasetVariable, linkedDatasets as findLinkedDatasets } from './modules/dataset-integration.js';
import { nativeDisplayMetadata, saveStatus } from './modules/dss-persistence.js';
import { sectionModel } from './modules/markdown-sections.js';
import { renderMarkdown } from './modules/markdown-renderer.js';

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
let lastSuccessfulSaveAt = null;
let saveFailure = null;
let selectedDatasetName = '';
const diagnosticsTimers = new Map();
let pendingRecovery = null;

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

const state = createNotebookState(loadNotebooks());
const execution = { runningAll: false, stopRequested: false };
const dragScroll = { frame: 0, pointerY: null, container: null };
const pointerDrag = { active: false, candidate: null, preview: null, dropIndex: null };
const aiAssistant = { models: [], modelId: String(webappConfig.coding_llm_id || localStorage.getItem(storageKey('coding-llm-id')) || ''), available: false };
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
function savedNotebookLayout() {
  try { return JSON.parse(localStorage.getItem(storageKey('notebooks'))) || {}; }
  catch { return {}; }
}
function resetHistory() { resetNotebookHistory(state); }
async function switchNotebook(id) {
  const notebook = state.notebooks.notebooks.find(item => item.id === id); if (!notebook || id === state.activeNotebookId) return;
  if (notebook.remote && !notebook.loaded) {
    setSavedState('Loading notebook from DSS…');
    try { await loadDssNotebook(notebook); }
    catch (error) { setSavedState('DSS notebook load failed', true); console.warn(error); return; }
  }
  notebook.open = true; state.activeNotebookId = id; state.notebooks.activeNotebookId = id; state.cells = notebook.cells; state.selected.clear(); state.activeCellId = null; dss.activeRuntimeId = notebook.runtimeId || 'dss_builtin'; resetHistory(); if (!notebook.remote) persistNotebooks(); renderWorkspace(); window.scrollTo({ top: 0, behavior: 'instant' });
}
function persistNotebooks() {
  // Native cells are authoritative in DSS. Persist only their local display
  // metadata so reloads retain folders without risking stale notebook content.
  const notebooks = state.notebooks.notebooks.map(notebook => notebook.remote
    ? nativeDisplayMetadata(notebook)
    : notebook);
  localStorage.setItem(storageKey('notebooks'), JSON.stringify({ ...state.notebooks, notebooks }));
}
function draftKey(notebook = activeNotebook()) { return storageKey(`draft-${notebook?.id || 'none'}`); }
function persistDraft(notebook = activeNotebook()) { if (notebook) saveDraft(localStorage, draftKey(notebook), state.cells); }
function clearDraft(notebook = activeNotebook()) { if (notebook) removeDraft(localStorage, draftKey(notebook)); }
function save(shouldRecordHistory = true) {
  const notebook = activeNotebook();
  notebook.cells = state.cells; notebook.updatedAt = Date.now(); state.notebooks.activeNotebookId = state.activeNotebookId;
  if (!notebook.remote) persistNotebooks();
  persistDraft(notebook);
  if (shouldRecordHistory) {
    const snapshot = JSON.stringify(state.cells);
    if (state.history[state.historyIndex] !== snapshot) {
      recordHistory(state);
    }
  }
  if (notebook.remote && !dss.workspaceLoaded) {
    setSavedState('Waiting for the DSS notebook to load before saving…');
  } else if (notebook.remote) queueDssSave(notebook);
  else setSavedState('Saved locally');
}
function undo() {
  if (!restoreHistory(state)) return;
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
async function dssStreamRequest(path, body, onEvent) {
  const response = await fetch(dssBackendUrl(path), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `DSS request failed (${response.status})`);
  }
  if (!response.body) throw new Error('The browser does not support streamed LLM responses.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const consume = raw => {
    const lines = raw.split('\n'); const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (data) onEvent(event, JSON.parse(data));
  };
  while (true) {
    const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf('\n\n'); }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
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
  if (request.kind === 'complete') {
    if (message.header?.msg_type === 'complete_reply') {
      clearTimeout(request.timeout); kernel.pending.delete(message.parent_header?.msg_id);
      request.resolve({ matches: message.content?.matches || [], cursorStart: message.content?.cursor_start });
    }
    return;
  }
  const output = parseJupyterOutput(message);
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
  await configureKernelDisplay(notebook, kernel);
  setKernelStatus('Connected', 'connected');
  return kernel;
}
async function configureKernelDisplay(notebook, kernel) {
  if (kernel.displayConfigured) return;
  kernel.displayConfigured = true;
  try {
    await executeInDssKernel(notebook, "try:\n    from IPython import get_ipython\n    get_ipython().run_line_magic('matplotlib', 'inline')\nexcept Exception:\n    pass", null, { silent: true, timeout: 8000 });
  } catch (error) {
    // The standard MIME renderer still supports Plotly, Vega, and images when
    // Matplotlib is unavailable in the selected code environment.
    console.warn('Could not configure Matplotlib inline output.', error);
  }
}
async function executeInDssKernel(notebook, source, onOutput, options = {}) {
  const kernel = await connectDssKernel(notebook);
  const message = makeJupyterMessage('execute_request', {
    code: source, silent: Boolean(options.silent), store_history: !options.silent, user_expressions: {}, allow_stdin: false, stop_on_error: true,
  }, kernel.sessionId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      kernel.pending.delete(message.header.msg_id);
      reject(new Error(`Cell execution timed out after ${(options.timeout || 90000) / 1000} seconds.`));
    }, options.timeout || 90000);
    kernel.pending.set(message.header.msg_id, { outputs: [], executionCount: null, resolve, reject, timeout, onOutput });
    setKernelStatus('Running…', 'busy');
    kernel.socket.send(JSON.stringify({ ...message, channel: 'shell' }));
  });
}
async function inspectInDssKernel(notebook, code, cursorPos) {
  // Keep hover passive: only inspect an already-running notebook kernel.
  const kernel = dss.kernel;
  if (!kernel || kernel.notebookId !== notebook.id || kernel.socket.readyState !== WebSocket.OPEN) return '';
  const message = makeJupyterMessage('inspect_request', { code, cursor_pos: cursorPos, detail_level: 0 }, kernel.sessionId);
  return new Promise(resolve => {
    const timeout = setTimeout(() => { kernel.pending.delete(message.header.msg_id); resolve(''); }, 2500);
    kernel.pending.set(message.header.msg_id, { kind: 'inspect', resolve, timeout });
    kernel.socket.send(JSON.stringify({ ...message, channel: 'shell' }));
  });
}
async function completeInDssKernel(notebook, code, cursorPos) {
  const kernel = dss.kernel;
  if (!kernel || kernel.notebookId !== notebook.id || kernel.socket.readyState !== WebSocket.OPEN) return { matches: [] };
  const message = makeJupyterMessage('complete_request', { code, cursor_pos: cursorPos }, kernel.sessionId);
  return new Promise(resolve => {
    const timeout = setTimeout(() => { kernel.pending.delete(message.header.msg_id); resolve({ matches: [] }); }, 1400);
    kernel.pending.set(message.header.msg_id, { kind: 'complete', resolve, timeout });
    kernel.socket.send(JSON.stringify({ ...message, channel: 'shell' }));
  });
}
async function interruptDssExecution() {
  if (!dss.kernel?.kernelId) return;
  setKernelStatus('Interrupting…', 'busy');
  await jupyterRequest(`api/kernels/${encodeURIComponent(dss.kernel.kernelId)}/interrupt`, { method: 'POST', body: '{}' });
  state.cells.filter(cell => executionState(cell).status === 'running').forEach(cell => {
    cell.running = false;
    setExecution(cell, { status: 'interrupted', finishedAt: Date.now(), durationMs: Date.now() - (executionState(cell).startedAt || Date.now()) });
  });
  save(); renderCells();
}
function setSavedState(message, isError = false) {
  const status = document.querySelector('#saved-state');
  status.textContent = message;
  status.classList.toggle('error', isError);
  document.querySelector('#retry-save')?.classList.toggle('hidden', !isError);
}
function markSaveSuccessful(message = 'Saved to DSS') {
  lastSuccessfulSaveAt = Date.now(); saveFailure = null;
  setSavedState(saveStatus(message, lastSuccessfulSaveAt));
}
function sourceText(source) { return Array.isArray(source) ? source.join('') : String(source || ''); }
function outputText(value) {
  // Jupyter tracebacks can retain ANSI terminal colour sequences. They are not
  // useful in a browser output block and make long tracebacks unreadable.
  return sourceText(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
function sourceLines(source) { return source ? source.match(/[^\n]*\n|[^\n]+/g) || [] : []; }
function executionState(cell) {
  const existing = cell.execution || {};
  if (existing.status) return existing;
  const hasError = cell.output?.outputs?.some(output => output.output_type === 'error') || cell.dssCell?.outputs?.some(output => output.output_type === 'error');
  if (cell.dssCell?.execution_count || cell.meta?.startsWith('Previously run') || cell.meta?.startsWith('Ran just now')) {
    return { status: hasError ? 'failed' : 'succeeded', order: cell.dssCell?.execution_count || null, finishedAt: null, durationMs: null };
  }
  return { status: 'never', order: null, startedAt: null, finishedAt: null, durationMs: null };
}
function setExecution(cell, patch) { cell.execution = { ...executionState(cell), ...patch }; }
function timeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'Ran just now';
  if (seconds < 60) return `Ran ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Ran ${minutes}m ago`;
  return `Ran ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
function executionLabel(cell) {
  const detail = executionState(cell);
  if (detail.status === 'never') return '';
  if (detail.status === 'queued') return 'Queued';
  if (detail.status === 'running') return `Running · started ${new Date(detail.startedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  if (detail.status === 'interrupted') return 'Interrupted';
  const time = timeAgo(detail.finishedAt) || (detail.status === 'failed' ? 'Execution failed' : 'Previously run');
  const duration = Number.isFinite(detail.durationMs) ? ` · (${(detail.durationMs / 1000).toFixed(2)}s)` : '';
  const order = detail.order ? ` · #${detail.order}` : '';
  return `${time}${duration}${order}`;
}
function executionIcon(status) {
  return status === 'succeeded' ? '✓' : status === 'failed' ? '✕' : status === 'interrupted' ? '■' : status === 'queued' ? '◌' : '';
}
function nextExecutionOrder() {
  const seen = state.cells.reduce((maximum, cell) => Math.max(maximum, Number(executionState(cell).order) || 0), 0);
  state.nextExecutionOrder = Math.max(state.nextExecutionOrder || 1, seen + 1);
  return state.nextExecutionOrder++;
}
function dssDocumentFor(notebook) {
  const document = structuredClone(notebook.dssContent || { nbformat: 4, nbformat_minor: 5, metadata: {} });
  document.metadata = document.metadata || {};
  const runtime = dss.runtimes.find(item => item.id === notebook.runtimeId);
  if (runtime?.kernelSpec) document.metadata.kernelspec = runtime.kernelSpec;
  document.cells = notebook.cells.map(cell => {
    const metadata = { ...(cell.dssCell?.metadata || {}) };
    metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), execution: executionState(cell) };
    if (cell.type === 'sql') metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), cellType: 'sql' };
    else if (metadata.betterNotebooks?.cellType === 'sql') delete metadata.betterNotebooks.cellType;
    if (cell.type === 'markdown') metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), collapsed: Boolean(cell.collapsed) };
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
  clearDraft(notebook);
}
function queueDssSave(notebook) {
  clearTimeout(dssSaveTimer); setSavedState('Saving to DSS…');
  dssSaveTimer = setTimeout(async () => {
    try { await saveDssNotebook(notebook); markSaveSuccessful(); }
    catch (error) { saveFailure = error; setSavedState(`Save failed — retry`, true); console.warn(error); }
  }, 650);
}
async function flushDssSave(notebook) {
  clearTimeout(dssSaveTimer);
  setSavedState('Saving to DSS…');
  await saveDssNotebook(notebook); markSaveSuccessful();
}
function queuePythonCheck(cell) {
  if (!dss.enabled || cell.type !== 'python') return;
  clearTimeout(diagnosticsTimers.get(cell.id));
  diagnosticsTimers.set(cell.id, setTimeout(async () => {
    try {
      const result = await dssRequest('python-check', { method: 'POST', body: JSON.stringify({ source: cell.source }) });
      cell.diagnostic = result.valid ? null : result;
    } catch (error) { cell.diagnostic = { message: 'Syntax check unavailable' }; }
    BetterNotebookEditor.setDiagnostic(cell.id, [...(cell.diagnostic ? [cell.diagnostic] : []), ...staticDiagnostics(cell.id)]);
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
    execution: cell.metadata?.betterNotebooks?.execution || (cell.execution_count ? { status: cell.outputs?.some(output => output.output_type === 'error') ? 'failed' : 'succeeded', order: cell.execution_count, startedAt: null, finishedAt: null, durationMs: null } : { status: 'never', order: null, startedAt: null, finishedAt: null, durationMs: null }),
    collapsed: Boolean(cell.metadata?.betterNotebooks?.collapsed),
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
  const draft = loadDraft(localStorage, draftKey(notebook));
  if (draft?.cells?.length) showRecoveryChoice(notebook, draft, notebook.cells);
}
function showRecoveryChoice(notebook, draft, dssCells) {
  const changes = compareCells(draft.cells, dssCells);
  if (!changes.length) { clearDraft(notebook); return; }
  pendingRecovery = { notebook, draft, dssCells, changes };
  document.querySelector('#recovery-summary').textContent = `A local draft saved ${new Date(draft.savedAt).toLocaleString()} differs from the current DSS notebook (${changes.length} changed cell${changes.length === 1 ? '' : 's'}).`;
  document.querySelector('#recovery-diff-list').innerHTML = changes.map(change => `<li>${escapeHTML(change.summary)}</li>`).join('');
  document.querySelector('#recovery-modal').classList.remove('hidden');
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
    const savedLayout = savedNotebookLayout();
    const folderByNotebookId = new Map((savedLayout.notebooks || []).map(item => [item.id, item.folderId ?? null]));
    const notebooks = (notebookPayload.notebooks || []).map((item, index) => ({
      id: item.name, name: item.name, language: 'PYTHON', cells: [], open: index === 0,
      updatedAt: 0, folderId: folderByNotebookId.get(item.name) ?? null, remote: true, loaded: false, runtimeId: runtimeIdFor(item.kernelSpec),
    }));
    if (!notebooks.length) {
      dss.loading = false; dss.workspaceLoaded = true;
      setSavedState('No DSS notebooks yet');
      renderRuntimeSelector();
      return;
    }
    state.notebooks = { activeNotebookId: notebooks[0].id, folders: savedLayout.folders ?? [], notebooks };
    state.activeNotebookId = notebooks[0].id;
    await loadDssNotebook(notebooks[0]);
    state.cells = notebooks[0].cells;
    dss.activeRuntimeId = notebooks[0].runtimeId;
    dss.loading = false; dss.workspaceLoaded = true; resetHistory(); persistNotebooks(); renderRuntimeSelector(); renderWorkspace();
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
function newCell(type = 'python') { return { id: crypto.randomUUID(), type, source: type === 'markdown' ? '## New section' : type === 'sql' ? 'SELECT *\nFROM customers_enriched\nLIMIT 100' : '', meta: '', execution: { status: 'never', order: null, startedAt: null, finishedAt: null, durationMs: null } }; }

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
function staticDiagnostics(cellId) {
  const cell = getCell(cellId); if (!cell || cell.type !== 'python') return [];
  const known = new Set(symbolsBefore(cellId).map(item => item.name));
  const builtin = new Set(['True', 'False', 'None', 'print', 'len', 'range', 'list', 'dict', 'set', 'str', 'int', 'float', 'sum', 'min', 'max', 'enumerate', 'zip']);
  const declared = new Set(); const findings = [];
  cell.source.split('\n').forEach((line, index) => {
    const assignment = line.match(/^\s*([A-Za-z_]\w*)\s*=/); if (assignment) declared.add(assignment[1]);
    const imported = line.match(/^\s*import\s+([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/); if (imported) declared.add(imported[2] || imported[1]);
    const fromImport = line.match(/^\s*from\s+\S+\s+import\s+(.+)/); if (fromImport) fromImport[1].split(',').forEach(name => declared.add(name.trim().split(/\s+as\s+/).pop()));
    const functionDef = line.match(/^\s*(?:def|class)\s+([A-Za-z_]\w*)/); if (functionDef) declared.add(functionDef[1]);
    const words = line.replace(/(['"]).*?\1/g, '').match(/\b[A-Za-z_]\w*\b/g) || [];
    words.forEach(word => {
      if (known.has(word) || declared.has(word) || builtin.has(word) || /^(import|from|as|def|class|return|for|in|if|else|elif|while|and|or|not|is|with|try|except|pass|lambda|yield|await|async)$/i.test(word)) return;
      if (/^[A-Z]/.test(word) || line.includes(`.${word}`)) return;
      if (!findings.some(item => item.line === index + 1 && item.message.includes(word))) findings.push({ line: index + 1, column: line.indexOf(word) + 1, severity: 'warning', message: `“${word}” is not defined in an earlier cell` });
    });
  });
  return findings.slice(0, 6);
}
function formatCellSource(cell) {
  if (cell.type === 'sql') return cell.source.replace(/\s+/g, ' ').replace(/\b(select|from|where|group by|order by|limit|join|left join|inner join)\b/gi, value => value.toUpperCase()).replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|JOIN|LEFT JOIN|INNER JOIN)\s+/g, '\n$1 ');
  if (cell.type === 'python') return cell.source.split('\n').map(line => line.replace(/\s+$/g, '').replace(/^\t+/g, tabs => '  '.repeat(tabs.length))).join('\n').replace(/\n{3,}/g, '\n\n');
  return cell.source;
}
function notebookDocument() { return dssDocumentFor(activeNotebook()); }
function downloadNotebook(extension, contents, mime) {
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([contents], { type: mime })); anchor.download = `${activeNotebook().name.replace(/[^\w.-]+/g, '_')}.${extension}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}
function exportNotebook(kind) {
  if (kind === 'ipynb') return downloadNotebook('ipynb', JSON.stringify(notebookDocument(), null, 2), 'application/x-ipynb+json');
  const python = pythonExport(state.cells);
  downloadNotebook('py', python, 'text/x-python');
}

function linkedDatasets() { return findLinkedDatasets(state.cells, DATASETS); }
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
function datasetVariableName(name) { return datasetVariable(name); }
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
function renderAiModelSelector() {
  const selector = document.querySelector('#ai-model-selector'); if (!selector) return;
  if (!aiAssistant.models.length) {
    selector.innerHTML = '<option value="">No LLM Mesh model available</option>';
    selector.disabled = true;
    return;
  }
  selector.disabled = false;
  selector.innerHTML = aiAssistant.models.map(model => `<option value="${escapeHTML(model.id)}">${escapeHTML(model.label)}</option>`).join('');
  selector.value = aiAssistant.models.some(model => model.id === aiAssistant.modelId) ? aiAssistant.modelId : aiAssistant.models[0].id;
}
async function loadAiModels() {
  if (!isDssWebappRuntime()) { renderAiModelSelector(); return; }
  try {
    const payload = await dssRequest('llm-models');
    aiAssistant.models = Array.isArray(payload.models) ? payload.models : [];
    aiAssistant.modelId = aiAssistant.models.some(model => model.id === aiAssistant.modelId)
      ? aiAssistant.modelId : (payload.defaultModelId || aiAssistant.models[0]?.id || '');
    aiAssistant.available = Boolean(aiAssistant.modelId);
    if (aiAssistant.modelId) localStorage.setItem(storageKey('coding-llm-id'), aiAssistant.modelId);
  } catch (error) {
    aiAssistant.models = []; aiAssistant.modelId = ''; aiAssistant.available = false;
    console.warn('LLM Mesh discovery is unavailable.', error);
  }
  renderAiModelSelector();
}
function aiHelpMarkup(cell) {
  if (!cell.ai?.open) return '';
  const response = cell.ai.response ? `<div class="cell-ai-response">${markdownMarkup(cell.ai.response)}</div>` : '';
  const error = cell.ai.error ? `<div class="cell-ai-error">${escapeHTML(cell.ai.error)}</div>` : '';
  return `<section class="cell-ai-panel"><header><span>✦ AI help</span><span>${escapeHTML(aiAssistant.models.find(model => model.id === aiAssistant.modelId)?.label || 'LLM Mesh')}</span><button type="button" data-ai-close="${escapeHTML(cell.id)}" aria-label="Close AI help">×</button></header><div class="cell-ai-prompts"><button type="button" data-ai-prompt="Explain this cell">Explain</button><button type="button" data-ai-prompt="Find likely bugs and explain how to fix them">Fix bugs</button><button type="button" data-ai-prompt="Suggest a clearer, more idiomatic version while preserving behaviour">Improve</button></div><textarea data-ai-question="${escapeHTML(cell.id)}" placeholder="Ask about this cell…">${escapeHTML(cell.ai.question || '')}</textarea><footer><button type="button" class="button primary" data-ai-send="${escapeHTML(cell.id)}" ${cell.ai.loading ? 'disabled' : ''}>${cell.ai.loading ? 'Asking LLM Mesh…' : 'Ask AI'}</button></footer>${error}${response}</section>`;
}
function focusAiQuestion(id) {
  requestAnimationFrame(() => document.querySelector(`[data-id="${id}"] [data-ai-question]`)?.focus());
}
async function askCellAi(id, question) {
  const cell = getCell(id); if (!cell) return;
  if (!dss.enabled || !aiAssistant.available) {
    cell.ai = { ...(cell.ai || {}), loading: false, error: 'No LLM Mesh coding model is available for this project.' };
    renderCells(); return;
  }
  cell.ai = { ...(cell.ai || {}), open: true, question, loading: true, error: '', response: '' };
  renderCells();
  try {
    const error = cell.output?.outputs?.find(output => output.output_type === 'error');
    let streamError = '';
    await dssStreamRequest('ai-help/stream', { modelId: aiAssistant.modelId, notebookName: activeNotebook().name, question, error: error ? `${error.ename || 'Error'}: ${error.evalue || ''}` : '', cell: { language: cell.type, source: cell.source } }, (event, payload) => {
      if (event === 'delta') { cell.ai = { ...cell.ai, response: `${cell.ai.response || ''}${payload.text || ''}` }; updateRenderedCellOutput(cell); }
      if (event === 'error') streamError = payload.error || 'LLM Mesh did not complete the request.';
    });
    cell.ai = { ...cell.ai, loading: false, response: cell.ai.response || (streamError ? '' : 'The model returned no text.'), error: streamError };
  } catch (error) {
    cell.ai = { ...cell.ai, loading: false, error: error.message || 'AI help failed.' };
  }
  renderCells();
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
    kind.outputs.forEach((output, outputIndex) => {
      if (output.output_type === 'stream') {
        streamText += outputText(output.text);
        return;
      }
      flushStream();
      if (output.output_type === 'error') {
        const summary = `${output.ename || 'Error'}: ${output.evalue || ''}`;
        const fullError = outputText([summary, ...(output.traceback || [])].join('\n'));
        rendered.push(`<section class="error-output"><header><div class="error-summary"><strong>${escapeHTML(output.ename || 'Execution error')}</strong><span>${escapeHTML(output.evalue || '')}</span></div></header><details><summary>Show traceback</summary><div class="traceback-box"><button data-copy-error="${escapeHTML(cellId)}-${outputIndex}" title="Copy error"><i class="copy-icon" aria-hidden="true"></i> Copy error</button><pre class="runtime-output">${escapeHTML(fullError)}</pre></div></details><textarea class="error-copy-source" hidden>${escapeHTML(fullError)}</textarea></section>`);
        return;
      }
      const dataframe = dataframeMarkup(output.data?.['text/html'], cellId);
      if (dataframe) {
        rendered.push(dataframe);
        return;
      }
      const rich = renderRichMime(output.data, `${cellId}-${outputIndex}`);
      if (rich) { rendered.push(rich); return; }
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
  const aiContainer = node.querySelector('.cell-ai-container');
  if (aiContainer) aiContainer.innerHTML = aiHelpMarkup(cell);
  node.querySelector('.cell-output').innerHTML = cell.type === 'markdown' && !cell.markdownEditing
    ? `<div class="markdown-render" tabindex="0">${markdownMarkup(cell.source)}</div>`
    : outputMarkup(cell.output, cell.id);
  hydrateRichMime(node).catch(error => console.warn('Could not hydrate rich output.', error));
}
function updateRenderedRunState(cell) {
  const node = document.querySelector(`[data-id="${cell.id}"]`); if (!node) return;
  node.classList.toggle('running', Boolean(cell.running));
  const button = node.querySelector('.run-cell'); button.classList.toggle('is-running', Boolean(cell.running));
  button.title = cell.running ? 'Interrupt execution' : 'Run cell'; button.setAttribute('aria-label', button.title);
}
function renderCellMinimap() {
  const tracks = document.querySelector('#cell-minimap-tracks');
  if (!tracks) return;
  tracks.innerHTML = state.cells.map((cell, index) => {
    const detail = executionState(cell);
    return `<button type="button" class="cell-minimap-track ${detail.status}" data-minimap-cell="${escapeHTML(cell.id)}" title="Cell ${index + 1}: ${escapeHTML(executionLabel(cell) || 'Never run')}"></button>`;
  }).join('');
  document.querySelector('#minimap-last-run')?.toggleAttribute('disabled', !state.cells.some(cell => executionState(cell).finishedAt || executionState(cell).order));
  document.querySelector('#minimap-first-failed')?.toggleAttribute('disabled', !state.cells.some(cell => executionState(cell).status === 'failed'));
}
function refreshExecutionTimestamps() {
  state.cells.forEach(cell => {
    const detail = executionState(cell); const node = document.querySelector(`[data-id="${cell.id}"] .execution-meta-top`);
    if (!node || !['succeeded', 'failed', 'interrupted'].includes(detail.status)) return;
    const label = executionLabel(cell); const icon = executionIcon(detail.status);
    node.textContent = label ? `${icon ? `${icon} ` : ''}${label}` : '';
  });
  renderCellMinimap();
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
function markdownMarkup(source) { return renderMarkdown(source); }
function autoHeight(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.max(60, textarea.scrollHeight)}px`; }
function renderCells() {
  const scrollPositions = captureRenderScroll(cellsEl);
  const editorApi = BetterNotebookEditor;
  editorApi.destroyAll();
  cellsEl.innerHTML = '';
  const markdownSections = sectionModel(state.cells);
  state.cells.forEach((data, index) => {
    const section = markdownSections.sections.get(data.id);
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.id = data.id; node.dataset.type = data.type; node.draggable = false;
    if (data.type === 'markdown' && !data.markdownEditing) node.classList.add('markdown-display');
    if (data.type === 'markdown' && data.markdownEditing) node.classList.add('markdown-editing');
    node.querySelector('.drag-handle').draggable = false;
    if (state.selected.has(data.id)) node.classList.add('selected');
    if (state.activeCellId === data.id) node.classList.add('active');
    const executionDetail = executionState(data);
    if (executionDetail.status === 'running') node.classList.add('running');
    node.dataset.executionStatus = executionDetail.status;
    if (markdownSections.hidden.has(data.id)) node.classList.add('section-hidden');
    if (section?.collapsedCount && !data.markdownEditing) {
      const collapseButton = node.querySelector('.section-collapse');
      collapseButton.classList.remove('hidden');
      collapseButton.dataset.toggleSection = data.id;
      collapseButton.textContent = data.collapsed ? '›' : '⌄';
      collapseButton.title = `${data.collapsed ? 'Expand' : 'Collapse'} ${section.title} section`;
      collapseButton.setAttribute('aria-label', collapseButton.title);
    }
    const language = node.querySelector('.cell-language'); language.classList.add(data.type);
    const editorHost = node.querySelector('.code-editor');
    if (data.type === 'markdown' && data.markdownEditing) editorHost.classList.add('editing');
    node.querySelector('.cell-check').checked = state.selected.has(data.id);
    node.querySelector('.cell-ai-container').innerHTML = aiHelpMarkup(data);
    node.querySelector('.cell-output').innerHTML = data.type === 'markdown' && !data.markdownEditing
      ? `<div class="markdown-render" tabindex="0">${markdownMarkup(data.source)}${data.collapsed && section?.collapsedCount ? `<button class="collapsed-section-summary" type="button" data-toggle-section="${escapeHTML(data.id)}">${section.collapsedCount} cell${section.collapsedCount === 1 ? '' : 's'} collapsed</button>` : ''}</div>`
      : outputMarkup(data.output, data.id);
    const diagnostic = node.querySelector('.cell-diagnostic'); diagnostic.hidden = !data.diagnostic; diagnostic.textContent = data.diagnostic ? `Line ${data.diagnostic.line || '?'}: ${data.diagnostic.message}` : '';
    const meta = node.querySelector('.execution-meta-top');
    const label = executionLabel(data); const icon = executionIcon(executionDetail.status);
    meta.textContent = label ? `${icon ? `${icon} ` : ''}${label}` : '';
    meta.dataset.executionStatus = executionDetail.status;
    meta.classList.toggle('success', executionDetail.status === 'succeeded');
    meta.classList.toggle('error', executionDetail.status === 'failed');
    meta.classList.toggle('neutral', ['queued', 'running', 'interrupted'].includes(executionDetail.status));
    node.querySelector('.cell-footer').hidden = true;
    node.querySelector('.more-cell').setAttribute('aria-label', `More actions for cell ${index + 1}`);
    if (executionDetail.status === 'running') { const run = node.querySelector('.run-cell'); run.classList.add('is-running'); run.title = 'Interrupt execution'; run.setAttribute('aria-label', 'Interrupt execution'); }
    cellsEl.appendChild(node);
    if (!markdownSections.hidden.has(data.id)) {
      editorApi.mount({
        id: data.id, parent: editorHost, source: data.source, type: data.type, datasets: DATASETS, symbols: () => symbolsBefore(data.id), connections: projectContext.connections,
        onChange: source => updateCell(data.id, { source }), onRun: () => runCell(data.id), onRunAndAdvance: () => runAndAdvance(data.id), onInspect: ({ code, pos }) => inspectInDssKernel(activeNotebook(), code, pos), onComplete: ({ code, pos }) => completeInDssKernel(activeNotebook(), code, pos),
      });
      editorApi.setDiagnostic(data.id, [...(data.diagnostic ? [data.diagnostic] : []), ...staticDiagnostics(data.id)]);
    }
    const gap = document.createElement('div'); gap.className = 'cell-insert-gap'; gap.dataset.dropIndex = String(index + 1); gap.innerHTML = `<div class="insert-menu"><button data-insert-after="${data.id}" data-insert-type="python">+&nbsp; Code Cell</button><button data-insert-after="${data.id}" data-insert-type="markdown">+&nbsp; Markdown Cell</button></div>`; cellsEl.appendChild(gap);
  });
  renderToolbar(); renderOutline(); renderCellMinimap();
  hydrateRichMime(cellsEl).catch(error => console.warn('Could not hydrate rich outputs.', error));
  // Removing the focused CodeMirror node can cause browsers to compensate by
  // scrolling after the first frame. Restore again after layout settles.
  requestAnimationFrame(() => {
    restoreRenderScroll(scrollPositions);
    requestAnimationFrame(() => restoreRenderScroll(scrollPositions));
    window.setTimeout(() => restoreRenderScroll(scrollPositions), 0);
  });
}
function renderToolbar() {
  const toolbar = document.querySelector('#batch-toolbar'); const count = state.selected.size;
  toolbar.classList.toggle('hidden', count === 0); document.querySelector('#selection-count').textContent = `${count} cell${count === 1 ? '' : 's'} selected`;
}
function renderOutline() {
  const list = document.querySelector('#outline-list');
  const headings = sectionModel(state.cells).headings;
  list.innerHTML = headings.length
    ? headings.map(heading => `<button class="outline-item level-${heading.level}" data-outline-id="${heading.cellId}"><span class="outline-section-toggle" data-collapse-heading="${heading.cellId}">${getCell(heading.cellId)?.collapsed ? '›' : '⌄'}</span>${escapeHTML(heading.title)}</button>`).join('')
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
  const runtimeLabel = document.querySelector('.notebook-runbar .eyebrow');
  if (runtimeLabel?.firstChild) runtimeLabel.firstChild.textContent = `${notebook.language} NOTEBOOK `;
  dss.activeRuntimeId = notebook.runtimeId || dss.activeRuntimeId;
  renderRuntimeSelector();
}
function renderWorkspace() { renderProjectContext(); renderNotebookNavigation(); renderSqlConnectionSelector(); renderDatasets(); renderLinkedDatasets(); renderCells(); }
window.setInterval(refreshExecutionTimestamps, 5000);
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
  const startedAt = Date.now(); const started = performance.now();
  const order = nextExecutionOrder();
  if (cell.type === 'markdown') { cell.markdownEditing = false; setExecution(cell, { status: 'succeeded', order, startedAt, finishedAt: Date.now(), durationMs: 0 }); cell.meta = ''; save(); renderCells(); return true; }
  if (!activeNotebook().remote) { const durationMs = cell.type === 'sql' ? 180 : 240; cell.output = cell.type === 'sql' ? 'query' : 'table'; setExecution(cell, { status: 'succeeded', order, startedAt, finishedAt: Date.now(), durationMs }); cell.meta = ''; save(); renderCells(); return true; }
  setExecution(cell, { status: 'running', order, startedAt, finishedAt: null, durationMs: null }); cell.meta = ''; cell.running = true; renderCells();
  try {
    const source = cell.type === 'sql' ? sqlExecutionSource(cell.source) : cell.source;
    const result = await executeInDssKernel(activeNotebook(), source, outputs => {
      cell.output = { outputs: [...outputs] }; updateRenderedCellOutput(cell);
    });
    cell.output = { outputs: result.outputs };
    cell.dssCell = { ...(cell.dssCell || {}), outputs: result.outputs, execution_count: result.executionCount };
    const failed = result.outputs.some(output => output.output_type === 'error');
    cell.running = false;
    setExecution(cell, { status: failed ? 'failed' : 'succeeded', order: result.executionCount || order, startedAt, finishedAt: Date.now(), durationMs: performance.now() - started });
    cell.meta = ''; save(); renderCells(); setSavedState(failed ? 'Execution failed' : 'Executed in DSS', failed); return !failed;
  } catch (error) {
    cell.running = false; cell.output = { outputs: [{ output_type: 'error', ename: 'DSS execution error', evalue: error.message, traceback: [] }] };
    setExecution(cell, { status: 'failed', order, startedAt, finishedAt: Date.now(), durationMs: performance.now() - started });
    save(); renderCells(); setSavedState(`Execution failed: ${error.message}`, true); console.warn(error); return false;
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
function moveCells(dragIds, targetId, after = false) {
  const ids = [...new Set(dragIds)].filter(id => getCell(id)); if (!ids.length || ids.includes(targetId)) return;
  const moving = state.cells.filter(cell => ids.includes(cell.id));
  const targetIndex = cellIndex(targetId); const before = state.cells.slice(0, targetIndex + (after ? 1 : 0)).filter(cell => !ids.includes(cell.id));
  const rest = state.cells.slice(targetIndex + (after ? 1 : 0)).filter(cell => !ids.includes(cell.id));
  state.cells = [...before, ...moving, ...rest]; save(); renderCells();
}
function moveCellsToIndex(dragIds, insertionIndex) {
  const ids = [...new Set(dragIds)].filter(id => getCell(id));
  if (!ids.length) return;
  const moving = state.cells.filter(cell => ids.includes(cell.id));
  const remaining = state.cells.filter(cell => !ids.includes(cell.id));
  const index = Math.max(0, Math.min(remaining.length, state.cells.slice(0, insertionIndex).filter(cell => !ids.includes(cell.id)).length));
  state.cells = [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
  save(); renderCells();
}
function moveCell(dragId, targetId) { moveCells([dragId], targetId); }
function scrollableDragContainer(start) {
  let node = start instanceof Element ? start : cellsEl;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}
function stopDragAutoScroll() {
  if (dragScroll.frame) cancelAnimationFrame(dragScroll.frame);
  dragScroll.frame = 0; dragScroll.pointerY = null; dragScroll.container = null;
}
function runDragAutoScroll() {
  if (!state.dragIds.length || dragScroll.pointerY == null) { stopDragAutoScroll(); return; }
  const container = dragScroll.container || document.scrollingElement || document.documentElement;
  const isDocument = container === document.body || container === document.documentElement || container === document.scrollingElement;
  const bounds = isDocument ? { top: 0, bottom: window.innerHeight } : container.getBoundingClientRect();
  const edge = Math.min(120, Math.max(72, (bounds.bottom - bounds.top) * .12));
  const topDistance = dragScroll.pointerY - bounds.top;
  const bottomDistance = bounds.bottom - dragScroll.pointerY;
  let speed = 0;
  if (topDistance < edge) speed = -Math.ceil(4 + 24 * (1 - Math.max(0, topDistance) / edge));
  else if (bottomDistance < edge) speed = Math.ceil(4 + 24 * (1 - Math.max(0, bottomDistance) / edge));
  if (speed) {
    if (isDocument) window.scrollBy(0, speed);
    else container.scrollTop += speed;
  }
  dragScroll.frame = requestAnimationFrame(runDragAutoScroll);
}
function updateDragAutoScroll(event) {
  if (!state.dragIds.length) return;
  dragScroll.pointerY = event.clientY;
  dragScroll.container = scrollableDragContainer(event.target);
  if (!dragScroll.frame) dragScroll.frame = requestAnimationFrame(runDragAutoScroll);
}
async function runRelative(id, direction) {
  const index = cellIndex(id); const range = direction === 'above' ? state.cells.slice(0, index + 1) : state.cells.slice(index);
  for (const cell of range) if (!await runCell(cell.id)) break;
}
function clearCellOutput(id) { const cell = getCell(id); if (!cell) return; cell.output = ''; cell.meta = ''; cell.execution = { status: 'never', order: null, startedAt: null, finishedAt: null, durationMs: null }; cell.dssCell = { ...(cell.dssCell || {}), outputs: [], execution_count: null }; save(); renderCells(); }
function toggleSection(id, collapsed = null) {
  const cell = getCell(id);
  if (!cell || cell.type !== 'markdown' || !sectionModel(state.cells).sections.has(id)) return;
  cell.collapsed = collapsed == null ? !cell.collapsed : Boolean(collapsed);
  if (cell.collapsed) state.collapsedHeadings.add(id); else state.collapsedHeadings.delete(id);
  save(false);
  renderCells();
}
async function restartKernel() {
  if (!dss.kernel) { setSavedState('Kernel will start when you run a cell'); return; }
  try { await jupyterRequest(`api/kernels/${encodeURIComponent(dss.kernel.kernelId)}/restart`, { method: 'POST', body: '{}' }); dss.kernel.socket.close(); dss.kernel = null; setKernelStatus('Restarted', 'idle'); setSavedState('Kernel restarted'); }
  catch (error) { setSavedState(`Kernel restart failed: ${error.message}`, true); }
}
async function restartKernelWithRuntime(notebook) {
  const previousKernel = dss.kernel;
  setKernelStatus('Starting…', 'busy');
  if (previousKernel?.socket) previousKernel.socket.close();
  dss.kernel = null;
  // A Jupyter restart retains the old kernelspec. Close the existing DSS
  // session and create a fresh one so the selected code environment is real.
  if (previousKernel?.dssSessionId) {
    try { await jupyterRequest(`api/sessions/${encodeURIComponent(previousKernel.dssSessionId)}`, { method: 'DELETE' }); }
    catch (error) { console.warn('Could not close the previous kernel session.', error); }
  }
  await connectDssKernel(notebook);
  setKernelStatus('Connected', 'connected');
}
function closeCellMenus() {
  document.querySelectorAll('.cell.more-open, .cell.cell-menu-open').forEach(cell => {
    cell.classList.remove('more-open', 'cell-menu-open');
    cell.querySelector('.cell-type')?.classList.remove('open');
  });
}

cellsEl.addEventListener('input', event => {
  const aiQuestion = event.target.closest('[data-ai-question]');
  if (aiQuestion) { const cell = getCell(aiQuestion.dataset.aiQuestion); if (cell) cell.ai = { ...(cell.ai || {}), question: aiQuestion.value }; return; }
  if (!event.target.matches('.code-input')) return;
  autoHeight(event.target); updateCell(event.target.closest('.cell').dataset.id, { source: event.target.value });
});
cellsEl.addEventListener('change', event => { if (event.target.matches('.cell-check')) selectCell(event.target.closest('.cell').dataset.id, event.target.checked); });
cellsEl.addEventListener('click', event => {
  const cell = event.target.closest('.cell'); if (!cell) return; const id = cell.dataset.id;
  setActiveCell(id);
  if (event.target.closest('.ai-help')) { const target = getCell(id); target.ai = { ...(target.ai || {}), open: true, loading: false, error: '' }; renderCells(); focusAiQuestion(id); return; }
  if (event.target.closest('[data-ai-close]')) { const target = getCell(id); target.ai = { ...(target.ai || {}), open: false }; renderCells(); return; }
  const aiPrompt = event.target.closest('[data-ai-prompt]');
  if (aiPrompt) { askCellAi(id, aiPrompt.dataset.aiPrompt); return; }
  const aiSend = event.target.closest('[data-ai-send]');
  if (aiSend) { const question = cell.querySelector(`[data-ai-question="${id}"]`)?.value.trim() || 'Explain this cell and suggest an improvement.'; askCellAi(id, question); return; }
  if (event.target.closest('[data-toggle-section]')) { toggleSection(id); return; }
  if (event.target.closest('.run-cell')) {
    const current = getCell(id);
    if (current.running) interruptDssExecution().catch(error => setSavedState(`Interrupt failed: ${error.message}`, true));
    else runCell(id);
  }
  if (event.target.closest('.delete-cell')) { state.selected = new Set([id]); deleteSelected(); }
  if (event.target.closest('.more-cell')) {
    const shouldOpen = !cell.classList.contains('more-open');
    closeCellMenus();
    cell.classList.toggle('more-open', shouldOpen);
  }
  const action = event.target.closest('[data-cell-action]')?.dataset.cellAction;
  if (action === 'run-above') runRelative(id, 'above');
  if (action === 'run-below') runRelative(id, 'below');
  if (action === 'clear-output') clearCellOutput(id);
  if (action === 'format') { const target = getCell(id); target.source = formatCellSource(target); save(); renderCells(); focusCell(id, true); }
  if (event.target.closest('.cell-type-selector')) {
    const typeMenu = cell.querySelector('.cell-type');
    const shouldOpen = !typeMenu.classList.contains('open');
    closeCellMenus();
    typeMenu.classList.toggle('open', shouldOpen);
    cell.classList.toggle('cell-menu-open', shouldOpen);
  }
  const typeOption = event.target.closest('[data-cell-type]');
  if (typeOption) { const target = getCell(id); target.type = typeOption.dataset.cellType; target.markdownEditing = target.type === 'markdown'; target.output = ''; target.meta = ''; save(); queuePythonCheck(target); renderCells(); focusCell(id, true); }
  if (event.target.closest('.markdown-render')) { const target = getCell(id); target.markdownEditing = true; save(false); renderCells(); focusCell(id, true); return; }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.cell-type, .more-cell, .cell-more-menu')) closeCellMenus();
});
cellsEl.addEventListener('focusin', event => { const cell = event.target.closest('.cell'); if (cell) setActiveCell(cell.dataset.id); });
// Markdown stays in edit mode after it is opened. Running the cell explicitly
// renders it again, so cell controls remain reachable while editing.
cellsEl.addEventListener('click', event => { const button = event.target.closest('[data-insert-after]'); if (button) insertAfter(button.dataset.insertAfter, newCell(button.dataset.insertType)); });
function clearPointerDrag() {
  pointerDrag.preview?.remove(); pointerDrag.preview = null;
  pointerDrag.active = false; pointerDrag.candidate = null; pointerDrag.dropIndex = null;
  stopDragAutoScroll(); state.dragId = null; state.dragIds = [];
  document.querySelectorAll('.cell.dragging, .cell.drop-target, .cell-insert-gap.drop-target').forEach(node => node.classList.remove('dragging', 'drop-target', 'drop-after'));
}
function setPointerDropTarget(index) {
  pointerDrag.dropIndex = Number.isFinite(index) ? index : null;
  document.querySelectorAll('.cell.drop-target, .cell-insert-gap.drop-target').forEach(node => node.classList.remove('drop-target', 'drop-after'));
  if (pointerDrag.dropIndex == null) return;
  document.querySelector(`.cell-insert-gap[data-drop-index="${pointerDrag.dropIndex}"]`)?.classList.add('drop-target');
}
function beginPointerDrag(event) {
  const handle = event.target.closest('.drag-handle'); const cell = handle?.closest('.cell');
  if (!cell || event.button !== 0) return;
  event.preventDefault();
  const bounds = cell.getBoundingClientRect();
  pointerDrag.candidate = { id: cell.dataset.id, x: event.clientX, y: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, pointerId: event.pointerId, cell };
  handle.setPointerCapture?.(event.pointerId);
  activatePointerDrag(event);
  updatePointerDrag(event);
}
function activatePointerDrag(event) {
  const candidate = pointerDrag.candidate; if (!candidate || pointerDrag.active) return;
  pointerDrag.active = true;
  state.dragId = candidate.id; state.dragIds = state.selected.has(candidate.id) ? [...state.selected] : [candidate.id];
  state.dragIds.forEach(id => document.querySelector(`[data-id="${id}"]`)?.classList.add('dragging'));
  // Cloning a mounted CodeMirror tree makes the first drag frame expensive.
  // Keep the source cell visible and use a deliberately small, cheap preview.
  const source = getCell(candidate.id)?.source?.trim().split('\n')[0] || 'Empty cell';
  const preview = document.createElement('div'); preview.className = 'cell-drag-preview';
  preview.innerHTML = `<span>Moving ${state.dragIds.length > 1 ? `${state.dragIds.length} cells` : 'cell'}</span><strong>${escapeHTML(source.slice(0, 72))}</strong>`;
  preview.style.width = `${Math.min(candidate.cell.getBoundingClientRect().width, 360)}px`; document.body.appendChild(preview); pointerDrag.preview = preview;
  dragScroll.container = scrollableDragContainer(candidate.cell);
}
function updatePointerDrag(event) {
  const candidate = pointerDrag.candidate; if (!candidate || event.pointerId !== candidate.pointerId) return;
  activatePointerDrag(event); if (!pointerDrag.active) return;
  pointerDrag.preview.style.left = `${event.clientX - candidate.offsetX}px`; pointerDrag.preview.style.top = `${event.clientY - candidate.offsetY}px`;
  updateDragAutoScroll(event);
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const gap = target?.closest?.('.cell-insert-gap[data-drop-index]');
  if (gap) { setPointerDropTarget(Number(gap.dataset.dropIndex)); return; }
  setPointerDropTarget(null);
}
function finishPointerDrag(event) {
  const candidate = pointerDrag.candidate; if (!candidate || event.pointerId !== candidate.pointerId) return;
  const dropIndex = pointerDrag.dropIndex; const ids = [...state.dragIds]; const active = pointerDrag.active;
  clearPointerDrag();
  if (active && dropIndex != null) moveCellsToIndex(ids, dropIndex);
}
cellsEl.addEventListener('pointerdown', beginPointerDrag);
document.addEventListener('pointermove', updatePointerDrag);
document.addEventListener('pointerup', finishPointerDrag);
document.addEventListener('pointercancel', clearPointerDrag);

function renderExecutionControls() {
  document.querySelector('#run-all').disabled = execution.runningAll;
  document.querySelector('#run-all').innerHTML = execution.runningAll ? '<span>◌</span> Running all' : '<span>▶</span> Run all';
  document.querySelector('#stop-run-all').classList.toggle('hidden', !execution.runningAll);
}
document.querySelector('#run-all').addEventListener('click', async () => {
  if (execution.runningAll) return;
  execution.runningAll = true; execution.stopRequested = false; renderExecutionControls();
  state.cells.filter(cell => cell.type !== 'markdown').forEach(cell => setExecution(cell, { status: 'queued', startedAt: null, finishedAt: null, durationMs: null }));
  renderCells();
  let ran = 0;
  for (const cell of state.cells) {
    if (execution.stopRequested) {
      if (executionState(cell).status === 'queued') setExecution(cell, { status: 'never' });
      break;
    }
    const succeeded = await runCell(cell.id); ran += 1;
    if (!succeeded) { setSavedState(`Run all stopped after cell ${ran} because it failed`, true); break; }
  }
  if (execution.stopRequested) setSavedState(`Run all stopped after ${ran} cell${ran === 1 ? '' : 's'}`);
  state.cells.filter(cell => executionState(cell).status === 'queued').forEach(cell => setExecution(cell, { status: 'never' }));
  execution.runningAll = false; save(); renderCells(); renderExecutionControls();
});
document.querySelector('#stop-run-all').addEventListener('click', () => { execution.stopRequested = true; setSavedState('Stopping after the current cell…'); });
document.querySelector('#notebook-actions')?.addEventListener('click', () => document.querySelector('#notebook-actions-menu')?.classList.toggle('hidden'));
document.querySelector('#restart-kernel-button')?.addEventListener('click', () => restartKernel());
document.querySelector('#notebook-actions-menu')?.addEventListener('click', async event => {
  const action = event.target.dataset.notebookAction; if (!action) return;
  document.querySelector('#notebook-actions-menu')?.classList.add('hidden');
  if (action === 'export-ipynb') exportNotebook('ipynb');
  if (action === 'export-py') exportNotebook('py');
  if (action === 'copy-python') { await navigator.clipboard?.writeText(state.cells.filter(cell => cell.type !== 'markdown').map(cell => cell.source).join('\n\n# %%\n\n')); setSavedState('Python cells copied'); }
  if (action === 'clear-outputs') { state.cells.forEach(cell => { cell.output = ''; cell.meta = ''; cell.execution = { status: 'never', order: null, startedAt: null, finishedAt: null, durationMs: null }; cell.dssCell = { ...(cell.dssCell || {}), outputs: [], execution_count: null }; }); save(); renderCells(); }
  if (action === 'restart-kernel') restartKernel();
  if (action === 'collapse-all') { const sections = sectionModel(state.cells); state.cells.filter(cell => sections.sections.get(cell.id)?.collapsedCount).forEach(cell => { cell.collapsed = true; state.collapsedHeadings.add(cell.id); }); save(false); renderCells(); }
  if (action === 'expand-all') { state.cells.forEach(cell => { cell.collapsed = false; }); state.collapsedHeadings.clear(); save(false); renderCells(); }
});
document.addEventListener('click', event => {
  if (!event.target.closest('#notebook-actions, #notebook-actions-menu')) document.querySelector('#notebook-actions-menu')?.classList.add('hidden');
});
document.querySelector('#dataset-search').addEventListener('input', event => renderDatasets(event.target.value));
document.querySelector('#refresh-datasets')?.addEventListener('click', loadProjectContext);
document.querySelector('#retry-save')?.addEventListener('click', async () => {
  if (!activeNotebook()?.remote) return;
  try { await flushDssSave(activeNotebook()); }
  catch (error) { saveFailure = error; setSavedState('Save failed — retry', true); }
});
document.querySelector('#executor-selector').addEventListener('change', async event => {
  const requestedRuntime = event.target.value;
  const notebook = activeNotebook();
  const previousRuntime = notebook?.runtimeId || dss.activeRuntimeId;
  if (requestedRuntime === previousRuntime) return;
  if (!dss.enabled || !notebook?.remote) {
    dss.activeRuntimeId = requestedRuntime;
    if (notebook) notebook.runtimeId = requestedRuntime;
    setSavedState('Runtime selected for the next DSS notebook');
    return;
  }
  const requestedLabel = dss.runtimes.find(runtime => runtime.id === requestedRuntime)?.label || requestedRuntime;
  if (!window.confirm(`Switch to ${requestedLabel}? This restarts the Python kernel and clears all variables and in-memory outputs.`)) {
    event.target.value = previousRuntime;
    return;
  }
  try {
    event.target.disabled = true;
    dss.activeRuntimeId = requestedRuntime; notebook.runtimeId = requestedRuntime;
    setSavedState('Saving environment and restarting kernel…');
    await flushDssSave(notebook);
    await restartKernelWithRuntime(notebook);
    setSavedState(`Kernel restarted with ${requestedLabel}`);
  } catch (error) {
    dss.activeRuntimeId = previousRuntime; notebook.runtimeId = previousRuntime; event.target.value = previousRuntime;
    setKernelStatus('Runtime switch failed', 'error');
    setSavedState(`Runtime switch failed: ${error.message}`, true); console.warn(error);
  } finally { event.target.disabled = false; }
});
document.querySelector('#ai-model-selector')?.addEventListener('change', event => {
  aiAssistant.modelId = event.target.value;
  if (aiAssistant.modelId) localStorage.setItem(storageKey('coding-llm-id'), aiAssistant.modelId);
  setSavedState(`AI help model: ${aiAssistant.models.find(model => model.id === aiAssistant.modelId)?.label || aiAssistant.modelId}`);
});
document.querySelector('#sql-executor-selector').addEventListener('change', event => {
  projectContext.sqlConnection = event.target.value;
  if (projectContext.sqlConnection) projectContext.managedConnection = projectContext.sqlConnection;
  setSavedState(projectContext.sqlConnection ? `SQL connection: ${projectContext.sqlConnection}` : 'No SQL connection selected');
});
document.querySelector('#dataset-list').addEventListener('click', event => { const dataset = event.target.closest('[data-dataset]'); if (dataset) selectDataset(dataset.dataset.dataset); });
document.querySelector('#dataset-inspector')?.addEventListener('click', event => {
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
document.querySelector('#data-panel-toggle')?.addEventListener('click', event => {
  const shell = document.querySelector('.app-shell'); const collapsed = shell.classList.toggle('data-panel-collapsed');
  event.currentTarget.setAttribute('aria-pressed', String(collapsed));
  event.currentTarget.setAttribute('aria-label', collapsed ? 'Show project datasets' : 'Hide project datasets');
  event.currentTarget.title = collapsed ? 'Show project datasets' : 'Hide project datasets';
  event.currentTarget.textContent = collapsed ? '▰' : '▱';
});
function initialisePanelResizers() {
  const shell = document.querySelector('.app-shell');
  const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey('panel-widths'))) || {}; } catch { return {}; } })();
  const apply = (side, width) => {
    const clamped = Math.round(Math.max(side === 'left' ? 180 : 220, Math.min(side === 'left' ? 420 : 440, width)));
    shell.style.setProperty(side === 'left' ? '--left-panel-width' : '--right-panel-width', `${clamped}px`);
    saved[side] = clamped;
    localStorage.setItem(storageKey('panel-widths'), JSON.stringify(saved));
  };
  if (Number.isFinite(saved.left)) apply('left', saved.left);
  if (Number.isFinite(saved.right)) apply('right', saved.right);
  document.querySelectorAll('[data-panel-resizer]').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      if (window.matchMedia('(max-width: 1050px)').matches) return;
      const side = handle.dataset.panelResizer;
      const startX = event.clientX;
      const startWidth = parseFloat(getComputedStyle(shell).getPropertyValue(side === 'left' ? '--left-panel-width' : '--right-panel-width'));
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('resizing-panels');
      const move = pointer => apply(side, startWidth + (side === 'left' ? pointer.clientX - startX : startX - pointer.clientX));
      const stop = pointer => {
        handle.releasePointerCapture?.(pointer.pointerId);
        document.body.classList.remove('resizing-panels');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });
  });
}
initialisePanelResizers();
const folderModal = document.querySelector('#folder-modal');
const closeFolderModal = () => { folderModal.classList.add('hidden'); document.querySelector('#folder-form').reset(); };
document.querySelector('#close-folder-modal').addEventListener('click', closeFolderModal);
document.querySelector('#cancel-folder').addEventListener('click', closeFolderModal);
folderModal.addEventListener('click', event => { if (event.target === folderModal) closeFolderModal(); });
document.querySelector('#folder-form').addEventListener('submit', event => { event.preventDefault(); const name = document.querySelector('#folder-name-input').value.trim(); if (!name) return; state.notebooks.folders.push({ id: crypto.randomUUID(), name }); persistNotebooks(); renderNotebookNavigation(); closeFolderModal(); });
document.querySelector('#outline-toggle').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('outline-collapsed'));
document.querySelector('#outline-list').addEventListener('click', event => {
  const collapsed = event.target.closest('[data-collapse-heading]');
  if (collapsed) { toggleSection(collapsed.dataset.collapseHeading); return; }
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
  const copyError = event.target.closest('[data-copy-error]'); if (copyError) { const text = copyError.closest('.error-output')?.querySelector('.error-copy-source')?.value || ''; navigator.clipboard?.writeText(text); setSavedState('Error copied to clipboard'); return; }
  const header = event.target.closest('[data-sort-column]'); if (header) { sortDataframe(header.closest('table'), Number(header.dataset.sortColumn)); return; }
  const createDataset = event.target.closest('[data-create-dataset-from-cell]'); if (createDataset) { createDatasetFromDataframe(createDataset.dataset.createDatasetFromCell); return; }
  const chart = event.target.closest('.chart-dataframe'); if (chart) { chartDataframe(chart.closest('.dataframe-output')); return; }
  const explore = event.target.closest('.explore-dataframe'); if (explore) { const section = explore.closest('.dataframe-output'); document.querySelector('#dataframe-modal-content').innerHTML = section.outerHTML; document.querySelector('#dataframe-modal').classList.remove('hidden'); }
});
function revealCell(id) {
  const cell = getCell(id); if (!cell) return;
  const sections = sectionModel(state.cells);
  let expanded = false;
  state.cells.forEach(candidate => {
    const section = sections.sections.get(candidate.id);
    const index = cellIndex(id);
    if (candidate.collapsed && section && index > section.start && index < section.end) { candidate.collapsed = false; expanded = true; }
  });
  if (expanded) { save(false); renderCells(); }
  const scroll = () => {
    setActiveCell(id);
    document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  requestAnimationFrame(() => window.setTimeout(scroll, expanded ? 35 : 0));
}
document.querySelector('#cell-minimap')?.addEventListener('click', event => {
  const track = event.target.closest('[data-minimap-cell]'); if (track) { revealCell(track.dataset.minimapCell); return; }
  if (event.target.closest('#minimap-last-run')) {
    const recent = [...state.cells].filter(cell => executionState(cell).finishedAt || executionState(cell).order).sort((left, right) => (executionState(right).finishedAt || 0) - (executionState(left).finishedAt || 0))[0];
    if (recent) revealCell(recent.id);
  }
  if (event.target.closest('#minimap-first-failed')) { const failed = state.cells.find(cell => executionState(cell).status === 'failed'); if (failed) revealCell(failed.id); }
});
const dataframeModal = document.querySelector('#dataframe-modal');
const closeDataframeModal = () => dataframeModal?.classList.add('hidden');
document.querySelector('#close-dataframe-modal')?.addEventListener('click', closeDataframeModal);
dataframeModal?.addEventListener('click', event => { if (event.target === dataframeModal) closeDataframeModal(); });
document.querySelector('#cell-search')?.addEventListener('input', event => {
  state.searchQuery = event.target.value.trim().toLowerCase(); state.searchIndex = 0;
  const matches = state.cells.filter(cell => state.searchQuery && cell.source.toLowerCase().includes(state.searchQuery));
  document.querySelector('#cell-search-count').textContent = state.searchQuery ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : '';
  document.querySelectorAll('.cell.search-match').forEach(cell => cell.classList.remove('search-match'));
  matches.forEach(cell => document.querySelector(`[data-id="${cell.id}"]`)?.classList.add('search-match'));
  if (matches[0]) document.querySelector(`[data-id="${matches[0].id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#cell-search')?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !state.searchQuery) return;
  const matches = state.cells.filter(cell => cell.source.toLowerCase().includes(state.searchQuery)); if (!matches.length) return;
  event.preventDefault(); state.searchIndex = (state.searchIndex + 1) % matches.length;
  document.querySelector(`[data-id="${matches[state.searchIndex].id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.querySelector('#batch-toolbar').addEventListener('click', async event => { const action = event.target.dataset.batchAction; if (!action) return; if (action === 'run') { for (const cell of state.cells.filter(cell => state.selected.has(cell.id))) if (!await runCell(cell.id)) break; } if (action === 'duplicate') duplicateSelected(); if (action === 'copy') copySelected(); if (action === 'cut') copySelected(true); if (action === 'delete') deleteSelected(); if (action === 'clear') { state.selected.clear(); renderCells(); } });
document.querySelector('.workspace').addEventListener('click', event => { if (!state.selected.size || event.target.closest('.cell, button, textarea, input, .batch-toolbar')) return; state.selected.clear(); renderCells(); });
const settingsModal = document.querySelector('#settings-modal');
const closeSettings = () => settingsModal.classList.add('hidden');
document.querySelector('#settings-button').addEventListener('click', () => settingsModal.classList.remove('hidden'));
document.querySelector('#close-settings').addEventListener('click', closeSettings);
document.querySelector('#done-settings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', event => { if (event.target === settingsModal) closeSettings(); });
document.querySelector('#restore-recovery-draft')?.addEventListener('click', () => {
  if (!pendingRecovery) return;
  pendingRecovery.notebook.cells = pendingRecovery.draft.cells; state.cells = pendingRecovery.draft.cells;
  document.querySelector('#recovery-modal')?.classList.add('hidden'); setSavedState('Recovery draft restored — saving to DSS…'); save(false); renderWorkspace(); pendingRecovery = null;
});
document.querySelector('#use-dss-version')?.addEventListener('click', () => {
  if (!pendingRecovery) return;
  clearDraft(pendingRecovery.notebook); document.querySelector('#recovery-modal')?.classList.add('hidden'); setSavedState('Using current DSS version'); pendingRecovery = null;
});
document.addEventListener('keydown', async event => {
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') { clearPointerDrag(); closeCellMenus(); closeSettings(); closeFolderModal(); closeDataframeModal(); return; }
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
  await Promise.all([loadProjectContext(), loadDssWorkspace(), loadAiModels()]);
}
state.activeNotebookId = state.notebooks.activeNotebookId || state.notebooks.notebooks[0].id;
state.cells = activeNotebook().cells;
// Start native discovery before constructing editors. A third-party editor
// rendering failure must never leave the page looking like browser preview
// while silently preventing the DSS project handshake.
resetHistory(); startDssIntegration(); renderWorkspace(); renderExecutionControls();
