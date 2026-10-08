import { canonicalDocument } from './modules/save-coordinator.js';

/** Browser recovery drafts and deterministic notebook comparison. */
export function saveDraft(storage, key, cells) {
  storage.setItem(key, JSON.stringify({ savedAt: Date.now(), cells }));
}
export function loadDraft(storage, key) {
  try { const draft = JSON.parse(storage.getItem(key) || 'null'); return Array.isArray(draft?.cells) ? draft : null; }
  catch { return null; }
}
export function removeDraft(storage, key) { storage.removeItem(key); }
function comparableExecution(cell) {
  const value = cell.execution || {};
  return { ...value, status: ['running', 'queued'].includes(value.status) ? 'uncertain' : value.status };
}
function cellDifferences(draft, dss) {
  const differences = [];
  if (draft.type !== dss.type) differences.push('cell type');
  if (draft.source !== dss.source) differences.push('source');
  if (Boolean(draft.collapsed) !== Boolean(dss.collapsed)) differences.push('collapsed state');
  const outputs = cell => cell.dssCell?.outputs || cell.output?.outputs || [];
  if (canonicalDocument(outputs(draft)) !== canonicalDocument(outputs(dss))) differences.push('outputs');
  // Older drafts did not record execution states; do not invent a comparison.
  if (draft.execution && dss.execution && canonicalDocument(comparableExecution(draft)) !== canonicalDocument(comparableExecution(dss))) differences.push('execution state');
  return differences;
}
export function compareCells(draftCells = [], dssCells = []) {
  const max = Math.max(draftCells.length, dssCells.length); const changes = [];
  for (let index = 0; index < max; index += 1) {
    const draft = draftCells[index]; const dss = dssCells[index];
    if (!draft) changes.push({ index, kind: 'added-in-dss', dss, summary: `Cell ${index + 1} exists only in DSS` });
    else if (!dss) changes.push({ index, kind: 'local-only', draft, summary: `Cell ${index + 1} exists only in the recovery draft` });
    else {
      const differences = cellDifferences(draft, dss);
      if (differences.length) changes.push({ index, kind: 'changed', differences, summary: `Cell ${index + 1} differs (${differences.join(', ')})`, draft, dss });
    }
  }
  return changes;
}
