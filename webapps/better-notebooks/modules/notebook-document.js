/** Preserve the native nbformat document, including fields this editor doesn't own. */
export function serializeNotebook(notebook, runtime, executionState) {
  const document = structuredClone(notebook.dssContent || { nbformat: 4, nbformat_minor: 5, metadata: {} });
  document.metadata ||= {};
  if (runtime?.kernelSpec) document.metadata.kernelspec = runtime.kernelSpec;
  document.cells = notebook.cells.map(cell => {
    const metadata = structuredClone(cell.dssCell?.metadata || {});
    metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), execution: executionState(cell) };
    if (cell.type === 'sql') metadata.betterNotebooks.cellType = 'sql';
    else delete metadata.betterNotebooks.cellType;
    if (cell.type === 'markdown') metadata.betterNotebooks.collapsed = Boolean(cell.collapsed);
    const native = { ...(cell.dssCell || {}), id: cell.id, metadata, cell_type: cell.type === 'markdown' ? 'markdown' : cell.type === 'raw' ? 'raw' : 'code', source: cell.source ? cell.source.match(/[^\n]*\n|[^\n]+/g) || [] : [] };
    if (native.cell_type === 'code') {
      native.execution_count = cell.dssCell?.execution_count ?? null;
      native.outputs = structuredClone(cell.dssCell?.outputs || []);
    } else { delete native.outputs; delete native.execution_count; }
    return native;
  });
  return document;
}
