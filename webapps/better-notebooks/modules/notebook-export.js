export function sourceLines(source) { return source ? String(source).match(/[^\n]*\n|[^\n]+/g) || [] : []; }

export function pythonExport(cells) {
  return cells.map(cell => {
    if (cell.type === 'markdown') {
      const content = String(cell.source || '').split('\n').map(line => line ? `# ${line}` : '#').join('\n');
      return `# ---- Markdown cell ----\n${content}`;
    }
    if (cell.type === 'sql') return `# ---- SQL cell ----\n# %% SQL\n${cell.source}`;
    return `# ---- Code cell ----\n${cell.source}`;
  }).join('\n\n');
}

export function notebookDocument(notebook, cells, runtime) {
  const document = structuredClone(notebook.dssContent || { nbformat: 4, nbformat_minor: 5, metadata: {} });
  document.metadata = document.metadata || {};
  if (runtime?.kernelSpec) document.metadata.kernelspec = runtime.kernelSpec;
  document.cells = cells.map(cell => {
    const metadata = { ...(cell.dssCell?.metadata || {}) };
    if (cell.type === 'sql') metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), cellType: 'sql' };
    if (cell.type === 'markdown') metadata.betterNotebooks = { ...(metadata.betterNotebooks || {}), collapsed: Boolean(cell.collapsed) };
    return { ...(cell.dssCell || {}), metadata, cell_type: cell.type === 'markdown' ? 'markdown' : 'code', source: sourceLines(cell.source), execution_count: cell.dssCell?.execution_count ?? null, outputs: cell.dssCell?.outputs || [] };
  });
  return document;
}
